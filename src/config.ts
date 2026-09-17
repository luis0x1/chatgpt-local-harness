import os from "node:os";
import path from "node:path";

export interface AppConfig {
  workspaceRoots: string[];
  memoryRoot: string | undefined;
  allowedCommands: string[];
  environmentAllowlist: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  auditLogPath: string;
  allowUnc: boolean;
  authEnabled: boolean;
  authWhitelist: string[];
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  oauthClientId: string | undefined;
  oauthClientSecret: string | undefined;
  oauthRedirectUris: string[];
  authBaseUrl: URL | undefined;
  httpHost: string;
  httpPort: number;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function urls(value: string | undefined, key: string): string[] {
  return csv(value).map((item) => {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`${key} must contain valid absolute URLs`);
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`${key} must contain only http or https URLs`);
    }
    if (url.username || url.password) {
      throw new Error(`${key} must not contain credentials`);
    }
    return item;
  });
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  throw new Error(`${key} must be true or false`);
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}

function parseAuthBaseUrl(raw: string | undefined): URL | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("LOCAL_HARNESS_AUTH_BASE_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("LOCAL_HARNESS_AUTH_BASE_URL must not contain credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (url.pathname !== "/") {
    throw new Error("LOCAL_HARNESS_AUTH_BASE_URL must be an origin without a path");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("LOCAL_HARNESS_AUTH_BASE_URL must use https outside loopback");
  }
  return url;
}

export function parseWorkspaceRoots(raw: string | undefined): string[] {
  if (raw === undefined || !raw.trim()) {
    throw new Error("LOCAL_HARNESS_ROOTS is required; no workspace root is assumed by default");
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((value) => typeof value === "string" && value.trim())
    ) {
      throw new Error("must be a non-empty JSON string array");
    }
    return parsed as string[];
  } catch (error) {
    if (raw.trim().startsWith("[")) throw error;
    return raw
      .split(path.delimiter)
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const maxTimeoutMs = positiveInteger(env, "LOCAL_HARNESS_MAX_TIMEOUT_MS", 300_000);
  const defaultTimeoutMs = positiveInteger(env, "LOCAL_HARNESS_DEFAULT_TIMEOUT_MS", 120_000);
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new Error("LOCAL_HARNESS_DEFAULT_TIMEOUT_MS cannot exceed LOCAL_HARNESS_MAX_TIMEOUT_MS");
  }
  const authEnabled = boolean(env, "LOCAL_HARNESS_AUTH_ENABLED");
  const authWhitelist = csv(env.LOCAL_HARNESS_AUTH_WHITELIST).map((email) => email.toLowerCase());
  const googleClientId = env.LOCAL_HARNESS_GOOGLE_CLIENT_ID?.trim() || undefined;
  const googleClientSecret = env.LOCAL_HARNESS_GOOGLE_CLIENT_SECRET?.trim() || undefined;
  const oauthClientId = env.LOCAL_HARNESS_OAUTH_CLIENT_ID?.trim() || undefined;
  const oauthClientSecret = env.LOCAL_HARNESS_OAUTH_CLIENT_SECRET?.trim() || undefined;
  const oauthRedirectUris = urls(
    env.LOCAL_HARNESS_OAUTH_REDIRECT_URIS,
    "LOCAL_HARNESS_OAUTH_REDIRECT_URIS",
  );
  const configuredAuthBaseUrl = parseAuthBaseUrl(env.LOCAL_HARNESS_AUTH_BASE_URL);
  const httpHost = env.LOCAL_HARNESS_HTTP_HOST?.trim() || "127.0.0.1";
  const httpPort = positiveInteger(env, "LOCAL_HARNESS_HTTP_PORT", 3000);
  if (httpPort > 65_535) throw new Error("LOCAL_HARNESS_HTTP_PORT must be at most 65535");
  if (authEnabled && !configuredAuthBaseUrl && !isLoopbackHost(httpHost)) {
    throw new Error(
      "LOCAL_HARNESS_AUTH_BASE_URL is required when authentication binds outside loopback",
    );
  }

  if (authEnabled) {
    if (authWhitelist.length === 0) {
      throw new Error("LOCAL_HARNESS_AUTH_WHITELIST is required when authentication is enabled");
    }
    if (!googleClientId) {
      throw new Error("LOCAL_HARNESS_GOOGLE_CLIENT_ID is required when authentication is enabled");
    }
    if (!googleClientSecret) {
      throw new Error(
        "LOCAL_HARNESS_GOOGLE_CLIENT_SECRET is required when authentication is enabled",
      );
    }
  }
  if (!oauthClientId && oauthClientSecret) {
    throw new Error("LOCAL_HARNESS_OAUTH_CLIENT_ID is required when OAuth client secret is set");
  }
  if (!oauthClientId && oauthRedirectUris.length > 0) {
    throw new Error("LOCAL_HARNESS_OAUTH_CLIENT_ID is required when OAuth redirect URIs are set");
  }
  if (oauthClientId && oauthRedirectUris.length === 0) {
    throw new Error(
      "LOCAL_HARNESS_OAUTH_REDIRECT_URIS is required when LOCAL_HARNESS_OAUTH_CLIENT_ID is set",
    );
  }

  return {
    workspaceRoots: parseWorkspaceRoots(env.LOCAL_HARNESS_ROOTS),
    memoryRoot: env.LOCAL_HARNESS_MEMORY_ROOT?.trim() || undefined,
    allowedCommands: csv(env.LOCAL_HARNESS_ALLOWED_COMMANDS),
    environmentAllowlist: csv(env.LOCAL_HARNESS_ENV_ALLOWLIST),
    defaultTimeoutMs,
    maxTimeoutMs,
    maxOutputBytes: positiveInteger(env, "LOCAL_HARNESS_MAX_OUTPUT_BYTES", 1_048_576),
    maxFileBytes: positiveInteger(env, "LOCAL_HARNESS_MAX_FILE_BYTES", 1_048_576),
    auditLogPath:
      env.LOCAL_HARNESS_AUDIT_LOG?.trim() ||
      path.join(os.tmpdir(), "local-coding-harness-audit.jsonl"),
    allowUnc: boolean(env, "LOCAL_HARNESS_ALLOW_UNC"),
    authEnabled,
    authWhitelist,
    googleClientId,
    googleClientSecret,
    oauthClientId,
    oauthClientSecret,
    oauthRedirectUris,
    authBaseUrl:
      configuredAuthBaseUrl ?? (authEnabled ? new URL(`http://127.0.0.1:${httpPort}`) : undefined),
    httpHost,
    httpPort,
  };
}

export function clampTimeout(requested: number | undefined, config: AppConfig): number {
  const value = requested ?? config.defaultTimeoutMs;
  if (!Number.isSafeInteger(value) || value < 1 || value > config.maxTimeoutMs) {
    throw new Error(`timeoutMs must be between 1 and ${config.maxTimeoutMs}`);
  }
  return value;
}
