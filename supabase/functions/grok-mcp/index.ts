// Supabase Edge Function: read-only MCP server for Grok connectors (grok.com > Connectors > Custom).
// Deploy:  node scripts/build-mcp-function.mjs && supabase secrets set MCP_PATH_SECRET=<secret> \
//          && supabase functions deploy grok-mcp --no-verify-jwt   (see mcp/README.md)
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by the platform. The service-role key is deliberately never read.
import topicsApi from "./topics.mjs";
import { createEdgeHandler } from "./handler.mjs";

const handler = createEdgeHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL"),
  anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
  pathSecret: Deno.env.get("MCP_PATH_SECRET"),
  topicsApi,
});
Deno.serve(handler);
