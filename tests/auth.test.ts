import { describe, expect, it } from "vitest";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GoogleOAuthProvider } from "../src/auth/google-oauth-provider.js";
import { loadConfig } from "../src/config.js";

const client: OAuthClientInformationFull = {
  client_id: "test-client",
  client_id_issued_at: 1,
  redirect_uris: ["http://client.example/callback"],
  token_endpoint_auth_method: "none",
};

function googleFetch(email: string): typeof fetch {
  return (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === "https://oauth2.googleapis.com/token") {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "google-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Promise.resolve(
        new Response(JSON.stringify({ email, email_verified: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };
}

async function beginAuthorization(provider: GoogleOAuthProvider): Promise<URL> {
  let redirect = "";
  await provider.authorize(
    client,
    {
      state: "client-state",
      scopes: ["mcp"],
      codeChallenge: "pkce-challenge",
      redirectUri: "http://client.example/callback",
    },
    { redirect: (url) => (redirect = url) },
  );
  return new URL(redirect);
}

describe("GoogleOAuthProvider", () => {
  it("approves a whitelisted verified Google email and issues harness access/refresh tokens", async () => {
    const provider = new GoogleOAuthProvider({
      clientId: "google-client",
      clientSecret: "google-secret",
      callbackUrl: new URL("http://127.0.0.1:3000/oauth/google/callback"),
      whitelist: ["allowed@example.com"],
      fetchFn: googleFetch("Allowed@Example.com"),
    });

    const googleRedirect = await beginAuthorization(provider);
    expect(googleRedirect.hostname).toBe("accounts.google.com");
    expect(googleRedirect.searchParams.get("client_id")).toBe("google-client");
    expect(googleRedirect.searchParams.get("scope")).toContain("email");
    const state = googleRedirect.searchParams.get("state");
    expect(state).toBeTruthy();

    const clientRedirect = new URL(
      await provider.completeGoogleAuthorization(
        new URLSearchParams({ state: state!, code: "google-code" }),
      ),
    );
    expect(clientRedirect.origin + clientRedirect.pathname).toBe("http://client.example/callback");
    expect(clientRedirect.searchParams.get("state")).toBe("client-state");
    const authorizationCode = clientRedirect.searchParams.get("code");
    expect(authorizationCode).toBeTruthy();
    await expect(provider.challengeForAuthorizationCode(client, authorizationCode!)).resolves.toBe(
      "pkce-challenge",
    );

    const tokens = await provider.exchangeAuthorizationCode(
      client,
      authorizationCode!,
      "verifier",
      "http://client.example/callback",
    );
    expect(tokens.access_token).toMatch(/^lh_at_/);
    expect(tokens.refresh_token).toMatch(/^lh_rt_/);
    expect(tokens.scope).toBe("mcp");

    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.scopes).toEqual(["mcp"]);
    expect(authInfo.extra?.email).toBe("allowed@example.com");

    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
  });

  it("denies a Google account outside the whitelist", async () => {
    const provider = new GoogleOAuthProvider({
      clientId: "google-client",
      clientSecret: "google-secret",
      callbackUrl: new URL("http://127.0.0.1:3000/oauth/google/callback"),
      whitelist: ["allowed@example.com"],
      fetchFn: googleFetch("other@example.com"),
    });
    const googleRedirect = await beginAuthorization(provider);
    const state = googleRedirect.searchParams.get("state")!;
    const redirect = new URL(
      await provider.completeGoogleAuthorization(
        new URLSearchParams({ state, code: "google-code" }),
      ),
    );
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.has("code")).toBe(false);
  });

  it("pre-registers a configured user-defined OAuth client", async () => {
    const provider = new GoogleOAuthProvider({
      clientId: "google-client",
      clientSecret: "google-secret",
      callbackUrl: new URL("http://127.0.0.1:3000/oauth/google/callback"),
      whitelist: ["allowed@example.com"],
      staticClient: {
        client_id: "chatgpt-client",
        client_secret: "chatgpt-secret",
        client_id_issued_at: 1,
        redirect_uris: ["https://chatgpt.com/connector/oauth/test-id"],
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    });

    expect(await provider.clientsStore.getClient("chatgpt-client")).toMatchObject({
      client_id: "chatgpt-client",
      client_secret: "chatgpt-secret",
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(await provider.clientsStore.getClient("missing-client")).toBeUndefined();
  });
});

describe("authentication configuration", () => {
  const baseEnv = { LOCAL_HARNESS_ROOTS: '["/tmp/project"]' };

  it("keeps authentication disabled by default", () => {
    const config = loadConfig(baseEnv);
    expect(config.authEnabled).toBe(false);
    expect(config.authBaseUrl).toBeUndefined();
  });

  it("keeps code-review-graph disabled by default", () => {
    const config = loadConfig(baseEnv);
    expect(config.codeGraphEnabled).toBe(false);
    expect(config.codeGraphCommand).toBe("code-review-graph");
  });

  it("loads code-review-graph without a fixed repository", () => {
    const config = loadConfig({
      ...baseEnv,
      LOCAL_HARNESS_CODE_GRAPH_ENABLED: "true",
    });
    expect(config.codeGraphEnabled).toBe(true);
    expect(config.codeGraphCommand).toBe("code-review-graph");
  });

  it("requires Google credentials and an email whitelist when enabled", () => {
    expect(() => loadConfig({ ...baseEnv, LOCAL_HARNESS_AUTH_ENABLED: "true" })).toThrow(
      "LOCAL_HARNESS_AUTH_WHITELIST",
    );
  });

  it("loads and normalizes enabled authentication settings", () => {
    const config = loadConfig({
      ...baseEnv,
      LOCAL_HARNESS_AUTH_ENABLED: "true",
      LOCAL_HARNESS_AUTH_WHITELIST: "One@Example.com, two@example.com",
      LOCAL_HARNESS_GOOGLE_CLIENT_ID: "client-id",
      LOCAL_HARNESS_GOOGLE_CLIENT_SECRET: "client-secret",
      LOCAL_HARNESS_AUTH_BASE_URL: "https://harness.example/",
      LOCAL_HARNESS_HTTP_HOST: "0.0.0.0",
      LOCAL_HARNESS_HTTP_PORT: "8080",
    });
    expect(config.authEnabled).toBe(true);
    expect(config.authWhitelist).toEqual(["one@example.com", "two@example.com"]);
    expect(config.authBaseUrl?.toString()).toBe("https://harness.example/");
    expect(config.httpHost).toBe("0.0.0.0");
    expect(config.httpPort).toBe(8080);
  });

  it("loads a configured user-defined OAuth client", () => {
    const config = loadConfig({
      ...baseEnv,
      LOCAL_HARNESS_AUTH_ENABLED: "true",
      LOCAL_HARNESS_AUTH_WHITELIST: "one@example.com",
      LOCAL_HARNESS_GOOGLE_CLIENT_ID: "google-client",
      LOCAL_HARNESS_GOOGLE_CLIENT_SECRET: "google-secret",
      LOCAL_HARNESS_OAUTH_CLIENT_ID: "chatgpt-client",
      LOCAL_HARNESS_OAUTH_CLIENT_SECRET: "chatgpt-secret",
      LOCAL_HARNESS_OAUTH_REDIRECT_URIS: "https://chatgpt.com/connector/oauth/test-id",
    });
    expect(config.oauthClientId).toBe("chatgpt-client");
    expect(config.oauthClientSecret).toBe("chatgpt-secret");
    expect(config.oauthRedirectUris).toEqual(["https://chatgpt.com/connector/oauth/test-id"]);
  });

  it("requires redirect URIs for a configured user-defined OAuth client", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        LOCAL_HARNESS_AUTH_ENABLED: "true",
        LOCAL_HARNESS_AUTH_WHITELIST: "one@example.com",
        LOCAL_HARNESS_GOOGLE_CLIENT_ID: "google-client",
        LOCAL_HARNESS_GOOGLE_CLIENT_SECRET: "google-secret",
        LOCAL_HARNESS_OAUTH_CLIENT_ID: "chatgpt-client",
      }),
    ).toThrow("LOCAL_HARNESS_OAUTH_REDIRECT_URIS is required");
  });

  it("rejects plaintext OAuth base URLs outside loopback", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        LOCAL_HARNESS_AUTH_ENABLED: "true",
        LOCAL_HARNESS_AUTH_WHITELIST: "one@example.com",
        LOCAL_HARNESS_GOOGLE_CLIENT_ID: "client-id",
        LOCAL_HARNESS_GOOGLE_CLIENT_SECRET: "client-secret",
        LOCAL_HARNESS_AUTH_BASE_URL: "http://harness.example",
      }),
    ).toThrow("must use https outside loopback");
  });

  it("requires an explicit public base URL when binding outside loopback", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        LOCAL_HARNESS_AUTH_ENABLED: "true",
        LOCAL_HARNESS_AUTH_WHITELIST: "one@example.com",
        LOCAL_HARNESS_GOOGLE_CLIENT_ID: "client-id",
        LOCAL_HARNESS_GOOGLE_CLIENT_SECRET: "client-secret",
        LOCAL_HARNESS_HTTP_HOST: "0.0.0.0",
      }),
    ).toThrow("LOCAL_HARNESS_AUTH_BASE_URL is required");
  });
});
