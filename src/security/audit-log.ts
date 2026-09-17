import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./environment-policy.js";

export interface AuditEvent {
  timestamp?: string;
  tool: string;
  workspace: string;
  command?: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export class AuditLog {
  constructor(private readonly filePath: string) {}

  async write(event: AuditEvent): Promise<void> {
    const safeEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...(event.command === undefined
        ? {}
        : { command: redactSecrets(event.command).slice(0, 4_096) }),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(safeEvent)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
