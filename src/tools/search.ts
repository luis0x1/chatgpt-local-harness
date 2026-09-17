import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { buildSafeEnvironment } from "../security/environment-policy.js";
import type { PathPolicy } from "../security/path-policy.js";
import type { ProcessManager } from "../security/process-manager.js";
import type { FileTools } from "./files.js";

export interface SearchResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  engine: "rg" | "fallback";
}

export class SearchTool {
  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly fileTools: FileTools,
    private readonly processes: ProcessManager,
    private readonly config: AppConfig,
  ) {}

  async search(
    workspace: string,
    query: string,
    relativeCwd: string,
    glob?: string,
  ): Promise<SearchResult> {
    const cwd = await this.pathPolicy.resolveCwd(workspace, relativeCwd);
    const args = [
      "--line-number",
      "--color",
      "never",
      "--hidden",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.env",
      "--glob",
      "!.env.*",
      "--glob",
      "!**/*.{pem,key,p12,pfx}",
      "--glob",
      "!**/{id_rsa,id_ed25519,credentials.json}",
    ];
    if (glob !== undefined) args.push("--glob", glob);
    args.push("--", query, ".");
    const result = await this.processes.run({
      executable: "rg",
      args,
      cwd,
      env: buildSafeEnvironment(process.env, this.config.environmentAllowlist),
      timeoutMs: Math.min(this.config.defaultTimeoutMs, 30_000),
      maxOutputBytes: this.config.maxOutputBytes,
    });
    if (!result.stderr.includes("ENOENT") && !result.stderr.includes("not found")) {
      return { ...result, engine: "rg" };
    }

    const listed = await this.fileTools.list(
      workspace,
      path.relative(workspace, cwd) || ".",
      12,
      10_000,
    );
    const matches: string[] = [];
    let used = 0;
    let truncated = listed.truncated;
    for (const entry of listed.entries) {
      if (
        entry.type !== "file" ||
        entry.size === undefined ||
        entry.size > this.config.maxFileBytes
      )
        continue;
      const content = await readFile(path.join(workspace, entry.path), "utf8").catch(() => "");
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (!line.includes(query)) continue;
        const rendered = `${entry.path}:${index + 1}:${line}\n`;
        if (used + Buffer.byteLength(rendered) > this.config.maxOutputBytes) {
          truncated = true;
          break;
        }
        used += Buffer.byteLength(rendered);
        matches.push(rendered);
      }
      if (truncated) break;
    }
    return {
      stdout: matches.join(""),
      stderr: "",
      exitCode: matches.length ? 0 : 1,
      truncated,
      engine: "fallback",
    };
  }
}
