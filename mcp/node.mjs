#!/usr/bin/env node
// Run the read-only Post-it Board MCP server locally (Node 18+, no dependencies). NOT for public deployment as is.
//   node mcp/node.mjs [--port 8788]          -> http://127.0.0.1:8788/mcp
// Env: BOARD_SUPABASE_URL + BOARD_SUPABASE_ANON_KEY (else parsed from ../config.js, the site's public config),
//      MCP_PATH (default /mcp; e.g. /mcp-<random> as a secret path), MCP_BEARER_TOKEN (optional), MCP_HOST (127.0.0.1).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createBoardSource, createTools, createMcpHandler } from "./core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const topicsApi = createRequire(import.meta.url)("../topics.js");

export function boardConfig(env = process.env) {
  let url = env.BOARD_SUPABASE_URL, key = env.BOARD_SUPABASE_ANON_KEY;
  if (!url || !key) {
    const text = fs.readFileSync(path.join(here, "../config.js"), "utf8");
    url ||= /SUPABASE_URL:\s*["']([^"']+)["']/.exec(text)?.[1];
    key ||= /SUPABASE_ANON_KEY:\s*["']([^"']+)["']/.exec(text)?.[1];
  }
  return { url, anonKey: key };
}

// Node http <-> web Request/Response
export function serve(handler, { port = 0, host = "127.0.0.1" } = {}) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handler(new Request(`http://${req.headers.host || host}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const port = Number(a.includes("--port") ? a[a.indexOf("--port") + 1] : 8788);
  const source = createBoardSource({ ...boardConfig(), topicsApi });
  const handler = createMcpHandler({ tools: createTools({ source, topicsApi }), path: process.env.MCP_PATH || "/mcp", bearerToken: process.env.MCP_BEARER_TOKEN || "" });
  const host = process.env.MCP_HOST || "127.0.0.1";
  const server = await serve(handler, { port, host });
  console.log(`post-it-board MCP (read-only) on http://${host}:${server.address().port}${process.env.MCP_PATH || "/mcp"}`);
}
