const BASE_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "CI",
  "NO_COLOR",
]);

const SECRET_KEY_PATTERNS = [
  /^OPENAI_API_KEY$/i,
  /^CONTROL_PLANE_API_KEY$/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^SSH_AUTH_SOCK$/i,
  /^DATABASE_URL$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /_PASSWORD$/i,
];

export function isSecretEnvironmentKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function buildSafeEnvironment(
  source: NodeJS.ProcessEnv,
  configuredAllowlist: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE_ENV_KEYS, ...configuredAllowlist]);
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (isSecretEnvironmentKey(key)) continue;
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat|npm)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}
