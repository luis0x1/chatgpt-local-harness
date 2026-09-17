import path from "node:path";
import { Minimatch } from "minimatch";
import type { AppConfig } from "../config.js";
import { buildSafeEnvironment } from "../security/environment-policy.js";
import { OutputLimiter } from "../security/output-limiter.js";
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

interface SearchCandidate {
  workspacePath: string;
  searchPath: string;
}

type ProcessRunner = Pick<ProcessManager, "run">;

const MAX_SEARCH_FILES = 10_000;
const MAX_SEARCH_DEPTH = 12;
const MAX_BATCH_FILES = 256;
const MAX_BATCH_PATH_BYTES = 64 * 1024;

function normalizeSearchPath(value: string): string {
  return value.split(path.sep).join("/");
}

function compileGlob(glob: string | undefined): Minimatch | undefined {
  if (glob === undefined) return undefined;
  if (glob.length === 0 || glob.length > 1_024 || glob.includes("\0") || /[\r\n]/u.test(glob)) {
    throw new Error("glob must be 1-1024 characters on one line without NUL bytes");
  }

  const normalized = glob.replaceAll("\\", "/");
  const positivePattern = normalized.replace(/^!+/u, "");
  if (
    positivePattern.length === 0 ||
    path.posix.isAbsolute(positivePattern) ||
    path.win32.isAbsolute(positivePattern) ||
    /(^|[/{,])\.\.(?=$|[/},])/u.test(positivePattern)
  ) {
    throw new Error("glob must be a relative pattern that does not traverse parent directories");
  }

  try {
    return new Minimatch(normalized, {
      dot: true,
      matchBase: true,
      windowsPathsNoEscape: true,
    });
  } catch (error) {
    throw new Error(`Invalid glob pattern: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function executableMissing(stderr: string): boolean {
  return stderr.includes("ENOENT") || stderr.toLowerCase().includes("not found");
}

function batches(candidates: readonly SearchCandidate[]): SearchCandidate[][] {
  const result: SearchCandidate[][] = [];
  let batch: SearchCandidate[] = [];
  let bytes = 0;

  for (const candidate of candidates) {
    const candidateBytes = Buffer.byteLength(candidate.searchPath) + 1;
    if (
      batch.length > 0 &&
      (batch.length >= MAX_BATCH_FILES || bytes + candidateBytes > MAX_BATCH_PATH_BYTES)
    ) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(candidate);
    bytes += candidateBytes;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

export class SearchTool {
  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly fileTools: FileTools,
    private readonly processes: ProcessRunner,
    private readonly config: AppConfig,
  ) {}

  async search(
    workspace: string,
    query: string,
    relativeCwd: string,
    glob?: string,
  ): Promise<SearchResult> {
    const cwd = await this.pathPolicy.resolveCwd(workspace, relativeCwd);
    const matcher = compileGlob(glob);
    const listed = await this.fileTools.list(
      workspace,
      path.relative(workspace, cwd) || ".",
      MAX_SEARCH_DEPTH,
      MAX_SEARCH_FILES,
    );
    const candidates = listed.entries
      .filter(
        (entry) =>
          entry.type === "file" &&
          entry.size !== undefined &&
          entry.size <= this.config.maxFileBytes,
      )
      .map((entry) => ({
        workspacePath: entry.path,
        searchPath: normalizeSearchPath(path.relative(cwd, path.join(workspace, entry.path))),
      }))
      .filter((candidate) => matcher?.match(candidate.searchPath) ?? true);

    const timeoutMs = Math.min(this.config.defaultTimeoutMs, 30_000);
    const environment = buildSafeEnvironment(process.env, this.config.environmentAllowlist);
    const probe = await this.processes.run({
      executable: "rg",
      args: ["--version"],
      cwd,
      env: environment,
      timeoutMs: Math.min(timeoutMs, 5_000),
      maxOutputBytes: Math.min(this.config.maxOutputBytes, 4_096),
    });
    if (executableMissing(probe.stderr)) {
      return this.searchFallback(workspace, candidates, query, listed.truncated);
    }

    return this.searchWithRipgrep(cwd, candidates, query, environment, timeoutMs, listed.truncated);
  }

  private async searchWithRipgrep(
    cwd: string,
    candidates: readonly SearchCandidate[],
    query: string,
    environment: NodeJS.ProcessEnv,
    timeoutMs: number,
    listingTruncated: boolean,
  ): Promise<SearchResult> {
    const output = new OutputLimiter(this.config.maxOutputBytes);
    const deadline = Date.now() + timeoutMs;
    let truncated = listingTruncated;
    let errorExitCode: number | null = null;

    for (const batch of batches(candidates)) {
      const accumulated = output.result();
      const used = Buffer.byteLength(accumulated.stdout) + Buffer.byteLength(accumulated.stderr);
      const remainingBytes = this.config.maxOutputBytes - used;
      const remainingTime = deadline - Date.now();
      if (remainingBytes <= 0 || remainingTime <= 0) {
        truncated = true;
        break;
      }

      const result = await this.processes.run({
        executable: "rg",
        args: [
          "--line-number",
          "--color",
          "never",
          "--no-heading",
          "--with-filename",
          "--fixed-strings",
          "--text",
          "--",
          query,
          ...batch.map((candidate) => candidate.searchPath),
        ],
        cwd,
        env: environment,
        timeoutMs: remainingTime,
        maxOutputBytes: remainingBytes,
      });
      output.append("stdout", result.stdout);
      output.append("stderr", result.stderr);
      truncated ||= result.truncated || result.timedOut;
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        errorExitCode ??= result.exitCode;
      }
      if (result.truncated || result.timedOut) break;
    }

    const limited = output.result();
    return {
      ...limited,
      exitCode: limited.stdout.length > 0 ? 0 : (errorExitCode ?? 1),
      truncated: truncated || limited.truncated,
      engine: "rg",
    };
  }

  private async searchFallback(
    workspace: string,
    candidates: readonly SearchCandidate[],
    query: string,
    listingTruncated: boolean,
  ): Promise<SearchResult> {
    const output = new OutputLimiter(this.config.maxOutputBytes);
    let truncated = listingTruncated;
    let outputFull = false;

    for (const candidate of candidates) {
      const file = await this.fileTools
        .read(workspace, candidate.workspacePath)
        .catch(() => undefined);
      if (file === undefined) continue;

      for (const [index, line] of file.content.split(/\r?\n/u).entries()) {
        if (!line.includes(query)) continue;
        output.append("stdout", `${candidate.searchPath}:${index + 1}:${line}\n`);
        if (output.result().truncated) {
          truncated = true;
          outputFull = true;
          break;
        }
      }
      if (outputFull) break;
    }

    const limited = output.result();
    return {
      ...limited,
      exitCode: limited.stdout.length > 0 ? 0 : 1,
      truncated: truncated || limited.truncated,
      engine: "fallback",
    };
  }
}
