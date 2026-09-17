import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathIsWithin, PathPolicyError } from "./path-policy.js";

export type MemoryScope = "global" | "project";

export interface MemoryLocation {
  scope: MemoryScope;
  project?: string;
}

function isWindowsUnc(value: string): boolean {
  return value.startsWith("\\\\") || value.startsWith("//");
}

function rejectRelativeTraversal(relativePath: string): void {
  if (relativePath.includes("\0")) throw new PathPolicyError("Paths cannot contain NUL bytes");
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new PathPolicyError("Memory paths must be relative to the selected scope");
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(".." + path.sep)) {
    throw new PathPolicyError("Path traversal outside the memory root is not allowed");
  }
}

function validateProject(project: string | undefined): string {
  if (project === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(project)) {
    throw new PathPolicyError(
      "Project scope requires a project name containing only letters, numbers, dot, underscore, or dash",
    );
  }
  return project;
}

export class MemoryPathPolicy {
  private constructor(readonly root: string | undefined) {}

  static async create(
    configuredRoot: string | undefined,
    workspaceRoots: readonly string[],
    options: { allowUnc?: boolean; homeDirectory?: string } = {},
  ): Promise<MemoryPathPolicy> {
    if (configuredRoot === undefined || configuredRoot.trim() === "") {
      return new MemoryPathPolicy(undefined);
    }
    if (
      configuredRoot === "~" ||
      configuredRoot.startsWith("~" + path.sep) ||
      (!path.isAbsolute(configuredRoot) && !path.win32.isAbsolute(configuredRoot))
    ) {
      throw new PathPolicyError("LOCAL_HARNESS_MEMORY_ROOT must use an absolute expanded path");
    }
    if (isWindowsUnc(configuredRoot) && !options.allowUnc) {
      throw new PathPolicyError("UNC memory roots are disabled");
    }

    const requested = path.resolve(configuredRoot);
    const canonical = await realpath(requested);
    const parsed = path.parse(canonical);
    const home = await realpath(path.resolve(options.homeDirectory ?? os.homedir()));
    if (canonical === parsed.root || canonical === home) {
      throw new PathPolicyError("Filesystem roots and the user home cannot be memory roots");
    }

    const codexRoot = path.resolve(home, ".codex");
    const codexMemories = path.join(codexRoot, "memories");
    if (
      (pathIsWithin(codexRoot, requested) || pathIsWithin(codexRoot, canonical)) &&
      (requested !== codexMemories || canonical !== codexMemories)
    ) {
      throw new PathPolicyError(
        "Codex memory access is restricted to the canonical ~/.codex/memories directory",
      );
    }

    if (
      workspaceRoots.some(
        (workspaceRoot) =>
          pathIsWithin(workspaceRoot, canonical) || pathIsWithin(canonical, workspaceRoot),
      )
    ) {
      throw new PathPolicyError("Memory root must not overlap a configured workspace root");
    }

    await access(canonical, constants.R_OK);
    return new MemoryPathPolicy(canonical);
  }

  requireRoot(): string {
    if (this.root === undefined) {
      throw new PathPolicyError("LOCAL_HARNESS_MEMORY_ROOT is not configured");
    }
    return this.root;
  }

  async resolveScope(location: MemoryLocation): Promise<string> {
    const root = this.requireRoot();
    if (location.scope === "global") return root;
    const project = validateProject(location.project);
    const projectsRoot = await realpath(path.join(root, "projects"));
    if (!pathIsWithin(root, projectsRoot)) {
      throw new PathPolicyError("Projects directory escapes the configured memory root");
    }
    const canonical = await realpath(path.join(projectsRoot, project));
    if (!pathIsWithin(projectsRoot, canonical)) {
      throw new PathPolicyError("Project memory scope escapes the projects directory");
    }
    return canonical;
  }

  async resolveExisting(location: MemoryLocation, relativePath: string): Promise<string> {
    rejectRelativeTraversal(relativePath);
    const root = this.requireRoot();
    const normalized = path.normalize(relativePath);
    if (
      location.scope === "global" &&
      (normalized === "projects" || normalized.startsWith("projects" + path.sep))
    ) {
      throw new PathPolicyError("Project memories require project scope");
    }
    const scopeRoot = await this.resolveScope(location);
    const canonical = await realpath(path.resolve(scopeRoot, normalized));
    if (!pathIsWithin(scopeRoot, canonical)) {
      throw new PathPolicyError("Resolved memory path escapes its scope through a symlink");
    }
    if (location.scope === "global" && pathIsWithin(path.join(root, "projects"), canonical)) {
      throw new PathPolicyError("Project memories require project scope");
    }
    return canonical;
  }
}
