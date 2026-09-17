import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { attachCodeGraphTools } from "./code-graph-proxy.js";
import type { AppConfig } from "./config.js";
import { SERVER_INSTRUCTIONS } from "./server-instructions.js";
import { AuditLog } from "./security/audit-log.js";
import { CommandPolicy } from "./security/command-policy.js";
import { MemoryPathPolicy } from "./security/memory-path-policy.js";
import { PathPolicy } from "./security/path-policy.js";
import { ProcessManager } from "./security/process-manager.js";
import { CommandExecutor } from "./tools/command-exec.js";
import { FileTools } from "./tools/files.js";
import { GitTools } from "./tools/git.js";
import { MemoryTools } from "./tools/memory.js";
import { PatchTool } from "./tools/patch.js";
import { SearchTool } from "./tools/search.js";
import { ShellExecutor } from "./tools/shell-exec.js";
import { WorkspaceRegistry } from "./tools/workspace.js";

export const TOOL_ANNOTATIONS = {
  workspace_open: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  file_read: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  file_list: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  repo_search: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  memory_search: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  memory_get: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  memory_list: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  apply_patch: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  git_status: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  git_diff: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  command_exec: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  shell_exec: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
} as const;

function jsonResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { ...value },
  };
}

export async function createServer(config: AppConfig): Promise<McpServer> {
  const pathPolicy = await PathPolicy.create(config.workspaceRoots, { allowUnc: config.allowUnc });
  const workspaces = new WorkspaceRegistry(pathPolicy);
  const memoryPathPolicy = await MemoryPathPolicy.create(config.memoryRoot, pathPolicy.roots, {
    allowUnc: config.allowUnc,
  });
  const memory = new MemoryTools(memoryPathPolicy, config.maxFileBytes, config.maxOutputBytes);
  const processes = new ProcessManager();
  const commandPolicy = new CommandPolicy(config.allowedCommands);
  const audit = new AuditLog(config.auditLogPath);
  const files = new FileTools(pathPolicy, config.maxFileBytes);
  const search = new SearchTool(pathPolicy, files, processes, config);
  const patches = new PatchTool(pathPolicy, processes, config);
  const git = new GitTools(pathPolicy, processes, config);
  const commands = new CommandExecutor(pathPolicy, commandPolicy, processes, audit, config);
  const shell = new ShellExecutor(pathPolicy, commandPolicy, processes, audit, config);

  const server = new McpServer(
    { name: "chatgpt-local-harness", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "workspace_open",
    {
      title: "Open workspace",
      description: "Canonicalize and open a workspace located inside a configured root.",
      inputSchema: z.object({ path: z.string().min(1) }),
      annotations: TOOL_ANNOTATIONS.workspace_open,
    },
    async ({ path }) => jsonResult(await workspaces.open(path)),
  );

  server.registerTool(
    "file_read",
    {
      title: "Read file",
      description:
        "Read a size-limited UTF-8 file without following symlinks outside the workspace.",
      inputSchema: z.object({ workspaceId: z.string(), path: z.string().min(1) }),
      annotations: TOOL_ANNOTATIONS.file_read,
    },
    async ({ workspaceId, path }) => {
      const workspace = workspaces.get(workspaceId);
      return jsonResult(await files.read(workspace.path, path));
    },
  );

  server.registerTool(
    "file_list",
    {
      title: "List files",
      description:
        "List workspace entries with depth/count limits and secret/build-directory exclusions.",
      inputSchema: z.object({
        workspaceId: z.string(),
        path: z.string().default("."),
        maxDepth: z.number().int().min(0).max(20).default(4),
        maxEntries: z.number().int().min(1).max(10_000).default(1_000),
      }),
      annotations: TOOL_ANNOTATIONS.file_list,
    },
    async ({ workspaceId, path, maxDepth, maxEntries }) => {
      const workspace = workspaces.get(workspaceId);
      return jsonResult(await files.list(workspace.path, path, maxDepth, maxEntries));
    },
  );

  server.registerTool(
    "repo_search",
    {
      title: "Search repository",
      description:
        "Search inside a workspace with ripgrep when available, with timeout and output limits.",
      inputSchema: z.object({
        workspaceId: z.string(),
        query: z.string().min(1).max(4_096),
        cwd: z.string().default("."),
        glob: z.string().max(1_024).optional(),
      }),
      annotations: TOOL_ANNOTATIONS.repo_search,
    },
    async ({ workspaceId, query, cwd, glob }) => {
      const workspace = workspaces.get(workspaceId);
      return jsonResult(await search.search(workspace.path, query, cwd, glob));
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search local memory",
      description:
        "Search bounded, redacted snippets in the configured read-only local memory scope.",
      inputSchema: z.object({
        query: z.string().min(1).max(4_096),
        scope: z.enum(["global", "project"]).default("global"),
        project: z.string().max(128).optional(),
        maxResults: z.number().int().min(1).max(100).default(20),
      }),
      annotations: TOOL_ANNOTATIONS.memory_search,
    },
    async ({ query, scope, project, maxResults }) =>
      jsonResult(
        await memory.search(
          { scope, ...(project === undefined ? {} : { project }) },
          query,
          maxResults,
        ),
      ),
  );

  server.registerTool(
    "memory_get",
    {
      title: "Read local memory",
      description:
        "Read one allowlisted, size-limited memory file with secrets redacted from the result.",
      inputSchema: z.object({
        path: z.string().min(1),
        scope: z.enum(["global", "project"]).default("global"),
        project: z.string().max(128).optional(),
      }),
      annotations: TOOL_ANNOTATIONS.memory_get,
    },
    async ({ path, scope, project }) =>
      jsonResult(await memory.get({ scope, ...(project === undefined ? {} : { project }) }, path)),
  );

  server.registerTool(
    "memory_list",
    {
      title: "List local memory",
      description:
        "List allowlisted memory files with bounded depth, result count, and output size.",
      inputSchema: z.object({
        scope: z.enum(["global", "project"]).default("global"),
        project: z.string().max(128).optional(),
        path: z.string().default("."),
        maxDepth: z.number().int().min(0).max(20).default(4),
        maxResults: z.number().int().min(1).max(1_000).default(100),
      }),
      annotations: TOOL_ANNOTATIONS.memory_list,
    },
    async ({ scope, project, path, maxDepth, maxResults }) =>
      jsonResult(
        await memory.list(
          { scope, ...(project === undefined ? {} : { project }) },
          path,
          maxDepth,
          maxResults,
        ),
      ),
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply unified patch",
      description:
        "Apply a validated unified git diff inside the workspace and reject concurrent file changes.",
      inputSchema: z.object({ workspaceId: z.string(), patch: z.string().min(1) }),
      annotations: TOOL_ANNOTATIONS.apply_patch,
    },
    async ({ workspaceId, patch }) => {
      const workspace = workspaces.get(workspaceId);
      return jsonResult(await patches.apply(workspace.path, patch));
    },
  );

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description: "Read concise Git status without changing the repository.",
      inputSchema: z.object({ workspaceId: z.string() }),
      annotations: TOOL_ANNOTATIONS.git_status,
    },
    async ({ workspaceId }) => {
      const workspace = workspaces.get(workspaceId);
      return jsonResult(await git.status(workspace.path));
    },
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description:
        "Read a size-limited staged or unstaged Git diff without changing the repository.",
      inputSchema: z.object({
        workspaceId: z.string(),
        staged: z.boolean().default(false),
        path: z.string().optional(),
      }),
      annotations: TOOL_ANNOTATIONS.git_diff,
    },
    async ({ workspaceId, staged, path }) => {
      const workspace = workspaces.get(workspaceId);
      return jsonResult(await git.diff(workspace.path, staged, path));
    },
  );

  server.registerTool(
    "command_exec",
    {
      title: "Execute command",
      description:
        "Run an allowlisted executable with an argument array and shell disabled. Returns exitCode, stdout, stderr, durationMs, timedOut, and truncated.",
      inputSchema: z.object({
        workspaceId: z.string(),
        executable: z.string().min(1).max(512),
        args: z.array(z.string().max(32_768)).max(1_024).default([]),
        cwd: z.string().default("."),
        timeoutMs: z.number().int().positive().optional(),
      }),
      annotations: TOOL_ANNOTATIONS.command_exec,
    },
    async ({ workspaceId, executable, args, cwd, timeoutMs }) => {
      const workspace = workspaces.get(workspaceId);
      return jsonResult(
        await commands.run(workspace.path, {
          executable,
          args,
          cwd,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      );
    },
  );

  server.registerTool(
    "shell_exec",
    {
      title: "Execute shell command",
      description:
        "DANGEROUS: run a full shell command with pipes, redirects, and shell syntax. It can modify/delete files, launch processes, and access the network. Explain the command and purpose before use. Server policy still blocks known destructive or secret-access patterns.",
      inputSchema: z.object({
        workspaceId: z.string(),
        command: z.string().min(1).max(131_072),
        cwd: z.string().default("."),
        timeoutMs: z.number().int().positive().optional(),
      }),
      annotations: TOOL_ANNOTATIONS.shell_exec,
    },
    async ({ workspaceId, command, cwd, timeoutMs }) => {
      const workspace = workspaces.get(workspaceId);
      return jsonResult(
        await shell.run(workspace.path, {
          command,
          cwd,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      );
    },
  );

  if (config.codeGraphEnabled) {
    const bridge = await attachCodeGraphTools(server, {
      command: config.codeGraphCommand,
      metadataRepoRoot: pathPolicy.roots[0]!,
      resolveWorkspace: (workspaceId) => workspaces.get(workspaceId).path,
    });
    const closeParent = server.close.bind(server);
    server.close = async () => {
      try {
        await closeParent();
      } finally {
        await bridge.close();
      }
    };
  }

  return server;
}
