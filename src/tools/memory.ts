import { lstat, opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  MemoryLocation,
  MemoryPathPolicy,
  MemoryScope,
} from "../security/memory-path-policy.js";
import { redactSecrets } from "../security/secret-redactor.js";

export const MEMORY_EXTENSION_ALLOWLIST = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

interface MemoryOptions {
  scope: MemoryScope;
  project?: string;
}

interface MemoryEntry {
  path: string;
  size: number;
}

interface MemorySearchMatch {
  path: string;
  line: number;
  snippet: string;
}

function allowedExtension(filePath: string): boolean {
  return MEMORY_EXTENSION_ALLOWLIST.has(path.extname(filePath).toLowerCase());
}

function limitedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export class MemoryTools {
  constructor(
    private readonly pathPolicy: MemoryPathPolicy,
    private readonly maxFileBytes: number,
    private readonly maxOutputBytes: number,
  ) {}

  private location(options: MemoryOptions): MemoryLocation {
    return {
      scope: options.scope,
      ...(options.project === undefined ? {} : { project: options.project }),
    };
  }

  private async files(
    options: MemoryOptions,
    relativePath: string,
    maxDepth: number,
    maxFiles: number,
  ): Promise<{ entries: MemoryEntry[]; truncated: boolean }> {
    const location = this.location(options);
    const scopeRoot = await this.pathPolicy.resolveScope(location);
    const start = await this.pathPolicy.resolveExisting(location, relativePath);
    const startStat = await stat(start);
    if (!startStat.isDirectory()) throw new Error("Memory list path must be a directory");

    const entries: MemoryEntry[] = [];
    let truncated = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (entries.length >= maxFiles) {
          truncated = true;
          break;
        }
        if (entry.name.startsWith(".")) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(scopeRoot, absolute);
        if (options.scope === "global" && relative.split(path.sep)[0] === "projects") continue;
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory()) {
          if (depth < maxDepth) await walk(absolute, depth + 1);
          continue;
        }
        if (!metadata.isFile() || !allowedExtension(entry.name)) continue;
        entries.push({ path: relative, size: metadata.size });
      }
    };
    await walk(start, 0);
    return { entries, truncated };
  }

  async list(
    options: MemoryOptions,
    relativePath: string,
    maxDepth: number,
    maxResults: number,
  ): Promise<{ scope: MemoryScope; project?: string; entries: MemoryEntry[]; truncated: boolean }> {
    const listed = await this.files(options, relativePath, maxDepth, maxResults);
    const entries: MemoryEntry[] = [];
    let usedBytes = 0;
    let truncated = listed.truncated;
    for (const entry of listed.entries) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (usedBytes + bytes > this.maxOutputBytes) {
        truncated = true;
        break;
      }
      entries.push(entry);
      usedBytes += bytes;
    }
    return {
      scope: options.scope,
      ...(options.project === undefined ? {} : { project: options.project }),
      entries,
      truncated,
    };
  }

  async get(
    options: MemoryOptions,
    relativePath: string,
  ): Promise<{
    scope: MemoryScope;
    project?: string;
    path: string;
    content: string;
    size: number;
    truncated: boolean;
  }> {
    if (!allowedExtension(relativePath)) throw new Error("Memory file extension is not allowed");
    const location = this.location(options);
    const resolved = await this.pathPolicy.resolveExisting(location, relativePath);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) throw new Error("Requested memory path is not a regular file");
    if (metadata.size > this.maxFileBytes) {
      throw new Error("Memory file exceeds the " + this.maxFileBytes + "-byte read limit");
    }
    const redacted = redactSecrets(await readFile(resolved, "utf8"));
    const limited = limitedUtf8(redacted, this.maxOutputBytes);
    return {
      scope: options.scope,
      ...(options.project === undefined ? {} : { project: options.project }),
      path: relativePath,
      content: limited.value,
      size: metadata.size,
      truncated: limited.truncated,
    };
  }

  async search(
    options: MemoryOptions,
    query: string,
    maxResults: number,
  ): Promise<{
    scope: MemoryScope;
    project?: string;
    matches: MemorySearchMatch[];
    truncated: boolean;
  }> {
    const listed = await this.files(options, ".", 20, 5_000);
    const location = this.location(options);
    const scopeRoot = await this.pathPolicy.resolveScope(location);
    const needle = query.toLowerCase();
    const matches: MemorySearchMatch[] = [];
    let usedBytes = 0;
    let truncated = listed.truncated;

    outer: for (const entry of listed.entries) {
      if (entry.size > this.maxFileBytes) continue;
      const resolved = await this.pathPolicy.resolveExisting(location, entry.path);
      const content = redactSecrets(await readFile(resolved, "utf8"));
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          break outer;
        }
        const snippet = limitedUtf8(line, 2_048).value;
        const match = { path: path.relative(scopeRoot, resolved), line: index + 1, snippet };
        const bytes = Buffer.byteLength(JSON.stringify(match));
        if (usedBytes + bytes > this.maxOutputBytes) {
          truncated = true;
          break outer;
        }
        matches.push(match);
        usedBytes += bytes;
      }
    }

    return {
      scope: options.scope,
      ...(options.project === undefined ? {} : { project: options.project }),
      matches,
      truncated,
    };
  }
}
