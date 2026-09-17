import process from "node:process";
import type { AppConfig } from "../config.js";
import { clampTimeout } from "../config.js";
import type { AuditLog } from "../security/audit-log.js";
import type { CommandPolicy } from "../security/command-policy.js";
import { buildSafeEnvironment } from "../security/environment-policy.js";
import type { PathPolicy } from "../security/path-policy.js";
import type { ProcessManager, ProcessResult } from "../security/process-manager.js";

export interface CommandExecInput {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export class CommandExecutor {
  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly commandPolicy: CommandPolicy,
    private readonly processes: ProcessManager,
    private readonly audit: AuditLog,
    private readonly config: AppConfig,
  ) {}

  async run(workspace: string, input: CommandExecInput): Promise<ProcessResult> {
    this.commandPolicy.assertCommand(input.executable, input.args);
    const cwd = await this.pathPolicy.resolveCwd(workspace, input.cwd ?? ".");
    const result = await this.processes.run({
      executable: input.executable,
      args: input.args,
      cwd,
      env: buildSafeEnvironment(process.env, this.config.environmentAllowlist),
      timeoutMs: clampTimeout(input.timeoutMs, this.config),
      maxOutputBytes: this.config.maxOutputBytes,
      shell: false,
    });
    await this.audit.write({
      tool: "command_exec",
      workspace,
      command: JSON.stringify([input.executable, ...input.args]),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
    });
    return result;
  }
}
