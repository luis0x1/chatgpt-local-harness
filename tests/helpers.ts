import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";

export function testConfig(root: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    workspaceRoots: [root],
    memoryRoot: undefined,
    allowedCommands: [],
    environmentAllowlist: [],
    defaultTimeoutMs: 2_000,
    maxTimeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    maxFileBytes: 64 * 1024,
    auditLogPath: path.join(os.tmpdir(), `local-harness-test-${process.pid}.jsonl`),
    allowUnc: false,
    authEnabled: false,
    authWhitelist: [],
    googleClientId: undefined,
    googleClientSecret: undefined,
    oauthClientId: undefined,
    oauthClientSecret: undefined,
    oauthRedirectUris: [],
    authBaseUrl: undefined,
    httpHost: "127.0.0.1",
    httpPort: 3000,
    ...overrides,
  };
}
