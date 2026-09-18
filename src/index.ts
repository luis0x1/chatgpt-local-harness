#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { startAuthenticatedHttpServer } from "./http-server.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  process.stderr.write(`Authentication required: ${config.authEnabled ? "yes" : "no"}.\n`);
  if (config.authEnabled) {
    await startAuthenticatedHttpServer(config);
    return;
  }

  const server = await createServer(config);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start local coding harness: ${message}\n`);
  process.exitCode = 1;
});
