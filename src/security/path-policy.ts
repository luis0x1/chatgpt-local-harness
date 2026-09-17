import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class PathPolicyError extends Error {
  override name = "PathPolicyError";
}

export interface PathPolicyOptions {
  allowUnc?: boolean;
}

function isWindowsUnc(value: string): boolean {
  return value.startsWith("\\\\") || value.startsWith("//");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function rejectBroadRoot(candidate: string): void {
  const parsed = path.parse(candidate);
  if (candidate === parsed.root) {
    throw new PathPolicyError("Filesystem roots cannot be configured as workspace roots");
  }

  const home = path.resolve(os.homedir());
  if (path.resolve(candidate) === home) {
    throw new PathPolicyError("The user home directory cannot be a workspace root");
  }
}

function rejectRelativeTraversal(relativePath: string): void {
  if (relativePath.includes("\0")) {
    throw new PathPolicyError("Paths cannot contain NUL bytes");
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new PathPolicyError("Tool paths must be relative to the workspace");
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new PathPolicyError("Path traversal outside the workspace is not allowed");
  }
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let cursor = candidate;
  while (true) {
    try {
      await lstat(cursor);
      return cursor;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

export class PathPolicy {
  private constructor(
    readonly roots: readonly string[],
    private readonly allowUnc: boolean,
  ) {}

  static async create(
    roots: readonly string[],
    options: PathPolicyOptions = {},
  ): Promise<PathPolicy> {
    if (roots.length === 0) {
      throw new PathPolicyError("At least one workspace root must be configured");
    }

    const canonicalRoots: string[] = [];
    for (const root of roots) {
      if (!root.trim()) throw new PathPolicyError("Workspace roots cannot be empty");
      if (isWindowsUnc(root) && !options.allowUnc) {
        throw new PathPolicyError("UNC workspace roots are disabled");
      }
      const canonical = await realpath(path.resolve(root));
      rejectBroadRoot(canonical);
      await access(canonical, constants.R_OK);
      canonicalRoots.push(canonical);
    }

    return new PathPolicy([...new Set(canonicalRoots)], options.allowUnc ?? false);
  }

  async openWorkspace(requestedPath: string): Promise<string> {
    if (isWindowsUnc(requestedPath) && !this.allowUnc) {
      throw new PathPolicyError("UNC workspace paths are disabled");
    }
    const canonical = await realpath(path.resolve(requestedPath));
    rejectBroadRoot(canonical);
    if (!this.roots.some((root) => isWithin(root, canonical))) {
      throw new PathPolicyError("Workspace is outside the configured roots");
    }
    return canonical;
  }

  async resolveExisting(workspace: string, relativePath = "."): Promise<string> {
    rejectRelativeTraversal(relativePath);
    const candidate = path.resolve(workspace, relativePath);
    const canonical = await realpath(candidate);
    if (!isWithin(workspace, canonical)) {
      throw new PathPolicyError("Resolved path escapes the workspace (possibly through a symlink)");
    }
    return canonical;
  }

  async resolveForWrite(workspace: string, relativePath: string): Promise<string> {
    rejectRelativeTraversal(relativePath);
    const candidate = path.resolve(workspace, relativePath);
    const ancestor = await nearestExistingAncestor(candidate);
    const canonicalAncestor = await realpath(ancestor);
    if (!isWithin(workspace, canonicalAncestor)) {
      throw new PathPolicyError("Write path escapes the workspace through a symlink");
    }
    const suffix = path.relative(ancestor, candidate);
    const resolved = path.resolve(canonicalAncestor, suffix);
    if (!isWithin(workspace, resolved)) {
      throw new PathPolicyError("Write path escapes the workspace");
    }
    return resolved;
  }

  async resolveCwd(workspace: string, relativeCwd = "."): Promise<string> {
    return this.resolveExisting(workspace, relativeCwd);
  }
}

export function pathIsWithin(parent: string, candidate: string): boolean {
  return isWithin(parent, candidate);
}
