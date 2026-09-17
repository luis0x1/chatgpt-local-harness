const PROTECTED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".svelte-kit",
  "target",
]);

const PROTECTED_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "auth.json",
  "credential",
  "credentials",
  "credential.json",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
]);

const PROTECTED_FILE_SUFFIXES = [".pem", ".p12", ".pfx", ".key"];

export const READABLE_SENSITIVE_PATH_EXCEPTIONS = new Set([".env.example"]);

export interface SensitivePathOptions {
  allowEnvExample?: boolean;
}

function components(value: string): string[] {
  return value.split(/[\\/]+/u).filter((component) => component !== "" && component !== ".");
}

function isProtectedComponent(
  component: string,
  terminal: boolean,
  options: SensitivePathOptions,
): boolean {
  const normalized = component.toLowerCase();
  if (
    terminal &&
    options.allowEnvExample === true &&
    READABLE_SENSITIVE_PATH_EXCEPTIONS.has(normalized)
  )
    return false;
  return (
    PROTECTED_DIRECTORY_NAMES.has(normalized) ||
    PROTECTED_FILE_NAMES.has(normalized) ||
    normalized.startsWith(".env.") ||
    PROTECTED_FILE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

export function isSensitivePath(value: string, options: SensitivePathOptions = {}): boolean {
  const pathComponents = components(value);
  return pathComponents.some((component, index) =>
    isProtectedComponent(component, index === pathComponents.length - 1, options),
  );
}

export function assertReadablePath(value: string, options: SensitivePathOptions = {}): void {
  if (isSensitivePath(value, options)) {
    throw new Error("Sensitive or ignored files cannot be read");
  }
}
