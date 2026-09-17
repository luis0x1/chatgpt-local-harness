import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryPathPolicy } from "../src/security/memory-path-policy.js";
import { MemoryTools } from "../src/tools/memory.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(maxOutputBytes = 64 * 1024): Promise<{
  base: string;
  memoryRoot: string;
  outside: string;
  memory: MemoryTools;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "harness-memory-"));
  cleanup.push(base);
  const workspaceRoot = path.join(base, "workspaces");
  const memoryRoot = path.join(base, "memory");
  const outside = path.join(base, "outside");
  await Promise.all([
    mkdir(workspaceRoot),
    mkdir(path.join(memoryRoot, "projects", "demo"), { recursive: true }),
    mkdir(outside),
  ]);
  const policy = await MemoryPathPolicy.create(memoryRoot, [workspaceRoot]);
  return {
    base,
    memoryRoot,
    outside,
    memory: new MemoryTools(policy, 64 * 1024, maxOutputBytes),
  };
}

describe("local memory tools", () => {
  it("keeps global and project scopes separate", async () => {
    const { memoryRoot, memory } = await fixture();
    await writeFile(path.join(memoryRoot, "global.md"), "global decision");
    await writeFile(path.join(memoryRoot, "projects", "demo", "project.md"), "project decision");

    const global = await memory.list({ scope: "global" }, ".", 4, 20);
    const project = await memory.list({ scope: "project", project: "demo" }, ".", 4, 20);
    expect(global.entries.map((entry) => entry.path)).toEqual(["global.md"]);
    expect(project.entries.map((entry) => entry.path)).toEqual(["project.md"]);

    expect((await memory.search({ scope: "global" }, "decision", 20)).matches).toHaveLength(1);
    expect(
      (await memory.search({ scope: "project", project: "demo" }, "decision", 20)).matches,
    ).toHaveLength(1);
    await expect(memory.get({ scope: "global" }, "projects/demo/project.md")).rejects.toThrow(
      /project scope/i,
    );
  });

  it("blocks traversal and non-allowlisted extensions", async () => {
    const { memoryRoot, memory } = await fixture();
    await writeFile(path.join(memoryRoot, "notes.md"), "safe");
    await writeFile(path.join(memoryRoot, "script.ts"), "secret");

    await expect(memory.get({ scope: "global" }, "../outside/secret.md")).rejects.toThrow(
      /traversal/i,
    );
    await expect(memory.get({ scope: "global" }, "script.ts")).rejects.toThrow(/extension/i);
    expect((await memory.list({ scope: "global" }, ".", 4, 20)).entries).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("blocks symlink escape", async () => {
    const { memoryRoot, outside, memory } = await fixture();
    await writeFile(path.join(outside, "secret.md"), "outside");
    await symlink(outside, path.join(memoryRoot, "escape"));

    await expect(memory.get({ scope: "global" }, "escape/secret.md")).rejects.toThrow(/escapes/i);
  });

  it.skipIf(process.platform === "win32")(
    "keeps project scope inside the projects directory",
    async () => {
      const { memoryRoot, memory } = await fixture();
      await writeFile(path.join(memoryRoot, "global.md"), "global only");
      await rm(path.join(memoryRoot, "projects", "demo"), { recursive: true });
      await symlink(memoryRoot, path.join(memoryRoot, "projects", "demo"));

      await expect(memory.get({ scope: "project", project: "demo" }, "global.md")).rejects.toThrow(
        /projects directory/i,
      );
    },
  );

  it("redacts tokens, passwords, API keys, and private keys", async () => {
    const { memoryRoot, memory } = await fixture();
    const content = [
      "api_key=sk-abcdefghijk123456",
      '"password": "super secret value with spaces"',
      "token=github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "-----BEGIN PRIVATE KEY-----",
      "private-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    await writeFile(path.join(memoryRoot, "sensitive.md"), content);

    const result = await memory.get({ scope: "global" }, "sensitive.md");
    expect(result.content).toContain("[REDACTED]");
    expect(result.content).toContain("[REDACTED PRIVATE KEY]");
    expect(result.content).not.toContain("abcdefghijk123456");
    expect(result.content).not.toContain("super secret value with spaces");
    expect(result.content).not.toContain("private-material");

    const search = await memory.search({ scope: "global" }, "password", 20);
    expect(search.matches[0]?.snippet).toContain("[REDACTED]");
    expect(search.matches[0]?.snippet).not.toContain("super secret value with spaces");
    expect((await memory.search({ scope: "global" }, "private-material", 20)).matches).toEqual([]);
  });

  it("truncates content and search results at configured limits", async () => {
    const { memoryRoot, memory } = await fixture(96);
    await writeFile(path.join(memoryRoot, "large.md"), "€".repeat(512));

    const result = await memory.get({ scope: "global" }, "large.md");
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(96);
    expect(result.truncated).toBe(true);

    await writeFile(
      path.join(memoryRoot, "matches.md"),
      Array.from({ length: 10 }, (_, index) => "needle " + index + " " + "y".repeat(80)).join("\n"),
    );
    const search = await memory.search({ scope: "global" }, "needle", 100);
    expect(search.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(search.matches))).toBeLessThanOrEqual(160);
  });

  it("requires an absolute expanded memory root", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "harness-memory-absolute-"));
    cleanup.push(base);
    const workspaceRoot = path.join(base, "workspaces");
    await mkdir(workspaceRoot);

    await expect(MemoryPathPolicy.create("relative-memory", [workspaceRoot])).rejects.toThrow(
      /absolute/i,
    );
  });

  it("only permits the memories directory inside a Codex home", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "harness-codex-memory-"));
    cleanup.push(base);
    const fakeHome = path.join(base, "home");
    const codexRoot = path.join(fakeHome, ".codex");
    const memories = path.join(codexRoot, "memories");
    const workspaceRoot = path.join(base, "workspaces");
    await Promise.all([mkdir(memories, { recursive: true }), mkdir(workspaceRoot)]);

    await expect(
      MemoryPathPolicy.create(codexRoot, [workspaceRoot], { homeDirectory: fakeHome }),
    ).rejects.toThrow(/restricted/i);
    await expect(
      MemoryPathPolicy.create(memories, [workspaceRoot], { homeDirectory: fakeHome }),
    ).resolves.toMatchObject({ root: memories });
  });

  it("rejects a memory root that overlaps workspace roots", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "harness-memory-overlap-"));
    cleanup.push(base);
    const memoryRoot = path.join(base, "memory");
    await mkdir(memoryRoot);

    await expect(MemoryPathPolicy.create(memoryRoot, [base])).rejects.toThrow(/overlap/i);
  });
});
