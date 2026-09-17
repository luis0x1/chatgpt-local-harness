import { createHash } from "node:crypto";
import type { PathPolicy } from "../security/path-policy.js";

export interface WorkspaceRecord {
  id: string;
  path: string;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, WorkspaceRecord>();

  constructor(private readonly pathPolicy: PathPolicy) {}

  async open(requestedPath: string): Promise<WorkspaceRecord> {
    const canonical = await this.pathPolicy.openWorkspace(requestedPath);
    const id = `ws_${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
    const record = { id, path: canonical };
    this.workspaces.set(id, record);
    return record;
  }

  get(id: string): WorkspaceRecord {
    const workspace = this.workspaces.get(id);
    if (workspace === undefined) throw new Error(`Unknown workspace ID: ${id}`);
    return workspace;
  }
}
