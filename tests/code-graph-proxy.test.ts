import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { attachCodeGraphTools } from "../src/code-graph-proxy.js";

describe("code-review-graph bridge", () => {
  it("exposes workspaceId instead of repo_root and resolves the repo server-side", async () => {
    const calls: Array<{ repoRoot: string; args: Record<string, unknown> }> = [];
    const closed: string[] = [];
    const bridgeServer = new McpServer({ name: "bridge-test", version: "1.0.0" });
    const bridge = await attachCodeGraphTools(bridgeServer, {
      command: "unused",
      metadataRepoRoot: "/allowed/root",
      resolveWorkspace: (workspaceId) => {
        if (workspaceId !== "ws_test") throw new Error("Unknown workspace ID");
        return "/allowed/root/project";
      },
      clientFactory: (repoRoot) =>
        Promise.resolve({
          listTools() {
            return Promise.resolve({
              tools: [
                {
                  name: "get_architecture_overview_tool",
                  description: "Architecture overview",
                  inputSchema: {
                    type: "object" as const,
                    properties: {
                      repo_root: {
                        anyOf: [{ type: "string" }, { type: "null" }],
                        default: null,
                      },
                      detail_level: { type: "string", default: "minimal" },
                    },
                  },
                },
              ],
            });
          },
          callTool(params) {
            calls.push({
              repoRoot,
              args: params.arguments ?? {},
            });
            return Promise.resolve({ content: [{ type: "text" as const, text: "ok" }] });
          },
          close() {
            closed.push(repoRoot);
            return Promise.resolve();
          },
        }),
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridgeServer.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((entry) => entry.name === "get_architecture_overview_tool");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toHaveProperty("workspaceId");
      expect(tool?.inputSchema.properties).not.toHaveProperty("repo_root");
      expect(tool?.inputSchema.required).toContain("workspaceId");

      const result = await client.callTool({
        name: "get_architecture_overview_tool",
        arguments: { workspaceId: "ws_test", detail_level: "minimal" },
      });
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(calls).toEqual([
        {
          repoRoot: "/allowed/root/project",
          args: { detail_level: "minimal", repo_root: "/allowed/root/project" },
        },
      ]);
    } finally {
      await Promise.all([client.close(), bridgeServer.close(), bridge.close()]);
    }
    expect(closed).toContain("/allowed/root");
    expect(closed).toContain("/allowed/root/project");
  });
});
