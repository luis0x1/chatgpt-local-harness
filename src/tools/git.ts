import type { AppConfig } from "../config.js";
import { buildSafeEnvironment } from "../security/environment-policy.js";
import type { PathPolicy } from "../security/path-policy.js";
import type { ProcessManager } from "../security/process-manager.js";

export class GitTools {
  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly processes: ProcessManager,
    private readonly config: AppConfig,
  ) {}

  async status(
    workspace: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; truncated: boolean }> {
    return this.run(workspace, ["status", "--short", "--branch", "--untracked-files=all"]);
  }

  async diff(
    workspace: string,
    staged: boolean,
    relativePath?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; truncated: boolean }> {
    if (relativePath !== undefined) {
      await this.pathPolicy.resolveForWrite(workspace, relativePath);
    }
    const args = ["diff", "--no-ext-diff", "--no-color"];
    if (staged) args.push("--cached");
    if (relativePath !== undefined) args.push("--", relativePath);
    return this.run(workspace, args);
  }

  private async run(workspace: string, args: string[]) {
    const result = await this.processes.run({
      executable: "git",
      args,
      cwd: workspace,
      env: buildSafeEnvironment(process.env, this.config.environmentAllowlist),
      timeoutMs: Math.min(this.config.defaultTimeoutMs, 30_000),
      maxOutputBytes: this.config.maxOutputBytes,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.truncated,
    };
  }
}
