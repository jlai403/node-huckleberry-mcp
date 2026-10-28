// Streamable-HTTP transport runner. Stateless mode: a fresh McpServer +
// StreamableHTTPServerTransport per request, storing nothing between requests
// (clients track statelessness via missing session headers). Recommended
// pattern for serverless-style endpoints; safe for multiple concurrent
// clients.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./index.js";

export interface HttpTransportOptions {
  port: number;
  host: string;
  /** Bearer token guarding the endpoint, or null for an open endpoint. */
  authToken: string | null;
}

/**
 * Handles a POST request by creating a throwaway McpServer + transport pair,
 * serving exactly one JSON-RPC message, and discarding both on response close.
 */
async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  serverFactory: () => Server,
): Promise<void> {
  const body = await readBody(req);

  const mcpServer = serverFactory();
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

/** Starts the HTTP server and keeps the process alive until SIGTERM/SIGINT. */
export function runHttpServer(options: HttpTransportOptions): void {
  if (options.authToken === null) {
    console.warn("auth: WARNING no HUCKLEBERRY_MCP_TOKEN set — endpoint open on LAN");
  }

  const httpServer = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      // Auth exempt: exposes nothing; exists for LB/container probes.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "node-huckleberry-mcp" }));
      return;
    }

    if (options.authToken !== null && req.headers.authorization !== `Bearer ${options.authToken}`) {
      rejectUnauthorized(res);
      return;
    }

    if (req.method === "POST") {
      void handlePost(req, res, createServer).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }

    if (req.method === "GET") {
      // No server-initiated SSE streams in stateless mode.
      res.writeHead(405).end();
      return;
    }

    if (req.method === "DELETE") {
      res.writeHead(405).end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "node-huckleberry-mcp" }));
  });

  httpServer.listen(options.port, options.host, () => {
    console.log(
      `node-huckleberry-mcp (streamable HTTP) listening on ${options.host}:${options.port}`,
    );
    console.log(
      options.authToken !== null
        ? "auth: bearer token required (HUCKLEBERRY_MCP_TOKEN set)"
        : "auth: WARNING no HUCKLEBERRY_MCP_TOKEN set — endpoint open on LAN",
    );
  });

  // Keep the container runner in control of lifecycle signals.
  process.on("SIGTERM", () => {
    httpServer.close(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    httpServer.close(() => process.exit(0));
  });
}
