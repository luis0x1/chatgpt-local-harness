import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicy } from "../src/security/path-policy.js";
import { ProcessManager } from "../src/security/process-manager.js";
import { FileTools } from "../src/tools/files.js";
import { PatchTool } from "../src/tools/patch.js";
import { testConfig } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-files-"));
  cleanup.push(root);
  const workspace = path.join(root, "repo");
  await mkdir(workspace);
  const policy = await PathPolicy.create([root]);
  return { root, workspace, policy };
}

describe("file tools", () => {
  it("reads files within the workspace and blocks outside paths", async () => {
    const { root, workspace, policy } = await fixture();
    await writeFile(path.join(workspace, "inside.txt"), "inside");
    await writeFile(path.join(root, "outside.txt"), "outside");
    const files = new FileTools(policy, 1_024);

    await expect(files.read(workspace, "inside.txt")).resolves.toMatchObject({ content: "inside" });
    await expect(files.read(workspace, "../outside.txt")).rejects.toThrow(/traversal/i);
  });

  it("omits secrets and build directories from listings", async () => {
    const { workspace, policy } = await fixture();
    await writeFile(path.join(workspace, "visible.ts"), "ok");
    await writeFile(path.join(workspace, ".env"), "SECRET=yes");
    await mkdir(path.join(workspace, "node_modules"));
    await writeFile(path.join(workspace, "node_modules", "hidden.js"), "no");
    const files = new FileTools(policy, 1_024);

    const listed = await files.list(workspace, ".", 4, 100);
    expect(listed.entries.map((entry) => entry.path)).toEqual(["visible.ts"]);
  });

  it("applies a valid unified diff and rejects paths outside the workspace", async () => {
    const { workspace, policy } = await fixture();
    await writeFile(path.join(workspace, "hello.txt"), "hello\n");
    const patcher = new PatchTool(policy, new ProcessManager(), testConfig(workspace));
    const valid = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+world",
      "",
    ].join("\n");
    await expect(patcher.apply(workspace, valid)).resolves.toEqual({ files: ["hello.txt"] });
    expect(await readFile(path.join(workspace, "hello.txt"), "utf8")).toBe("world\n");

    const escape = valid.replaceAll("hello.txt", "../outside.txt");
    await expect(patcher.apply(workspace, escape)).rejects.toThrow(/traversal/i);
    await expect(access(path.join(workspace, "..", "outside.txt"))).rejects.toThrow();
  });
});
