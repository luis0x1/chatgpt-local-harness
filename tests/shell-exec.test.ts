import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/security/audit-log.js";
import { CommandPolicy } from "../src/security/command-policy.js";
import { PathPolicy } from "../src/security/path-policy.js";
import { ProcessManager } from "../src/security/process-manager.js";
import { CommandExecutor } from "../src/tools/command-exec.js";
import { ShellExecutor } from "../src/tools/shell-exec.js";
import { testConfig } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "harness-exec-"));
  cleanup.push(workspace);
  const config = testConfig(workspace, { auditLogPath: path.join(workspace, "audit.jsonl") });
  const policy = await PathPolicy.create([workspace]);
  const commandPolicy = new CommandPolicy();
  const processes = new ProcessManager();
  const audit = new AuditLog(config.auditLogPath);
  return {
    workspace,
    command: new CommandExecutor(policy, commandPolicy, processes, audit, config),
    shell: new ShellExecutor(policy, commandPolicy, processes, audit, config),
  };
}

describe("execution tools", () => {
  it("does not interpret command_exec arguments as shell syntax", async () => {
    const { workspace, command } = await fixture();
    const marker = path.join(workspace, "injected.txt");
    const payload = `value; node -e "require('node:fs').writeFileSync('${marker}', 'bad')"`;
    const result = await command.run(workspace, {
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", payload],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(payload);
    await expect(access(marker)).rejects.toThrow();
  });

  it("returns shell stdout, stderr, and exit code", async () => {
    const { workspace, shell } = await fixture();
    const command = `node -e "process.stdout.write('out');process.stderr.write('err');process.exit(7)"`;
    const result = await shell.run(workspace, { command });
    expect(result).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err", timedOut: false });
  });

  it("blocks cwd outside the workspace", async () => {
    const { workspace, command } = await fixture();
    await expect(
      command.run(workspace, { executable: "node", args: ["--version"], cwd: ".." }),
    ).rejects.toThrow(/traversal/i);
  });
});
