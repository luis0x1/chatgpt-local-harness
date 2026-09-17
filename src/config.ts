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
    allowUnc: env.LOCAL_HARNESS_ALLOW_UNC?.toLowerCase() === "true",
  };
}

export function clampTimeout(requested: number | undefined, config: AppConfig): number {
  const value = requested ?? config.defaultTimeoutMs;
  if (!Number.isSafeInteger(value) || value < 1 || value > config.maxTimeoutMs) {
    throw new Error(`timeoutMs must be between 1 and ${config.maxTimeoutMs}`);
  }
  return value;
}
