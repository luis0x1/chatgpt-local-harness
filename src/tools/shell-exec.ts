import process from "node:process";
import type { AppConfig } from "../config.js";
import { clampTimeout } from "../config.js";
import type { AuditLog } from "../security/audit-log.js";
import type { CommandPolicy } from "../security/command-policy.js";
import { buildSafeEnvironment } from "../security/environment-policy.js";
import type { PathPolicy } from "../security/path-policy.js";
import type { ProcessManager, ProcessResult } from "../security/process-manager.js";

export interface ShellExecInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export class ShellExecutor {
  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly commandPolicy: CommandPolicy,
    private readonly processes: ProcessManager,
    private readonly audit: AuditLog,
    private readonly config: AppConfig,
  ) {}

  async run(workspace: string, input: ShellExecInput): Promise<ProcessResult> {
    this.commandPolicy.assertShell(input.command);
    const cwd = await this.pathPolicy.resolveCwd(workspace, input.cwd ?? ".");
    const windows = process.platform === "win32";
    const result = await this.processes.run({
      executable: windows ? "powershell.exe" : "/bin/sh",
      args: windows
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command]
        : ["-c", input.command],
      cwd,
      env: buildSafeEnvironment(process.env, this.config.environmentAllowlist),
      timeoutMs: clampTimeout(input.timeoutMs, this.config),
      maxOutputBytes: this.config.maxOutputBytes,
      shell: false,
    });
    await this.audit.write({
      tool: "shell_exec",
      workspace,
      command: input.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
    });
    return result;
  }
}
