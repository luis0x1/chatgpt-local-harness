import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type Kind = "client" | "pending" | "code" | "access" | "refresh";

export class OAuthStateStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
          throw new Error("OAuth SQLite file must be a private regular file");
        }
      } else {
        closeSync(openSync(file, "wx", 0o600));
      }
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_state (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at_ms INTEGER,
        PRIMARY KEY (kind, key)
      );
      CREATE INDEX IF NOT EXISTS oauth_state_expiry ON oauth_state(expires_at_ms);
    `);
  }

  get<T>(kind: Kind, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM oauth_state WHERE kind = ? AND key = ?")
      .get(kind, key) as { value: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as T);
  }

  set(kind: Kind, key: string, value: object, expiresAtMs?: number): void {
    this.db
      .prepare(
        `INSERT INTO oauth_state (kind, key, value, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value,
        expires_at_ms = excluded.expires_at_ms`,
      )
      .run(kind, key, JSON.stringify(value), expiresAtMs ?? null);
  }

  delete(kind: Kind, key: string): void {
    this.db.prepare("DELETE FROM oauth_state WHERE kind = ? AND key = ?").run(kind, key);
  }

  cleanupExpired(nowMs: number): void {
    this.db.prepare("DELETE FROM oauth_state WHERE expires_at_ms <= ?").run(nowMs);
  }

  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
