#!/usr/bin/env node

import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server/index.js";
import { runHttpServer } from "./server/httpTransport.js";
// Registers all tools + prompts (side-effect imports).
import "./server/bootstrap.js";

type Transport = "stdio" | "http";

interface StartupOptions {
  transport: Transport;
  port: number;
  host: string;
}

function printUsageAndExit(message: string): never {
  console.error(`error: ${message}`);
  console.error(
    "usage: node-huckleberry-mcp [--transport <stdio|http>] [--port <n>] [--host <addr>]",
  );
  process.exit(1);
}

function parseStartupArgs(): StartupOptions {
  let parsed;
  try {
    // parseArgs reads process.argv (skipping node + script paths) by default.
    parsed = parseArgs({
      options: {
        transport: { type: "string", default: "stdio" },
        port: { type: "string" },
        host: { type: "string" },
      },
      strict: true,
    });
  } catch (err) {
    printUsageAndExit(err instanceof Error ? err.message : String(err));
  }

  const transport = parsed.values.transport;
  if (transport !== "stdio" && transport !== "http") {
    printUsageAndExit(`invalid --transport "${String(transport)}" (expected "stdio" or "http")`);
  }

  const port =
    parsed.values.port !== undefined
      ? Number(parsed.values.port)
      : Number(process.env.HUCKLEBERRY_MCP_PORT ?? 8085);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    printUsageAndExit(`invalid port "${String(parsed.values.port)}" (expected 0-65535)`);
  }

  const host = parsed.values.host ?? process.env.HUCKLEBERRY_MCP_HOST ?? "0.0.0.0";
  return { transport, port, host };
}

async function main() {
  const options = parseStartupArgs();

  if (options.transport === "http") {
    runHttpServer({
      port: options.port,
      host: options.host,
      authToken: process.env.HUCKLEBERRY_MCP_TOKEN ?? null,
    });
    // HTTP mode stays alive serving requests until the process is signalled.
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes or the process is killed.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
