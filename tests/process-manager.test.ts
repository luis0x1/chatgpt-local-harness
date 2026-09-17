import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSafeEnvironment } from "../src/security/environment-policy.js";
import { ProcessManager } from "../src/security/process-manager.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProcessManager", () => {
  const manager = new ProcessManager();

  it("times out commands", async () => {
    const result = await manager.run({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: os.tmpdir(),
      env: buildSafeEnvironment(process.env),
      timeoutMs: 100,
      maxOutputBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("kills the entire process tree on timeout", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harness-tree-"));
    cleanup.push(directory);
    const marker = path.join(directory, "marker.txt");
    const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 600)`;
    const parentScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}]); setInterval(() => {}, 1000)`;
    const result = await manager.run({
      executable: process.execPath,
      args: ["-e", parentScript],
      cwd: directory,
      env: buildSafeEnvironment(process.env),
      timeoutMs: 100,
      maxOutputBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(access(marker)).rejects.toThrow();
  });

  it("truncates combined output at the byte limit", async () => {
    const result = await manager.run({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(10000)); process.stderr.write('y'.repeat(10000))",
      ],
      cwd: os.tmpdir(),
      env: buildSafeEnvironment(process.env),
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(1_024);
    expect(result.truncated).toBe(true);
  });

  it("does not pass secret environment variables to children", async () => {
    const env = buildSafeEnvironment(
      { PATH: process.env.PATH, OPENAI_API_KEY: "secret", SAFE_VALUE: "ok" },
      ["OPENAI_API_KEY", "SAFE_VALUE"],
    );
    const result = await manager.run({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(String(process.env.OPENAI_API_KEY) + ':' + process.env.SAFE_VALUE)",
      ],
      cwd: os.tmpdir(),
      env,
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    });
    expect(result.stdout).toBe("undefined:ok");
  });
});
