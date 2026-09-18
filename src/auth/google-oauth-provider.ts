import { createHash, randomBytes } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface RedirectResponse {
  redirect(url: string): unknown;
}

interface PendingGoogleAuthorization {
  clientId: string;
  clientRedirectUri: string;
  clientState: string | undefined;
  codeChallenge: string;
  scopes: string[];
  resource: string | undefined;
  expiresAtMs: number;
}

interface AuthorizationGrant extends PendingGoogleAuthorization {
  email: string;
}

interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  email: string;
  resource: string | undefined;
  expiresAtSeconds: number;
}

interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  email: string;
  resource: string | undefined;
  expiresAtMs: number;
}

export interface GoogleOAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  callbackUrl: URL;
  whitelist: string[];
  staticClient?: OAuthClientInformationFull;
  fetchFn?: typeof fetch;
  now?: () => number;
}

function opaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function errorRedirect(
  redirectUri: string,
  state: string | undefined,
  error: string,
  description?: string,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (description) url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export class GoogleOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly skipLocalPkceValidation = false;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly callbackUrl: URL;
  private readonly whitelist: Set<string>;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pendingGoogleAuthorizations = new Map<string, PendingGoogleAuthorization>();
  private readonly authorizationCodes = new Map<string, AuthorizationGrant>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  constructor(options: GoogleOAuthProviderOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.callbackUrl = options.callbackUrl;
    this.whitelist = new Set(options.whitelist.map((email) => email.trim().toLowerCase()));
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    if (options.staticClient) {
      this.clients.set(options.staticClient.client_id, options.staticClient);
    }
    this.clientsStore = {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (client) => {
        const registered = client as OAuthClientInformationFull;
        if (!registered.client_id)
          throw new Error("OAuth client registration is missing client_id");
        if (this.clients.has(registered.client_id)) {
          throw new Error("OAuth client_id is already registered");
        }
        this.clients.set(registered.client_id, registered);
        return registered;
      },
    };
  }

  authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: RedirectResponse,
  ): Promise<void> {
    this.cleanupExpired();
    const state = opaqueToken("lh_state");
    this.pendingGoogleAuthorizations.set(state, {
      clientId: client.client_id,
      clientRedirectUri: params.redirectUri,
      clientState: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes?.length ? params.scopes : ["mcp"],
      resource: params.resource?.href,
      expiresAtMs: this.now() + AUTHORIZATION_TTL_MS,
    });

    const url = new URL(GOOGLE_AUTHORIZATION_URL);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl.toString());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
    res.redirect(url.toString());
    return Promise.resolve();
  }

  async completeGoogleAuthorization(params: URLSearchParams): Promise<string> {
    this.cleanupExpired();
    const state = params.get("state");
    if (!state) throw new Error("Google OAuth callback is missing state");
    const pending = this.pendingGoogleAuthorizations.get(state);
    if (!pending || pending.expiresAtMs <= this.now()) {
      this.pendingGoogleAuthorizations.delete(state);
      throw new Error("Google OAuth state is invalid or expired");
    }
    this.pendingGoogleAuthorizations.delete(state);

    if (params.has("error")) {
      return errorRedirect(
        pending.clientRedirectUri,
        pending.clientState,
        "access_denied",
        "Google authentication was not approved",
      );
    }

    const googleCode = params.get("code");
    if (!googleCode) throw new Error("Google OAuth callback is missing code");
    const googleAccessToken = await this.exchangeGoogleCode(googleCode);
    const email = await this.fetchGoogleEmail(googleAccessToken);
    if (!this.whitelist.has(email)) {
      return errorRedirect(
        pending.clientRedirectUri,
        pending.clientState,
        "access_denied",
        "Google account is not allowed",
      );
    }

    const authorizationCode = opaqueToken("lh_code");
    this.authorizationCodes.set(authorizationCode, {
      ...pending,
      email,
      expiresAtMs: this.now() + CODE_TTL_MS,
    });
    const redirect = new URL(pending.clientRedirectUri);
    redirect.searchParams.set("code", authorizationCode);
    if (pending.clientState) redirect.searchParams.set("state", pending.clientState);
    return redirect.toString();
  }

  challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.cleanupExpired();
    const grant = this.authorizationCodes.get(authorizationCode);
    if (!grant || grant.clientId !== client.client_id || grant.expiresAtMs <= this.now()) {
      throw new InvalidGrantError("Authorization code is invalid or expired");
    }
    return Promise.resolve(grant.codeChallenge);
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.cleanupExpired();
    const grant = this.authorizationCodes.get(authorizationCode);
    if (!grant || grant.clientId !== client.client_id || grant.expiresAtMs <= this.now()) {
      throw new InvalidGrantError("Authorization code is invalid or expired");
    }
    if (redirectUri !== undefined && redirectUri !== grant.clientRedirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource !== undefined && resource.href !== grant.resource) {
      throw new InvalidGrantError("resource does not match the authorization request");
    }
    this.authorizationCodes.delete(authorizationCode);
    return Promise.resolve(
      this.issueTokens(grant.clientId, grant.scopes, grant.email, grant.resource),
    );
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.cleanupExpired();
    const key = tokenKey(refreshToken);
    const record = this.refreshTokens.get(key);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs <= this.now()) {
      this.refreshTokens.delete(key);
      throw new InvalidGrantError("Refresh token is invalid or expired");
    }
    const requestedScopes = scopes ?? record.scopes;
    if (requestedScopes.some((scope) => !record.scopes.includes(scope))) {
      throw new InvalidScopeError("Refresh token cannot expand its original scopes");
    }
    if (resource !== undefined && resource.href !== record.resource) {
      throw new InvalidGrantError("resource does not match the refresh token");
    }

    this.refreshTokens.delete(key);
    return Promise.resolve(
      this.issueTokens(record.clientId, requestedScopes, record.email, record.resource),
    );
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    this.cleanupExpired();
    const record = this.accessTokens.get(tokenKey(token));
    if (!record || record.expiresAtSeconds <= Math.floor(this.now() / 1000)) {
      throw new InvalidTokenError("Access token is invalid or expired");
    }
    return Promise.resolve({
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAtSeconds,
      ...(record.resource === undefined ? {} : { resource: new URL(record.resource) }),
      extra: { email: record.email },
    });
  }

  revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const key = tokenKey(request.token);
    this.accessTokens.delete(key);
    this.refreshTokens.delete(key);
    return Promise.resolve();
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    email: string,
    resource: string | undefined,
  ): OAuthTokens {
    const accessToken = opaqueToken("lh_at");
    const refreshToken = opaqueToken("lh_rt");
    const nowMs = this.now();
    this.accessTokens.set(tokenKey(accessToken), {
      clientId,
      scopes: [...scopes],
      email,
      resource,
      expiresAtSeconds: Math.floor(nowMs / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    });
    this.refreshTokens.set(tokenKey(refreshToken), {
      clientId,
      scopes: [...scopes],
      email,
      resource,
      expiresAtMs: nowMs + REFRESH_TOKEN_TTL_MS,
    });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }),
    };
  }

  private async exchangeGoogleCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.callbackUrl.toString(),
    });
    const response = await this.fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Google token exchange failed with status ${response.status}`);
    }
    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("access_token" in data) ||
      typeof data.access_token !== "string"
    ) {
      throw new Error("Google token response did not contain an access token");
    }
    return data.access_token;
  }

  private async fetchGoogleEmail(accessToken: string): Promise<string> {
    const response = await this.fetchFn(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Google userinfo request failed with status ${response.status}`);
    }
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null) {
      throw new Error("Google userinfo response is invalid");
    }
    const email = "email" in data && typeof data.email === "string" ? data.email.toLowerCase() : "";
    const emailVerified = "email_verified" in data && data.email_verified === true;
    if (!email || !emailVerified) throw new Error("Google account does not have a verified email");
    return email;
  }

  private cleanupExpired(): void {
    const nowMs = this.now();
    for (const [key, value] of this.pendingGoogleAuthorizations) {
      if (value.expiresAtMs <= nowMs) this.pendingGoogleAuthorizations.delete(key);
    }
    for (const [key, value] of this.authorizationCodes) {
      if (value.expiresAtMs <= nowMs) this.authorizationCodes.delete(key);
    }
    for (const [key, value] of this.accessTokens) {
      if (value.expiresAtSeconds <= Math.floor(nowMs / 1000)) this.accessTokens.delete(key);
    }
    for (const [key, value] of this.refreshTokens) {
      if (value.expiresAtMs <= nowMs) this.refreshTokens.delete(key);
    }
  }
}
