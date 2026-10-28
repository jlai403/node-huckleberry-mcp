#!/usr/bin/env node

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server/index.js";

// Registering prompt templates (side-effect import).
import "./server/prompts.js";

// Tool categories are registered by importing their modules.
// Each import calls registerTool() at module load time.
import "./tools/childManagement.js";
import "./tools/sleep.js";
import "./tools/feeding.js";
import "./tools/diaper.js";
import "./tools/growth.js";
import "./tools/solids.js";

/** Bearer token guarding the HTTP endpoint (HUCKLEBERRY_MCP_TOKEN). */
const MCP_AUTH_TOKEN = process.env.HUCKLEBERRY_MCP_TOKEN;
const PORT = Number(process.env.HUCKLEBERRY_MCP_PORT ?? 8085);
const HOST = process.env.HUCKLEBERRY_MCP_HOST ?? "0.0.0.0";

/**
 * Stateless streamable HTTP transport: a fresh McpServer + transport per
 * request, storing nothing between requests (clients track statelessness via
 * missing session headers). Recommended pattern for serverless-style endpoints;
 * safe to reuse from multiple clients concurrently.
 */
async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);

  const mcpServer = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.length > 0 ? JSON.parse(text) : {});
      } catch (err) {
        reject(
          new Error(
            `Invalid JSON request body: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
    req.on("error", reject);
  });
}

function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

const httpServer = createHttpServer((req, res) => {
  if (MCP_AUTH_TOKEN && req.headers.authorization !== `Bearer ${MCP_AUTH_TOKEN}`) {
    rejectUnauthorized(res);
    return;
  }

  if (req.method === "POST") {
    void handlePost(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }

  if (req.method === "GET" && req.url !== "/health") {
    // No server-initiated SSE streams in stateless mode.
    res.writeHead(405).end();
    return;
  }

  if (req.method === "DELETE") {
    res.writeHead(405).end();
    return;
  }

  // GET /health (or unknown) 200 passthrough for LB checks.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "node-huckleberry-mcp" }));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`node-huckleberry-mcp (streamable HTTP) listening on ${HOST}:${PORT}`);
  console.log(
    MCP_AUTH_TOKEN
      ? "auth: bearer token required (HUCKLEBERRY_MCP_TOKEN set)"
      : "auth: WARNING no HUCKLEBERRY_MCP_TOKEN set — endpoint open on LAN",
  );
});

// Listen handles SIGTERM/SIGINT signal handling.
process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});
