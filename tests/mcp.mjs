#!/usr/bin/env node
// Tests for the read-only MCP server (mcp/). SYNTHETIC board (tests/fixtures/topics-demo.json) behind a fake fetch;
// no network, nothing deployed.   node tests/mcp.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "../mcp/core.mjs";
import { topicsApi, serve } from "../mcp/node.mjs";
import { createEdgeHandler } from "../supabase/functions/grok-mcp/handler.mjs";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, "fixtures/topics-demo.json"), "utf8"));
// what PostgREST returns for the server's select (pins with day + pages embedded)
const rows = fx.pins.map(p => ({ ...p, day: { board_date: fx.days.find(d => d.id === p.day_id).board_date }, pages: fx.pages.filter(g => g.pin_id === p.id) }));
const jwt = role => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`;
const ANON = jwt("anon");

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url: String(url), method: init?.method || "GET", headers: init?.headers }); return Response.json(rows); };
  return { fn, calls };
}
function setup(opts = {}) {
  const f = fakeFetch();
  const source = M.createBoardSource({ url: "https://example.supabase.co/", anonKey: ANON, fetchFn: f.fn, topicsApi, ...opts.source });
  const handler = M.createMcpHandler({ tools: M.createTools({ source, topicsApi }), ...opts.handler });
  const rpc = async (method, params, { id = 1, headers = {} } = {}) => {
    const r = await handler(new Request(`http://x${opts.handler?.path || "/mcp"}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }));
    return { status: r.status, body: r.status === 202 ? null : await r.json() };
  };
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).body.result;
  return { f, handler, rpc, call };
}

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("initialize: protocol version negotiated, tools capability, server info; notification -> 202; ping", async () => {
  const t = setup();
  let r = await t.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(r.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.body.result.serverInfo.name, "post-it-board");
  r = await t.rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(r.body.result.protocolVersion, M.PROTOCOL_VERSIONS[0], "unknown version -> our latest");
  const n = await t.handler(new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
  assert.equal(n.status, 202);
  assert.deepEqual((await t.rpc("ping")).body.result, {});
});

test("tools/list: three read-only tools with JSON schemas", async () => {
  const { body } = await setup().rpc("tools/list");
  assert.deepEqual(body.result.tools.map(t => t.name), ["list_topics", "get_topic", "search_notes"]);
  for (const t of body.result.tools) { assert.equal(t.inputSchema.type, "object"); assert.equal(t.annotations.readOnlyHint, true); }
  assert.deepEqual(body.result.tools.find(t => t.name === "get_topic").inputSchema.required, ["name"]);
});

test("list_topics: folders newest first with note count, date, summary start, deep link; name filter", async () => {
  const t = setup();
  let r = await t.call("list_topics", {});
  assert.equal(r.isError, false);
  const out = r.structuredContent;
  assert.equal(out.total, 7);
  assert.deepEqual(out.folders.map(f => f.name).slice(0, 3), ["Garden Beds", "Porch repaint", "Weekend errands"]);
  assert.deepEqual(out.folders[0], { name: "Garden Beds", slug: "garden-beds", notes: 3, updated_at: "2026-10-17T18:20:00Z", day: "2026-10-04",
    summary_start: "Two cedar beds on the south side, 4 x 8 ft each.", link: "https://mogesjohnson.github.io/post-it-board/#view=topics&topic=garden-beds" });
  assert.equal(JSON.parse(r.content[0].text).total, 7, "text content mirrors structuredContent");
  r = await t.call("list_topics", { query: "gar" });
  assert.deepEqual(r.structuredContent.folders.map(f => f.name), ["Garden Beds", "Garage Shelves"]);
  assert.equal((await t.call("list_topics", { limit: 2 })).structuredContent.folders.length, 2);
});

test("get_topic: by name, slug or a close name -> summary + notes with dates; unknown -> found:false", async () => {
  const t = setup();
  let g = (await t.call("get_topic", { name: "garden beds" })).structuredContent;
  assert.equal(g.found, true); assert.equal(g.matched_by, "exact");
  assert.equal(g.folder.name, "Garden Beds"); assert.equal(g.folder.notes, 3);
  assert.match(g.summary.text, /Two cedar beds/); assert.equal(g.summary.updated_at, "2026-10-17T18:20:00Z");
  assert.deepEqual(g.notes.map(n => [n.page, n.title, n.created_at]), [[2, "Chat: soil and compost", "2026-10-06T19:00:00Z"], [3, "Chat: watering", "2026-10-12T08:30:00Z"]]);
  assert.equal((await t.call("get_topic", { name: "noras-10th-birthday" })).structuredContent.folder.name, "Nora's 10th Birthday");
  g = (await t.call("get_topic", { name: "the garden" })).structuredContent;
  assert.equal(g.matched_by, "closest"); assert.equal(g.folder.name, "Garden Beds");
  g = (await t.call("get_topic", { name: "shelves" })).structuredContent;
  assert.equal(g.folder.name, "Garage Shelves");
  g = (await t.call("get_topic", { name: "weekend errands" })).structuredContent;
  assert.equal(g.folder.day, "2026-10-16", "same name twice: the newest folder"); assert.deepEqual(g.other_matches, ["Weekend errands"]);
  g = (await t.call("get_topic", { name: "quantum physics" })).structuredContent;
  assert.equal(g.found, false); assert.ok(g.folders.includes("Garden Beds"));
  const bad = await t.call("get_topic", {});
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /name/);
});

test("search_notes: finds details inside summaries and notes, with snippet and folder", async () => {
  const t = setup();
  let s = (await t.call("search_notes", { query: "drip line timer" })).structuredContent;
  assert.equal(s.results[0].folder, "Garden Beds");
  s = (await t.call("search_notes", { query: "goggles" })).structuredContent;
  assert.deepEqual([s.results[0].folder, s.results[0].where], ["Nora's 10th Birthday", "page 2"]); assert.match(s.results[0].snippet, /goggles/);
  s = (await t.call("search_notes", { query: "passport" })).structuredContent;
  assert.equal(s.results[0].folder, "Weekend errands");
  assert.equal((await t.call("search_notes", { query: "zebra" })).structuredContent.results.length, 0);
  assert.equal((await t.call("search_notes", { query: "!" })).isError, true);
});

test("read-only by construction: only GETs to Supabase with the anon key, cached; non-anon keys refused", async () => {
  const t = setup();
  await t.call("list_topics", {}); await t.call("get_topic", { name: "garden" }); await t.call("search_notes", { query: "cake" });
  assert.equal(t.f.calls.length, 1, "one board read, then cached (60 s)");
  assert.equal(t.f.calls[0].method, "GET");
  assert.match(t.f.calls[0].url, /^https:\/\/example\.supabase\.co\/rest\/v1\/pins\?select=/);
  assert.equal(t.f.calls[0].headers.apikey, ANON);
  assert.throws(() => M.createBoardSource({ url: "https://x", anonKey: jwt("service_role"), topicsApi }), /not the public anon key/);
  assert.throws(() => M.createBoardSource({ url: "https://x", anonKey: "garbage", topicsApi }), /not the public anon key/);
  assert.ok(M.assertAnonKey("sb_publishable_abc"));
  const src = fs.readFileSync(path.join(here, "../mcp/core.mjs"), "utf8");
  assert.ok(!/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(src), "no write request anywhere in the server");
  // board down -> a readable tool error, not a crash
  const down = M.createTools({ source: { topics: async () => { throw new Error("HTTP 503"); } }, topicsApi });
  const r = await M.dispatch({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_topics", arguments: {} } }, down);
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /Board unavailable: HTTP 503/);
});

test("HTTP: unknown method -32601, unknown tool -32602, bad JSON -32700, batch, GET 405, wrong path 404, Origin check, optional bearer + secret path", async () => {
  let t = setup();
  assert.equal((await t.rpc("resources/list")).body.error.code, -32601);
  assert.equal((await t.rpc("tools/call", { name: "delete_everything" })).body.error.code, -32602);
  let r = await t.handler(new Request("http://x/mcp", { method: "POST", body: "{nope" }));
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, -32700);
  r = await t.handler(new Request("http://x/mcp", { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]) }));
  const batch = await r.json(); assert.deepEqual(batch.map(x => x.id), [1, 2]);
  assert.equal((await t.handler(new Request("http://x/mcp"))).status, 405);
  assert.equal((await t.handler(new Request("http://x/other", { method: "POST", body: "{}" }))).status, 404);
  assert.equal((await t.handler(new Request("http://x/mcp", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }))).status, 403);
  t = setup({ handler: { bearerToken: "s3cret", path: "/mcp-0123abcd" } });
  assert.equal((await t.rpc("ping")).status, 401);
  assert.equal((await t.rpc("ping", {}, { headers: { authorization: "Bearer s3cret" } })).status, 200);
});

test("Node adapter: a real MCP round trip over HTTP on localhost", async () => {
  const t = setup();
  const server = await serve(t.handler);
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const post = async body => (await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) })).json();
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.serverInfo.name, "post-it-board");
    const g = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_topic", arguments: { name: "Bike podcast" } } });
    assert.match(g.result.structuredContent.summary.text, /derailleur/);
  } finally { server.close(); }
});

test("Edge Function: secret path only, fails closed, anon key only, any Origin, generated copies fresh", async () => {
  const SECRET = "A".repeat(10) + "b_c-" + "9".repeat(18);
  const f = fakeFetch();
  const mk = o => createEdgeHandler({ supabaseUrl: "https://example.supabase.co", anonKey: ANON, pathSecret: SECRET, topicsApi, fetchFn: f.fn, ...o });
  const h = mk();
  const post = (p, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers = {}) =>
    h(new Request("http://x" + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  let r = await post(`/grok-mcp/${SECRET}`);
  assert.equal(r.status, 200); assert.equal((await r.json()).result.tools.length, 3);
  assert.equal((await post(`/functions/v1/grok-mcp/${SECRET}/`)).status, 200, "full path + trailing slash ok");
  assert.equal((await post(`/grok-mcp/${SECRET}`, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://grok.com" })).status, 200, "grok.com Origin allowed");
  for (const p of ["/grok-mcp", "/grok-mcp/", "/grok-mcp/mcp", `/grok-mcp/${SECRET}x`, `/grok-mcp/${SECRET.slice(0, -1)}B`, `/grok-mcp/${SECRET}/mcp`, `/other/${SECRET}`])
    assert.equal((await post(p)).status, 404, p);
  assert.equal((await h(new Request(`http://x/grok-mcp/${SECRET}`))).status, 405, "GET -> 405");
  for (const bad of [undefined, "", "short", "has space in it but long enough ok"]) {
    const hb = mk({ pathSecret: bad });
    assert.equal((await hb(new Request(`http://x/grok-mcp/${bad}`, { method: "POST", body: "{}" }))).status, 404, `secret ${bad} -> closed`);
  }
  assert.throws(() => mk({ anonKey: jwt("service_role") }), /not the public anon key/);
  assert.ok(f.calls.every(c => c.method === "GET"));
  const dir = path.join(here, "../supabase/functions/grok-mcp");
  const index = fs.readFileSync(path.join(dir, "index.ts"), "utf8");
  assert.ok(!/SERVICE_ROLE|console\./.test(index + fs.readFileSync(path.join(dir, "handler.mjs"), "utf8")), "never reads service role key, never logs");
  assert.match(fs.readFileSync(path.join(here, "../supabase/config.toml"), "utf8"), /\[functions\.grok-mcp\]\s*\n(#.*\n)*verify_jwt = false/);
  execFileSync(process.execPath, [path.join(here, "../scripts/build-mcp-function.mjs"), "--check"]);   // throws if stale
});

for (const t of tests) {
  try { await t.fn(); pass++; console.log("ok   " + t.name); }
  catch (e) { fail++; console.log("FAIL " + t.name + "\n     " + String(e.stack).split("\n").slice(0, 5).join("\n     ")); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
