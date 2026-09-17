import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicy } from "../src/security/path-policy.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("PathPolicy", () => {
  it("accepts a valid path inside a configured workspace root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-"));
    cleanup.push(root);
    const workspace = path.join(root, "repo");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "ok");
    const policy = await PathPolicy.create([root]);

    expect(await policy.openWorkspace(workspace)).toBe(await policy.resolveExisting(workspace));
    expect(await policy.resolveExisting(workspace, "file.txt")).toBe(
      path.join(workspace, "file.txt"),
    );
  });

  it("blocks parent traversal and cwd outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-"));
    cleanup.push(root);
    const workspace = path.join(root, "repo");
    await mkdir(workspace);
    const policy = await PathPolicy.create([root]);

    await expect(policy.resolveExisting(workspace, "../outside.txt")).rejects.toThrow(/traversal/i);
    await expect(policy.resolveCwd(workspace, "..")).rejects.toThrow(/traversal/i);
  });

  it.skipIf(process.platform === "win32")(
    "blocks a symlink that escapes the workspace",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-"));
      const outside = await mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
      cleanup.push(root, outside);
      const workspace = path.join(root, "repo");
      await mkdir(workspace);
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(outside, path.join(workspace, "escape"));
      const policy = await PathPolicy.create([root]);

      await expect(policy.resolveExisting(workspace, "escape/secret.txt")).rejects.toThrow(
        /escapes/i,
      );
      await expect(policy.resolveForWrite(workspace, "escape/new.txt")).rejects.toThrow(/symlink/i);
    },
  );
});
