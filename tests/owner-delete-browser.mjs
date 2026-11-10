#!/usr/bin/env node
// Synthetic-only browser coverage; fake Auth + PostgREST, never the live database.
// PLAYWRIGHT_CORE=/path/to/playwright-core node tests/owner-delete-browser.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");
const t = "2026-10-10T12:00:00Z";
const makeDb = () => ({
  days: [1, 2].map(n => ({ id: "d" + n, board_date: "2026-10-0" + n })),
  pins: [1, 2].map(n => ({ id: "p" + n, day_id: "d" + n, title: "Test folder", color: "yellow", created_at: t, updated_at: t })),
  pages: [1, 2].flatMap(n => [0, 1].map(i => ({ id: "g" + n + i, pin_id: "p" + n,
    title: i ? "Conversation " + n : "Summary " + n, body: "Synthetic test content", position: i, created_at: t, updated_at: t }))),
});
let db = makeDb(), deletes = [], denyDelete = false, denyOwnerCheck = false, submittedPassword;
const session = id => ({ access_token: "fake-" + id, refresh_token: "fake-refresh", expires_in: 3600,
  user: { id, email: id + "@example.test" } });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const json = (value, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (u.pathname === "/config.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(`window.POSTIT_CONFIG={SUPABASE_URL:"http://127.0.0.1:${server.address().port}",SUPABASE_ANON_KEY:"synthetic-public-key-for-testing"};`);
  }
  if (u.pathname === "/auth/v1/token") {
    let body = ""; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); submittedPassword = data.password;
    if (data.email === "invalid@example.test") return json({ msg: "Invalid login credentials" }, 400);
    return json(session(data.email.startsWith("owner") ? "owner" : "visitor"));
  }
  if (u.pathname === "/auth/v1/logout") return json({});
  if (u.pathname.startsWith("/rest/v1/")) {
    const table = u.pathname.split("/").pop();
    const owner = req.headers.authorization === "Bearer fake-owner";
    if (table === "board_owners") return denyOwnerCheck ? json({ message: "Owner check unavailable" }, 503) : json(owner ? [{ user_id: "owner" }] : []);
    const match = row => ["id", "day_id", "pin_id"].every(key => {
      const q = u.searchParams.get(key);
      return !q || (q.startsWith("eq.") ? row[key] === q.slice(3) : q === "in.(" + row[key] + ")");
    });
    if (req.method === "DELETE") {
      if (!owner || denyDelete) return json({ message: "Not allowed" }, 403);
      const removed = db[table].filter(match); deletes.push({ table, ids: removed.map(r => r.id) });
      db[table] = db[table].filter(r => !match(r));
      if (table === "pins") db.pages = db.pages.filter(g => !removed.some(p => p.id === g.pin_id));
      return json(removed);
    }
    if (table === "pins") return json(db.pins.filter(match).map(p => ({ ...p,
      day: db.days.find(d => d.id === p.day_id), pages: u.searchParams.get("select").includes("pages(count)")
        ? [{ count: db.pages.filter(g => g.pin_id === p.id).length }] : db.pages.filter(g => g.pin_id === p.id),
    })));
    return json(db[table].filter(match));
  }
  const file = path.join(root, u.pathname === "/" ? "index.html" : u.pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html" })[path.extname(file)] || "text/plain" });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
let pass = 0;
async function step(name, fn) { await fn(); pass++; console.log("ok   " + name); }
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route(u => !String(u).startsWith(base), r => r.abort());
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message)); return page;
}
async function login(page, who, password = " test password ") {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(who + "@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.locator("#modalOk").click();
}
async function dialogClick(page, button, accept, contains) {
  const handled = new Promise((resolve, reject) => page.once("dialog", async d => {
    try { assert.match(d.message(), contains); await (accept ? d.accept() : d.dismiss()); resolve(); } catch (e) { reject(e); }
  }));
  await button.click(); await handled;
}
try {
  const page = await newPage(); await page.goto(base + "#view=topics"); await page.locator(".folder-tree").waitFor();
  await step("anon sees Sign in, no editing/deletion tools", async () => {
    assert.equal(await page.locator(".danger").count(), 0); assert.equal(await page.locator("#addBtn").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Sign in", exact: true }).isVisible(), true);
  });
  await step("invalid login keeps dialog open and read-only", async () => {
    await login(page, "invalid"); await page.locator("#modalError:not([hidden])").waitFor();
    assert.match(await page.locator("#modalError").textContent(), /Invalid login/); assert.equal(await page.locator(".danger").count(), 0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
  await step("signed-in non-owner stays read-only and can sign out", async () => {
    await login(page, "visitor"); await page.locator("#modal").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".danger").count(), 0); assert.equal(await page.locator("#addBtn").isVisible(), false);
    await dialogClick(page, page.getByRole("button", { name: "Sign out", exact: true }), true, /Sign out/);
  });
  await step("owner verification enables deletes; password whitespace preserved and field cleared", async () => {
    await login(page, "owner"); await page.locator("#modal").waitFor({ state: "hidden" });
    assert.equal(submittedPassword, " test password "); assert.equal(await page.locator("#f_password").inputValue(), "");
    assert.equal(await page.locator(".folder-heading .danger").count(), 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  });
  const folder = page.locator('.folder[data-slug="test-folder-p1"]');
  await step("folder cancel names item and date; no delete request", async () => {
    await dialogClick(page, folder.locator(".folder-heading .danger"), false, /Test folder.*Oct 1, 2026.*ALL its notes/s);
    assert.equal(deletes.length, 0); assert.equal(db.pins.length, 2);
  });
  await step("server refusal keeps folder and shows a useful error", async () => {
    denyDelete = true;
    await dialogClick(page, folder.locator(".folder-heading .danger"), true, /Test folder/);
    await page.waitForFunction(() => /Not allowed/.test(document.querySelector("#toast").textContent));
    assert.equal(db.pins.length, 2); assert.equal(deletes.length, 0); denyDelete = false;
  });
  await folder.locator(".folder-row").click();
  await step("conversation cancel then delete refreshes folder, preserving summary and duplicate folder", async () => {
    const button = page.getByRole("button", { name: "Delete note Conversation 1 from Test folder", exact: true });
    await dialogClick(page, button, false, /Conversation 1.*Test folder/s); assert.equal(db.pages.length, 4);
    await dialogClick(page, button, true, /Conversation 1/);
    await page.waitForFunction(() => !document.querySelector('[aria-label="Delete note Conversation 1 from Test folder"]'));
    assert.deepEqual(deletes.pop(), { table: "pages", ids: ["g11"] }); assert.equal(db.pages.length, 3);
  });
  await step("delete summary uses the summary page id, not the whole folder", async () => {
    await dialogClick(page, page.getByRole("button", { name: "Delete note Summary 1 from Test folder", exact: true }), true, /Summary 1/);
    await page.waitForFunction(() => !document.querySelector('[aria-label="Delete note Summary 1 from Test folder"]'));
    assert.deepEqual(deletes.pop(), { table: "pages", ids: ["g10"] }); assert.equal(db.pins.length, 2);
  });
  await step("folder delete targets exactly one pin id, not duplicate title; cascade scoped", async () => {
    await dialogClick(page, folder.locator(".folder-heading .danger"), true, /Test folder.*ALL its notes/s);
    await page.waitForFunction(() => document.querySelectorAll(".folder").length === 1);
    assert.deepEqual(deletes.pop(), { table: "pins", ids: ["p1"] }); assert.deepEqual(db.pins.map(p => p.id), ["p2"]);
    assert.equal(db.pages.length, 2); assert.equal(new URL(page.url()).hash, "#view=topics");
  });
  await step("owner session reload is reverified; day view direct delete and empty pager refresh", async () => {
    await page.reload(); await page.locator(".folder-heading .danger").waitFor();
    await page.locator(".folder-row").click(); await page.getByRole("button", { name: "Open on its day ›" }).click();
    await page.locator(".page-strip").waitFor();
    await dialogClick(page, page.getByRole("button", { name: "Delete note Conversation 2 from Test folder", exact: true }), true, /Conversation 2/);
    await page.waitForFunction(() => document.querySelectorAll(".page-chip").length === 1);
    assert.equal(db.pages.length, 1);
    await dialogClick(page, page.getByRole("button", { name: "Delete folder Test folder", exact: true }), true, /ALL its notes/);
    await page.locator(".empty").waitFor(); assert.equal(db.pins.length, 0); assert.equal(db.pages.length, 0);
    assert.equal(new URL(page.url()).hash, "#view=topics");
  });
  await step("cross-tab account switch immediately removes owner tools", async () => {
    db = makeDb(); await page.reload(); await page.locator(".folder-heading .danger").first().waitFor();
    const other = await page.context().newPage(); await other.goto(base);
    await other.evaluate(s => localStorage.setItem("postit.session.v1", JSON.stringify(s)), session("visitor"));
    await page.waitForFunction(() => !document.body.classList.contains("can-edit")); assert.equal(await page.locator(".danger").count(), 0);
    await other.close();
  });
  await page.context().close();
  await step("owner-check outage fails closed on startup", async () => {
    denyOwnerCheck = true; const p = await newPage();
    await p.context().addInitScript(s => localStorage.setItem("postit.session.v1", JSON.stringify(s)), session("owner"));
    await p.goto(base + "#view=topics"); await p.locator(".folder-tree").waitFor();
    assert.equal(await p.locator(".danger").count(), 0); assert.equal(await p.locator("#addBtn").isVisible(), false);
    await p.context().close(); denyOwnerCheck = false;
  });
  assert.deepEqual(errors, []); console.log(`\n${pass} passed, 0 failed; synthetic Auth/PostgREST only`);
} finally { await browser.close(); await new Promise(r => server.close(r)); }
