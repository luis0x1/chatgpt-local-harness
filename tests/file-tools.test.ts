import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("rejects protected reads at any path component while allowing narrow examples", async () => {
    const { workspace, policy } = await fixture();
    const protectedPaths = [
      ".git/config",
      "node_modules/pkg.js",
      "dist/output.js",
      ".env",
      "nested/.env.local",
      ".npmrc",
      ".pypirc",
      ".netrc",
      "auth.json",
      "keys/id_rsa",
      "keys/signing.pem",
      "secrets/credentials.json",
    ];

    for (const protectedPath of protectedPaths) {
      await mkdir(path.dirname(path.join(workspace, protectedPath)), { recursive: true });
      await writeFile(path.join(workspace, protectedPath), "sensitive");
    }
    await writeFile(path.join(workspace, ".env.example"), "SAFE_EXAMPLE=yes");
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "git-client.ts"), "export {};");

    const files = new FileTools(policy, 1_024);
    for (const protectedPath of protectedPaths) {
      await expect(files.read(workspace, protectedPath)).rejects.toThrow(/sensitive|ignored/i);
    }
    await expect(files.read(workspace, ".env.example")).resolves.toMatchObject({
      content: "SAFE_EXAMPLE=yes",
    });
    await expect(files.read(workspace, "src/git-client.ts")).resolves.toMatchObject({
      content: "export {};",
    });
  });

  it("rejects protected starting directories for listings", async () => {
    const { workspace, policy } = await fixture();
    const protectedDirectories = [".git", "node_modules", "nested/dist", ".env.example"];

    for (const protectedDirectory of protectedDirectories) {
      await mkdir(path.join(workspace, protectedDirectory), { recursive: true });
    }

    const files = new FileTools(policy, 1_024);
    for (const protectedDirectory of protectedDirectories) {
      await expect(files.list(workspace, protectedDirectory, 1, 100)).rejects.toThrow(
        /sensitive|ignored/i,
      );
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinks whose canonical target is protected",
    async () => {
      const { workspace, policy } = await fixture();
      await mkdir(path.join(workspace, ".git"));
      await writeFile(path.join(workspace, ".git", "config"), "sensitive");
      await symlink(path.join(workspace, ".git"), path.join(workspace, "visible-link"));

      const files = new FileTools(policy, 1_024);
      await expect(files.read(workspace, "visible-link/config")).rejects.toThrow(
        /sensitive|ignored/i,
      );
      await expect(files.list(workspace, "visible-link", 1, 100)).rejects.toThrow(
        /sensitive|ignored/i,
      );
    },
  );

  it("omits secrets and build directories from listings", async () => {
    const { workspace, policy } = await fixture();
    await writeFile(path.join(workspace, "visible.ts"), "ok");
    await writeFile(path.join(workspace, ".env"), "SECRET=yes");
    await writeFile(path.join(workspace, ".env.example"), "SAFE_EXAMPLE=yes");
    await mkdir(path.join(workspace, "node_modules"));
    await writeFile(path.join(workspace, "node_modules", "hidden.js"), "no");
    await mkdir(path.join(workspace, "samples", ".env.example"), { recursive: true });
    await writeFile(path.join(workspace, "samples", ".env.example", "hidden.txt"), "no");
    const files = new FileTools(policy, 1_024);

    const listed = await files.list(workspace, ".", 4, 100);
    expect(listed.entries.map((entry) => entry.path).sort()).toEqual([
      ".env.example",
      "samples",
      "visible.ts",
    ]);
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
