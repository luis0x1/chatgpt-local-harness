import { lstat, opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PathPolicy } from "../security/path-policy.js";
import { assertReadablePath, isSensitivePath } from "../security/sensitive-path-policy.js";

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
    const readOptions = { allowEnvExample: true };
    assertReadablePath(relativePath, readOptions);
    const resolved = await this.pathPolicy.resolveExisting(workspace, relativePath);
    assertReadablePath(path.relative(workspace, resolved), readOptions);
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
    assertReadablePath(relativePath);
    const start = await this.pathPolicy.resolveExisting(workspace, relativePath);
    assertReadablePath(path.relative(workspace, start));
    const entries: FileEntry[] = [];
    let truncated = false;

    const walk = async (absolute: string, depth: number): Promise<void> => {
      if (truncated) return;
      const directory = await opendir(absolute);
      for await (const entry of directory) {
        const entryAbsolute = path.join(absolute, entry.name);
        const entryRelative = path.relative(workspace, entryAbsolute);
        if (isSensitivePath(entryRelative, { allowEnvExample: entry.isFile() })) continue;
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
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
