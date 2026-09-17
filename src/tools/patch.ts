import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import { buildSafeEnvironment } from "../security/environment-policy.js";
import type { PathPolicy } from "../security/path-policy.js";
import type { ProcessManager } from "../security/process-manager.js";

function parseHeaderPath(value: string): string | undefined {
  const raw = value.split("\t", 1)[0]?.trim();
  if (raw === undefined || raw === "/dev/null") return undefined;
  if (raw.startsWith('"') || raw.includes("\\")) {
    throw new Error("Quoted or escaped patch paths are not supported");
  }
  if (!raw.startsWith("a/") && !raw.startsWith("b/")) {
    throw new Error("Patch paths must use a/ and b/ prefixes");
  }
  return raw.slice(2);
}

export function extractPatchPaths(patch: string): string[] {
  if (!patch.startsWith("diff --git ") || !patch.includes("\n@@ ")) {
    throw new Error("apply_patch accepts only a non-empty unified git diff");
  }
  if (/^(?:new|old) file mode 120000$/m.test(patch)) {
    throw new Error("Creating or modifying symlinks through patches is not allowed");
  }
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const parsed = parseHeaderPath(line.slice(4));
      if (parsed !== undefined) paths.add(parsed);
    }
  }
  if (paths.size === 0) throw new Error("Patch does not contain any file paths");
  return [...paths];
}

async function fingerprint(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "<missing>";
    throw error;
  }
}

export class PatchTool {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly processes: ProcessManager,
    private readonly config: AppConfig,
  ) {}

  async apply(workspace: string, patch: string): Promise<{ files: string[] }> {
    const previous = this.locks.get(workspace) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(workspace, tail);
    await previous;
    try {
      return await this.applyLocked(workspace, patch);
    } finally {
      release();
      if (this.locks.get(workspace) === tail) this.locks.delete(workspace);
    }
  }

  private async applyLocked(workspace: string, patch: string): Promise<{ files: string[] }> {
    const files = extractPatchPaths(patch);
    const resolved = new Map<string, string>();
    const before = new Map<string, string>();
    for (const file of files) {
      const absolute = await this.pathPolicy.resolveForWrite(workspace, file);
      resolved.set(file, absolute);
      before.set(file, await fingerprint(absolute));
    }

    const environment = buildSafeEnvironment(process.env, this.config.environmentAllowlist);
    const common = {
      executable: "git",
      cwd: workspace,
      env: environment,
      timeoutMs: Math.min(this.config.defaultTimeoutMs, 30_000),
      maxOutputBytes: this.config.maxOutputBytes,
      stdin: patch,
    } as const;
    const checked = await this.processes.run({
      ...common,
      args: ["apply", "--check", "--recount", "-"],
    });
    if (checked.exitCode !== 0)
      throw new Error(`Patch check failed: ${checked.stderr || checked.stdout}`);

    for (const [file, absolute] of resolved) {
      if ((await fingerprint(absolute)) !== before.get(file)) {
        throw new Error(`File changed after patch validation: ${file}`);
      }
    }

    const applied = await this.processes.run({ ...common, args: ["apply", "--recount", "-"] });
    if (applied.exitCode !== 0)
      throw new Error(`Patch failed: ${applied.stderr || applied.stdout}`);
    return { files };
  }
}
