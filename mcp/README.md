# Read-only MCP server: Grok ↔ Post-it Board

**Status: a draft that runs locally only. It is NOT deployed anywhere.** This server lets Grok (grok.com, the Grok app, and possibly Ara in the car) read the board's topic folders. It can't write anything.

## What Grok gets

| Tool | Input | Returns |
|---|---|---|
| `list_topics` | `query?`, `limit?` | Each folder's name, note count, last-updated date, the start of its summary, and a deep link (`#view=topics&topic=<slug>`) |
| `get_topic` | `name` (folder name, slug, or a rough name like "the garden") | The living summary (page 1) and every note (pages 2..n) with their dates, plus other folders with the same name |
| `search_notes` | `query` | Folders whose summaries or notes mention the words, with a snippet |

So "what did we say about the garden beds?" → `get_topic("garden beds")` → Grok answers from that folder.

## How it stays read-only and safe

- It only uses the **public anon key**, the same one already in `config.js` for the public site. It refuses to start with a `service_role` or any other key (`assertAnonKey`).
- It makes **GET requests only** (`/rest/v1/pins?select=…`). There's no write path anywhere in the code, and the tests check this. Row-level security (RLS) would block anon writes anyway.
- Results are cached for 60 s, so each chat turn costs about one board read.
- Optional protections: `MCP_BEARER_TOKEN` (for clients that can send a header: the xAI API and the grok CLI), a secret `MCP_PATH` (for grok.com, which only does OAuth), and an `Origin` allow-list.

## Run it locally

```bash
node mcp/node.mjs --port 8788            # reads SUPABASE_URL / SUPABASE_ANON_KEY, or falls back to ../config.js
node tests/mcp.mjs                       # 8 tests, synthetic fixture, no network
```

Local clients can point straight at `http://127.0.0.1:8788/mcp`, for example `grok mcp add` in the grok CLI or the MCP Inspector. Also verified with the official `@modelcontextprotocol/sdk` 1.32.1 client (Streamable HTTP).

## Research: ways to connect grok.com to the board

1. **grok.com custom connector → remote MCP server (recommended).** grok.com → Connectors → New Connector → Custom takes a remote MCP server URL (Streamable HTTP or SSE).
   - The server **must be reachable from the public internet**. `localhost` is rejected, so a local server needs a tunnel.
   - The consumer form offers OAuth 2.0 + PKCE or no auth. There's no static-header option, which is why the secret path exists.
   - Connectors set up in the Grok app also carry over to Grok in a Tesla (software 2026.26+). Whether *custom* MCP connectors work in the car or with Ara is not confirmed by xAI.
   - Sources: https://docs.x.ai/grok/connectors · https://docs.x.ai/grok/connectors/custom-mcp-tunneling · https://docs.x.ai/grok/connector-management · https://x.ai/news/grok-connectors · https://www.tesla.com/support/grok · https://www.frunklab.com/news/grok-bot-connectors-in-tesla · OAuth-only notes: https://github.com/twentytwohundred/wiki/blob/main/grok-connector-setup.md, https://massive.com/docs/ai-tools/clients/grok · plan tier (third-party): https://www.context-link.ai/blog/grok-custom-connector
2. **xAI API remote MCP tool / grok CLI.** Same server, but you pass a `server_url` and an `authorization` header per request. Good for scripts, not for the grok.com chat UI. Sources: https://docs.x.ai/developers/tools/remote-mcp · https://docs.x.ai/build/features/mcp-servers
3. **Zero build: a public URL.** The board is already world-readable: the public Pages site, plus a Supabase REST URL that takes the anon key as `?apikey=`. Grok can be given a link to read. It's fragile, and it's unverified whether Grok's browsing fetches JSON.

### Hosting the server (if you decide to)

| Host | Free tier | Notes |
|---|---|---|
| **Supabase Edge Function** (same project) | 500k invocations/month, 2 s CPU | No new account or secret. `core.mjs` is runtime-neutral (web `Request`→`Response`), so you'd write a ~10-line `Deno.serve` wrapper. Docs: https://supabase.com/docs/guides/functions/examples/mcp-server-mcp-lite · https://supabase.com/docs/guides/ai-tools/byo-mcp · limits: https://supabase.com/docs/guides/functions/limits · https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations |
| Cloudflare Worker | 100k requests/day, 10 ms CPU | Needs a new account. Limits: https://developers.cloudflare.com/workers/platform/limits/ |
| Your PC + tunnel (ngrok/cloudflared) | free | Only works while the PC is on. https://ngrok.com/docs/gateway/api-gateway/mcp-gateway |

## Privacy: decide before deploying

The board content is **already public** (RLS `select using (true)` plus the public site). A no-auth, read-only connector **exposes nothing new**, but it makes the content much easier to find. If the board should become private, that means:
1. RLS limited to signed-in users
2. a login on the site
3. OAuth on this server

That's a bigger project.
