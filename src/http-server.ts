import type { Server as HttpServer } from "node:http";
import type { Request, Response } from "express";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AppConfig } from "./config.js";
import { GoogleOAuthProvider } from "./auth/google-oauth-provider.js";
import { createServer } from "./server.js";

export interface RunningHttpServer {
  close(): Promise<void>;
}

export async function startAuthenticatedHttpServer(config: AppConfig): Promise<RunningHttpServer> {
  if (
    !config.authEnabled ||
    !config.googleClientId ||
    !config.googleClientSecret ||
    !config.authBaseUrl
  ) {
    throw new Error("Authenticated HTTP server requires complete OAuth configuration");
  }

  const baseUrl = config.authBaseUrl;
  const callbackUrl = new URL("/oauth/google/callback", baseUrl);
  const mcpUrl = new URL("/mcp", baseUrl);
  const provider = new GoogleOAuthProvider({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    callbackUrl,
    whitelist: config.authWhitelist,
    ...(config.oauthClientId
      ? {
          staticClient: {
            client_id: config.oauthClientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: config.oauthRedirectUris,
            token_endpoint_auth_method: config.oauthClientSecret ? "client_secret_post" : "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            ...(config.oauthClientSecret === undefined
              ? {}
              : { client_secret: config.oauthClientSecret }),
          },
        }
      : {}),
  });
  const app = createMcpExpressApp({
    host: config.httpHost,
    allowedHosts: [baseUrl.hostname],
  });
  app.set("trust proxy", "loopback");

  app.get("/oauth/google/callback", async (req: Request, res: Response) => {
    try {
      const requestUrl = new URL(req.originalUrl, baseUrl);
      const redirectUrl = await provider.completeGoogleAuthorization(requestUrl.searchParams);
      res.redirect(redirectUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Google OAuth callback failed: ${message}\n`);
      res.status(400).type("text/plain").send("OAuth callback failed");
    }
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: baseUrl,
      baseUrl,
      scopesSupported: ["mcp"],
      resourceServerUrl: mcpUrl,
      resourceName: "Local Coding Harness",
    }),
  );

  const mcpServer = await createServer(config);
  const transport = new StreamableHTTPServerTransport();
  await mcpServer.connect(transport as Transport);

  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["mcp"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  app.all("/mcp", auth, async (req: Request & { auth?: AuthInfo }, res: Response) => {
    await transport.handleRequest(req, res);
  });

  const httpServer = await listen(app, config.httpPort, config.httpHost);
  return {
    async close() {
      await Promise.all([mcpServer.close(), closeHttpServer(httpServer)]);
    },
  };
}

function listen(
  app: ReturnType<typeof createMcpExpressApp>,
  port: number,
  host: string,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
