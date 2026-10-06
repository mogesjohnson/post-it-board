// In-memory stand-in for the Supabase calls scripts/post.mjs makes: the GoTrue password grant and
// PostgREST GET/POST/PATCH/DELETE on days/pins/pages (eq./in. filters, order=, cascade deletes).
// No dependencies. Connections use HTTP keep-alive, like the real API.
//
//   import { startMock } from "./mock.mjs"; const mock = await startMock(); mock.url ...
//   node tests/mock.mjs 54321      # standalone, controlled over HTTP (used by tests/workflow.sh):
//     POST /_ctl/reset · POST /_ctl/fail {match, status, times, skip} · POST /_ctl/backdate {table, id|"*", minutes}
//     POST /_ctl/seed {table, row} · GET /_ctl/state
//   fail.match is "AUTH", "*" or "<METHOD> <path>", e.g. "POST /rest/v1/pages".
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const TABLES = ["days", "pins", "pages"];
const FK = { pins: ["days", "day_id"], pages: ["pins", "pin_id"] };

export function createMock() {
  let db, fails;
  const api = {
    get db() { return db; },
    reset() { db = { days: [], pins: [], pages: [] }; fails = []; },
    fail(f) { fails.push({ times: 1, skip: 0, status: 500, ...f }); },
    clearFail() { fails = []; },
    seed(table, row) { const r = { id: randomUUID(), created_at: new Date().toISOString(), ...row }; db[table].push(r); return r; },
    backdate(table, id, minutes) {
      for (const r of db[table]) if (id === "*" || r.id === id) r.created_at = new Date(Date.now() - minutes * 60000).toISOString();
    },
  };
  api.reset();

  function cascade(table, ids) {
    if (table === "days") cascade("pins", new Set(db.pins.filter(p => ids.has(p.day_id)).map(p => p.id)));
    if (table === "pins") db.pages = db.pages.filter(p => !ids.has(p.pin_id));
    db[table] = db[table].filter(r => !ids.has(r.id));
  }
  function matchRow(row, params) {
    for (const [k, v] of params) {
      if (["select", "order", "limit"].includes(k)) continue;
      const m = /^(eq|in)\.(.*)$/s.exec(v);
      if (!m) continue;
      if (m[1] === "eq") { if (String(row[k]) !== m[2]) return false; }
      else if (!m[2].replace(/^\(|\)$/g, "").split(",").map(s => s.replace(/^"|"$/g, "")).includes(String(row[k]))) return false;
    }
    return true;
  }
  function order(rows, spec) {
    if (!spec) return rows;
    const keys = spec.split(",").map(s => { const [c, d] = s.split("."); return [c, d === "desc" ? -1 : 1]; });
    return [...rows].sort((a, b) => {
      for (const [c, d] of keys) {
        const x = a[c], y = b[c];
        if (x === y) continue;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : 1) * d;
      }
      return 0;
    });
  }
  const send = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const readBody = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });

  api.server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const raw = await readBody(req);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }

    if (u.pathname.startsWith("/_ctl/")) {
      const op = u.pathname.slice(6);
      if (op === "reset") { api.reset(); return send(res, 200, { ok: true }); }
      if (op === "state") return send(res, 200, db);
      if (op === "clearfail") { api.clearFail(); return send(res, 200, { ok: true }); }
      if (op === "fail") { api.fail(body); return send(res, 200, { ok: true }); }
      if (op === "seed") return send(res, 200, api.seed(body.table, body.row));
      if (op === "backdate") { api.backdate(body.table, body.id, body.minutes); return send(res, 200, { ok: true }); }
      return send(res, 404, { message: "no such ctl" });
    }

    const isAuth = u.pathname === "/auth/v1/token";
    const key = isAuth ? "AUTH" : `${req.method} ${u.pathname}`;
    for (const f of fails) {
      if (f.match !== "*" && f.match !== key) continue;
      if (f.skip > 0) { f.skip--; continue; }
      if (f.times <= 0) continue;
      f.times--;
      return send(res, f.status, { message: "injected failure", error_description: "injected failure" });
    }
    if (isAuth) return send(res, 200, { access_token: "tok", token_type: "bearer" });

    const m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
    if (!m || !TABLES.includes(m[1])) return send(res, 404, { message: "not found" });
    const t = m[1], params = [...u.searchParams.entries()];
    if (req.method === "GET") return send(res, 200, order(db[t].filter(r => matchRow(r, params)), u.searchParams.get("order")));
    if (req.method === "POST") {
      const out = [];
      for (const it of Array.isArray(body) ? body : [body]) {
        if (FK[t] && !db[FK[t][0]].some(r => r.id === it[FK[t][1]])) return send(res, 409, { message: "fk violation" });
        if (t === "days" && db.days.some(d => d.board_date === it.board_date)) return send(res, 409, { message: "duplicate key value violates unique constraint" });
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...it };
        db[t].push(row); out.push(row);
      }
      return send(res, 201, out);
    }
    if (req.method === "PATCH") {
      const rows = db[t].filter(r => matchRow(r, params));
      rows.forEach(r => Object.assign(r, body));
      return send(res, 200, rows);
    }
    if (req.method === "DELETE") {
      const rows = db[t].filter(r => matchRow(r, params));
      cascade(t, new Set(rows.map(r => r.id)));
      return send(res, 200, rows);
    }
    send(res, 405, { message: "method not allowed" });
  });

  api.listen = (port = 0) => new Promise(r => api.server.listen(port, "127.0.0.1", () => {
    api.url = `http://127.0.0.1:${api.server.address().port}`;
    r(api);
  }));
  api.close = () => new Promise(r => { api.server.closeAllConnections?.(); api.server.close(() => r()); });
  return api;
}

export const startMock = (port = 0) => createMock().listen(port);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mock = await startMock(Number(process.argv[2] || 54321));
  console.error(`mock listening on ${mock.url}`);
}
