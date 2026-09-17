import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicy } from "../src/security/path-policy.js";
import type { ProcessRequest, ProcessResult } from "../src/security/process-manager.js";
import { FileTools } from "../src/tools/files.js";
import { SearchTool } from "../src/tools/search.js";
import { testConfig } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class FakeRipgrep {
  readonly searchedPaths: string[] = [];
  searchCalls = 0;

  constructor(private readonly available: boolean) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (!this.available) {
      return this.result(request, "", "spawn rg ENOENT", null);
    }
    if (request.args?.length === 1 && request.args[0] === "--version") {
      return this.result(request, "ripgrep 99.0.0\n", "", 0);
    }

    this.searchCalls += 1;
    const args = [...(request.args ?? [])];
    const separator = args.indexOf("--");
    const query = args[separator + 1] ?? "";
    const paths = args.slice(separator + 2);
    this.searchedPaths.push(...paths);

    let stdout = "";
    for (const candidate of paths) {
      const content = await readFile(path.join(request.cwd, candidate), "utf8");
      for (const [index, line] of content.split(/\r?\n/u).entries()) {
        if (line.includes(query)) {
          stdout += `${candidate}:${index + 1}:${line}\n`;
        }
      }
    }

    const buffer = Buffer.from(stdout);
    const truncated = buffer.length > request.maxOutputBytes;
    return this.result(
      request,
      buffer.subarray(0, request.maxOutputBytes).toString("utf8"),
      "",
      stdout.length > 0 ? 0 : 1,
      truncated,
    );
  }

  private result(
    request: ProcessRequest,
    stdout: string,
    stderr: string,
    exitCode: number | null,
    truncated = false,
  ): ProcessResult {
    return {
      stdout,
      stderr,
      exitCode,
      truncated,
      timedOut: false,
      durationMs: 0,
      cwd: request.cwd,
    };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-search-"));
  cleanup.push(root);
  const workspace = path.join(root, "repo");
  await mkdir(workspace);

  const files = {
    "src/main.ts": "needle ts",
    "src/main.js": "needle js",
    "src/nested/util.ts": "needle util",
    "src/nested/util.test.ts": "needle test",
    "docs/readme.md": "needle docs",
    ".visible.txt": "needle hidden",
    ".env.example": "needle example",
    ".env": "needle secret",
    "nested/.env.local": "needle secret",
    "node_modules/pkg.ts": "needle secret",
    ".git/config": "needle secret",
    "dist/output.ts": "needle secret",
    "keys/id_rsa": "needle secret",
    "secrets/credentials.json": "needle secret",
  };

  for (const [relativePath, value] of Object.entries(files)) {
    const absolute = path.join(workspace, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
  }

  const policy = await PathPolicy.create([root]);
  return {
    root,
    workspace,
    policy,
    fileTools: new FileTools(policy, 64 * 1024),
  };
}

function matchedPaths(stdout: string): string[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf(":")))
    .sort();
}

const allSafePaths = [
  ".env.example",
  ".visible.txt",
  "docs/readme.md",
  "src/main.js",
  "src/main.ts",
  "src/nested/util.test.ts",
  "src/nested/util.ts",
];

const cases: Array<{ glob?: string; expected: string[] }> = [
  { expected: allSafePaths },
  { glob: "**/*", expected: allSafePaths },
  {
    glob: "src/**/*.ts",
    expected: ["src/main.ts", "src/nested/util.test.ts", "src/nested/util.ts"],
  },
  {
    glob: "!**/*.test.ts",
    expected: allSafePaths.filter((candidate) => candidate !== "src/nested/util.test.ts"),
  },
  {
    glob: "src/**/*.{ts,js}",
    expected: ["src/main.js", "src/main.ts", "src/nested/util.test.ts", "src/nested/util.ts"],
  },
  { glob: ".env", expected: [] },
  { glob: "**/.env*", expected: [".env.example"] },
  {
    glob: "**/*.{md,txt}",
    expected: [".visible.txt", "docs/readme.md"],
  },
];

describe("repository search", () => {
  for (const available of [true, false]) {
    const engine = available ? "rg" : "fallback";

    it.each(cases)(
      `uses equivalent protected-path and glob semantics with ${engine}: $glob`,
      async ({ glob, expected }) => {
        const { workspace, policy, fileTools } = await fixture();
        const processes = new FakeRipgrep(available);
        const search = new SearchTool(policy, fileTools, processes, testConfig(workspace));

        const result = await search.search(workspace, "needle", ".", glob);

        expect(result.engine).toBe(engine);
        expect(matchedPaths(result.stdout)).toEqual([...expected].sort());
        expect(result.stdout).not.toMatch(
          /(?:^|\/)(?:\.git|node_modules|dist)(?:\/|:)|\.env(?:\.local)?:|id_rsa:|credentials\.json:/mu,
        );
      },
    );
  }

  it.each([
    "",
    "!",
    "../**",
    "src/../**",
    "/tmp/**",
    "C:\\temp\\**",
    "src/{..,safe}/**",
    "two\npatterns",
    "bad\0pattern",
    "a".repeat(1_025),
  ])("rejects unsupported or unsafe glob %j", async (glob) => {
    const { workspace, policy, fileTools } = await fixture();
    const search = new SearchTool(policy, fileTools, new FakeRipgrep(true), testConfig(workspace));

    await expect(search.search(workspace, "needle", ".", glob)).rejects.toThrow(
      /glob|relative|pattern/i,
    );
  });

  it.each([true, false])(
    "enforces the combined output limit with rg available=%s",
    async (available) => {
      const { workspace, policy, fileTools } = await fixture();
      const maxOutputBytes = 24;
      const search = new SearchTool(
        policy,
        fileTools,
        new FakeRipgrep(available),
        testConfig(workspace, { maxOutputBytes }),
      );

      const result = await search.search(workspace, "needle", ".");

      expect(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      ).toBeLessThanOrEqual(maxOutputBytes);
      expect(result.truncated).toBe(true);
    },
  );
  it("batches large approved candidate sets without changing results", async () => {
    const { workspace, policy, fileTools } = await fixture();
    const bulk = path.join(workspace, "bulk");
    await mkdir(bulk);
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(path.join(bulk, `file-${String(index).padStart(3, "0")}.ts`), "needle bulk"),
      ),
    );
    const processes = new FakeRipgrep(true);
    const search = new SearchTool(
      policy,
      fileTools,
      processes,
      testConfig(workspace, { maxOutputBytes: 256 * 1024 }),
    );

    const result = await search.search(workspace, "needle", ".", "bulk/**/*.ts");

    expect(result.engine).toBe("rg");
    expect(result.truncated).toBe(false);
    expect(processes.searchCalls).toBeGreaterThan(1);
    expect(processes.searchedPaths).toHaveLength(300);
    expect(matchedPaths(result.stdout)).toHaveLength(300);
  });

  it("confines cwd and returns paths relative to it", async () => {
    const { workspace, policy, fileTools } = await fixture();
    const search = new SearchTool(policy, fileTools, new FakeRipgrep(true), testConfig(workspace));

    const result = await search.search(workspace, "needle", "src", "**/*.ts");

    expect(matchedPaths(result.stdout)).toEqual([
      "main.ts",
      "nested/util.test.ts",
      "nested/util.ts",
    ]);
    await expect(search.search(workspace, "needle", "../", "**/*.ts")).rejects.toThrow(
      /traversal/i,
    );
  });
});
