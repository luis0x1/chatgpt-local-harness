import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const CODE_GRAPH_TOOLS = [
  "get_minimal_context_tool",
  "get_impact_radius_tool",
  "get_review_context_tool",
  "query_graph_tool",
  "detect_changes_tool",
  "get_architecture_overview_tool",
  "list_graph_stats_tool",
] as const;

type JsonSchema = Record<string, unknown>;

function schemaToZod(schema: JsonSchema): z.ZodTypeAny {
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf.map((entry) => schemaToZod(entry as JsonSchema));
    if (options.length === 1) return options[0]!;
    return z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  let result: z.ZodTypeAny;
  switch (schema.type) {
    case "string":
      result =
        Array.isArray(schema.enum) && schema.enum.length > 0
          ? z.enum(schema.enum as [string, ...string[]])
          : z.string();
      break;
    case "integer":
      result = z.number().int();
      break;
    case "number":
      result = z.number();
      break;
    case "boolean":
      result = z.boolean();
      break;
    case "null":
      result = z.null();
      break;
    case "array":
      result = z.array(schemaToZod((schema.items ?? {}) as JsonSchema));
      break;
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(properties)) {
        const field = schemaToZod(value);
        shape[key] = required.has(key) ? field : field.optional();
      }
      const object = z.object(shape);
      result = schema.additionalProperties === false ? object.strict() : object.passthrough();
      break;
    }
    default:
      result = z.unknown();
  }

  if (typeof schema.description === "string") result = result.describe(schema.description);
  return result;
}

export interface CodeGraphBridge {
  close(): Promise<void>;
}

interface CodeGraphClient {
  listTools(): ReturnType<Client["listTools"]>;
  callTool(params: Parameters<Client["callTool"]>[0]): ReturnType<Client["callTool"]>;
  close(): Promise<void>;
}

interface CodeGraphBridgeOptions {
  command: string;
  metadataRepoRoot: string;
  resolveWorkspace(workspaceId: string): string;
  clientFactory?: (repoRoot: string) => Promise<CodeGraphClient>;
}

async function connectCodeGraphClient(command: string, repoRoot: string): Promise<CodeGraphClient> {
  const client = new Client({ name: "chatgpt-local-harness-code-graph", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command,
    args: ["serve", "--repo", repoRoot, "--tools", CODE_GRAPH_TOOLS.join(",")],
    cwd: repoRoot,
    stderr: "inherit",
  });
  await client.connect(transport);
  return client;
}

export async function attachCodeGraphTools(
  server: McpServer,
  options: CodeGraphBridgeOptions,
): Promise<CodeGraphBridge> {
  const clients = new Map<string, Promise<CodeGraphClient>>();
  const createClient =
    options.clientFactory ??
    ((repoRoot: string) => connectCodeGraphClient(options.command, repoRoot));
  const metadataClient = await createClient(options.metadataRepoRoot);
  let listed: Awaited<ReturnType<Client["listTools"]>>;
  try {
    listed = await metadataClient.listTools();
  } finally {
    await metadataClient.close();
  }

  const getClient = (repoRoot: string): Promise<CodeGraphClient> => {
    const existing = clients.get(repoRoot);
    if (existing) return existing;

    const pending = createClient(repoRoot).catch((error) => {
      clients.delete(repoRoot);
      throw error;
    });
    clients.set(repoRoot, pending);
    return pending;
  };

  for (const tool of listed.tools) {
    if (!(CODE_GRAPH_TOOLS as readonly string[]).includes(tool.name)) continue;

    const inputSchema = { ...tool.inputSchema } as JsonSchema;
    const properties = { ...((inputSchema.properties ?? {}) as Record<string, JsonSchema>) };
    delete properties.repo_root;
    properties.workspaceId = {
      type: "string",
      description: "Workspace ID returned by workspace_open.",
    };
    inputSchema.properties = properties;
    const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
    inputSchema.required = [...required.filter((name) => name !== "repo_root"), "workspaceId"];

    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: `${tool.description ?? "Code review graph tool"}\n\nPass workspaceId from workspace_open; the harness resolves the repository server-side.`,
        inputSchema: schemaToZod(inputSchema),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args) => {
        const { workspaceId, ...forwarded } = args as Record<string, unknown> & {
          workspaceId: string;
        };
        const repoRoot = options.resolveWorkspace(workspaceId);
        const client = await getClient(repoRoot);
        try {
          return (await client.callTool({
            name: tool.name,
            arguments: { ...forwarded, repo_root: repoRoot },
          })) as CallToolResult;
        } catch (error) {
          clients.delete(repoRoot);
          await client.close().catch(() => undefined);
          throw error;
        }
      },
    );
  }

  return {
    async close() {
      const settled = await Promise.allSettled(clients.values());
      await Promise.all(
        settled
          .filter(
            (entry): entry is PromiseFulfilledResult<CodeGraphClient> =>
              entry.status === "fulfilled",
          )
          .map((entry) => entry.value.close()),
      );
      clients.clear();
    },
  };
}
