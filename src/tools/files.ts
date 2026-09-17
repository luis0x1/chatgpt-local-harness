import { lstat, opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PathPolicy } from "../security/path-policy.js";

const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".svelte-kit",
  "target",
  ".env",
]);

const SECRET_FILE_PATTERNS = [
  /^\.env\./,
  /^(?:id_rsa|id_ed25519)$/,
  /\.(?:pem|p12|pfx|key)$/i,
  /credentials?(?:\.json)?$/i,
];

function shouldIgnore(name: string): boolean {
  return IGNORED_NAMES.has(name) || SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export interface FileEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
}

export class FileTools {
  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly maxFileBytes: number,
  ) {}

  async read(
    workspace: string,
    relativePath: string,
  ): Promise<{ path: string; content: string; size: number }> {
    if (shouldIgnore(path.basename(relativePath)))
      throw new Error("Sensitive or ignored files cannot be read");
    const resolved = await this.pathPolicy.resolveExisting(workspace, relativePath);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) throw new Error("Requested path is not a regular file");
    if (metadata.size > this.maxFileBytes) {
      throw new Error(`File exceeds the ${this.maxFileBytes}-byte read limit`);
    }
    return { path: relativePath, content: await readFile(resolved, "utf8"), size: metadata.size };
  }

  async list(
    workspace: string,
    relativePath: string,
    maxDepth: number,
    maxEntries: number,
  ): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const start = await this.pathPolicy.resolveExisting(workspace, relativePath);
    const entries: FileEntry[] = [];
    let truncated = false;

    const walk = async (absolute: string, depth: number): Promise<void> => {
      if (truncated) return;
      const directory = await opendir(absolute);
      for await (const entry of directory) {
        if (shouldIgnore(entry.name)) continue;
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        const entryAbsolute = path.join(absolute, entry.name);
        const entryRelative = path.relative(workspace, entryAbsolute);
        const info = await lstat(entryAbsolute).catch(() => undefined);
        const type = entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "other";
        entries.push({ path: entryRelative, type, ...(info?.isFile() ? { size: info.size } : {}) });
        if (entry.isDirectory() && !entry.isSymbolicLink() && depth < maxDepth) {
          await walk(entryAbsolute, depth + 1);
        }
      }
    };

    const startStat = await stat(start);
    if (!startStat.isDirectory()) throw new Error("file_list path must be a directory");
    await walk(start, 0);
    return { entries, truncated };
  }
}
