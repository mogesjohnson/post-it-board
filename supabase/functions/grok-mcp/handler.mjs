// Edge wrapper for the read-only Post-it Board MCP server (no Deno/Node APIs here, so the Node tests can import it).
// - Public anon key only: createBoardSource refuses any other key (service_role is never read).
// - Secret path: only POST/GET .../grok-mcp/<MCP_PATH_SECRET> reaches the MCP handler; anything else is a bare 404.
//   The secret lives in a Supabase function secret, never in the repo. Unset/short secret -> every request 404 (fail closed).
// - Nothing is logged.
import { createBoardSource, createTools, createMcpHandler } from "./core.mjs";

export const FUNCTION_NAME = "grok-mcp";
const notFound = () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });

function sameSecret(a, b) {           // constant-time compare
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function createEdgeHandler({ supabaseUrl, anonKey, pathSecret, topicsApi, fetchFn = undefined }) {
  const secret = String(pathSecret || "");
  const ready = /^[A-Za-z0-9_-]{24,}$/.test(secret);
  // grok.com calls from its servers; this server has no cookies or credentials, so any Origin is fine
  const mcp = ready ? createMcpHandler({
    tools: createTools({ source: createBoardSource({ url: supabaseUrl, anonKey, fetchFn, topicsApi }), topicsApi }),
    path: "/mcp", allowedOrigins: "*",
  }) : null;
  return async function handle(req) {
    if (!mcp) return notFound();
    const url = new URL(req.url);
    // hosted runtime sees /grok-mcp/<secret>; accept /functions/v1/grok-mcp/<secret> too (local serve, proxies)
    const m = url.pathname.replace(/\/+$/, "").match(new RegExp(`^(?:/functions/v1)?/${FUNCTION_NAME}/([^/]+)$`));
    if (!m || !sameSecret(m[1], secret)) return notFound();
    url.pathname = "/mcp";
    return mcp(new Request(url, req));
  };
}
