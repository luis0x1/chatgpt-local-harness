import path from "node:path";
import process from "node:process";

export class CommandPolicyError extends Error {
  override name = "CommandPolicyError";
}

const DEFAULT_EXECUTABLES = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "git",
  "rg",
  "cargo",
  "rustc",
  "go",
  "python",
  "python3",
  "java",
  "javac",
  "dotnet",
]);

const BLOCKED_COMMON: Array<[RegExp, string]> = [
  [/(^|[;&|]\s*)\s*(sudo|su|runas)(\s|$)/i, "Privilege escalation is not allowed"],
  [/(^|[;&|]\s*)\s*(shutdown|reboot|format)(\s|$)/i, "System control commands are not allowed"],
  [/\bgit\s+reset\s+--hard\b/i, "Git history/worktree destruction is not allowed"],
  [/\bgit\s+clean\s+[^\n]*(?:-fdx|-fxd|-fd|-df)\b/i, "Destructive git clean is not allowed"],
  [/\bgit\s+push\s+[^\n]*(?:--force(?:-with-lease)?|-f\b)/i, "Force push is not allowed"],
  [
    /\bgit\s+push\s+[^\n]*(?:--delete|:\s*refs\/(?:heads|tags)\/)/i,
    "Remote branch/tag deletion is not allowed",
  ],
  [/\b(?:npm|pnpm|yarn|cargo)\s+publish\b/i, "Package publishing is not allowed"],
  [/\b(?:Start-Process|Start-Job)\b/i, "Detached/background PowerShell processes are not allowed"],
  [
    /(?:id_rsa|id_ed25519|\.ssh[\\/]|credential(?:s)?(?:\.json)?|keychain)/i,
    "Credential-store or private-key access is not allowed",
  ],
  [/(?:\.\.[\\/])+[^\s]*\.env(?:\b|$)/i, "Reading .env outside the workspace is not allowed"],
];

const BROAD_UNIX_DELETE =
  /\brm\s+[^\n]*(?:-[A-Za-z]*r[A-Za-z]*f|-+[A-Za-z]*f[A-Za-z]*r)[^\n]*\s+(?:\/|~|\$HOME|\.|\.\.|\*)\s*(?:$|[;&|])/i;
const BROAD_POWERSHELL_DELETE =
  /\bRemove-Item\b(?=[^\n]*-Recurse(?:\s|$))[^\n]*(?:[A-Za-z]:\\(?:\s|$)|\\\\|~(?:\s|$)|\$HOME(?:\s|$)|\s\.\.?(?:\s|$)|\*)/i;

function executableName(executable: string): string {
  return path
    .basename(executable)
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();
}

export class CommandPolicy {
  private readonly allowedExecutables: Set<string>;
  private readonly allowedAbsoluteExecutables = new Set<string>([path.resolve(process.execPath)]);

  constructor(additionalExecutables: readonly string[] = []) {
    this.allowedExecutables = new Set(DEFAULT_EXECUTABLES);
    for (const executable of additionalExecutables) {
      if (!executable.trim()) continue;
      if (path.isAbsolute(executable.trim())) {
        this.allowedAbsoluteExecutables.add(path.resolve(executable.trim()));
      } else {
        this.allowedExecutables.add(executableName(executable.trim()));
      }
    }
  }

  assertCommand(executable: string, args: readonly string[]): void {
    if (!executable.trim() || executable.includes("\0")) {
      throw new CommandPolicyError("Executable is invalid");
    }
    if (
      path.isAbsolute(executable) &&
      !this.allowedAbsoluteExecutables.has(path.resolve(executable))
    ) {
      throw new CommandPolicyError(
        "Absolute executable paths must be explicitly allowlisted (except the current Node runtime)",
      );
    }
    if (!path.isAbsolute(executable) && !this.allowedExecutables.has(executableName(executable))) {
      throw new CommandPolicyError(`Executable is not allowlisted: ${executableName(executable)}`);
    }
    if (args.some((arg) => arg.includes("\0"))) {
      throw new CommandPolicyError("Arguments cannot contain NUL bytes");
    }
    this.assertText([executable, ...args].join(" "));
  }

  assertShell(command: string): void {
    if (!command.trim() || command.includes("\0")) {
      throw new CommandPolicyError("Shell command is empty or invalid");
    }
    this.assertText(command);
    if (BROAD_UNIX_DELETE.test(command) || BROAD_POWERSHELL_DELETE.test(command)) {
      throw new CommandPolicyError("Broad recursive deletion is not allowed");
    }
  }

  private assertText(command: string): void {
    for (const [pattern, reason] of BLOCKED_COMMON) {
      if (pattern.test(command)) throw new CommandPolicyError(reason);
    }
  }
}
