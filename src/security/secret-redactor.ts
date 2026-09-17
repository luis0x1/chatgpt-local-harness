const PRIVATE_KEY_PATTERN =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi;

const QUOTED_SECRET_PATTERN =
  /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)["']?\s*[:=]\s*))(["'])([^\r\n]*?)\2/gi;
const UNQUOTED_SECRET_PATTERN =
  /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)["']?\s*[:=]\s*))([^\r\n,;}\]]+)/gi;

const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

export function redactSecrets(value: string): string {
  let redacted = value.replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]");
  redacted = redacted.replace(QUOTED_SECRET_PATTERN, "$1$2[REDACTED]$2");
  redacted = redacted.replace(UNQUOTED_SECRET_PATTERN, "$1[REDACTED]");
  redacted = redacted.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/(https?:\/\/[^:\s/]+:)[^@\s/]+@/gi, "$1[REDACTED]@");
  for (const pattern of TOKEN_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}
