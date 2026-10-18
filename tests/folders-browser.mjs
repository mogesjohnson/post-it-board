#!/usr/bin/env node
// Browser check of the Topics folder view, on a SYNTHETIC demo board (tests/fixtures/topics-demo.json) in demo
// (localStorage) mode: the real config.js is replaced by an empty one, so no real note is ever loaded.
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome node tests/folders-browser.mjs [--shot out.png]
// Needs playwright-core and a Chrome/Chromium; prints "skipped" (exit 0) when they are missing.
// Fails on any console error / page error, or a request to *.supabase.co.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const shot = args.includes("--shot") ? args[args.indexOf("--shot") + 1] : null;
const require = createRequire(import.meta.url);
let chromium;
for (const p of [process.env.PLAYWRIGHT_CORE, "playwright-core", "playwright"].filter(Boolean)) {
  try { ({ chromium } = require(p)); break; } catch {}
}
const chrome = process.env.CHROME || "/usr/bin/google-chrome";
if (!chromium || !fs.existsSync(chrome)) { console.log("skipped: playwright-core or Chrome not found (set PLAYWRIGHT_CORE / CHROME)"); process.exit(0); }

const fixture = fs.readFileSync(path.join(root, "tests/fixtures/topics-demo.json"), "utf8");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("window.POSTIT_CONFIG = {};\n"); } // demo mode
  const file = path.join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const errors = [], supabase = [];
let pass = 0;
async function newPage(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, timezoneId: "America/New_York", locale: "en-US" });
  await ctx.addInitScript(fx => { if (!localStorage.getItem("postit.demo.v1")) localStorage.setItem("postit.demo.v1", fx); }, fixture);
  // offline except our server (fonts may fail silently; they are not console errors)
  await ctx.route(u => !String(u).startsWith(base), route => { if (/supabase\.co/.test(route.request().url())) supabase.push(route.request().url()); return route.abort(); });
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource: net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  return page;
}
async function step(name, fn) { await fn(); pass++; console.log("ok   " + name); }
const folderNames = page => page.locator(".folder-name").allTextContents();

try {
  const page = await newPage();
  await page.goto(base + "#view=topics");
  await page.locator(".folder-tree").waitFor();

  await step("Topics = folder tree: every topic a folder (name, note count, last updated), newest first, all closed", async () => {
    assert.deepEqual(await folderNames(page), ["Garden Beds", "Porch repaint", "Weekend errands", "Nora's 10th Birthday", "Garage Shelves", "Weekend errands", "Bike podcast"]);
    assert.equal(await page.locator(".folder-total").textContent(), "7 folders");
    const first = page.locator(".folder").first();
    assert.equal(await first.locator(".folder-badge").textContent(), "3 notes");
    assert.equal(await first.locator(".folder-updated").textContent(), "Updated Oct 17, 2026");
    assert.equal(await page.locator(".folder").nth(1).locator(".folder-badge").textContent(), "0 notes");
    assert.equal(await page.locator(".folder").nth(3).locator(".folder-badge").textContent(), "2 notes");
    assert.equal(await page.locator(".folder.open").count(), 0);
    assert.equal(await page.locator("#topicsTab").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".banner").isVisible(), true, "demo mode banner: fixtures, not the real board");
  });

  await step("search by folder name narrows the tree and keeps typing focus; Esc clears", async () => {
    const s = page.getByRole("searchbox", { name: "Search topic folders by name" });
    await s.click(); await s.pressSequentially("gar");
    assert.deepEqual(await folderNames(page), ["Garden Beds", "Garage Shelves"]);
    assert.equal(await page.locator(".folder-total").textContent(), "2 of 7 folders");
    assert.equal(await page.evaluate(() => document.activeElement.id), "folderSearch");
    await s.pressSequentially("xyz");
    assert.match(await page.locator(".folder-none").textContent(), /No folder name matches “garxyz”/);
    await s.press("Escape");
    assert.equal((await folderNames(page)).length, 7);
  });

  await step("open a folder: living summary + the notes filed in it, with dates; URL gets #view=topics&topic=<slug>", async () => {
    await page.getByRole("button", { name: /Garden Beds/ }).click();
    const f = page.locator(".folder.open");
    assert.equal(await f.count(), 1);
    assert.equal(await f.locator(".folder-row").getAttribute("aria-expanded"), "true");
    const files = f.locator(".file");
    assert.equal(await files.count(), 3);
    assert.match(await files.nth(0).textContent(), /Summary.*living summary.*Updated Oct 17, 2026.*Two cedar beds/s);
    assert.match(await files.nth(1).locator(".file-head").textContent(), /Page 2 · Chat: soil and compost.*Oct 6, 2026/);
    assert.match(await files.nth(2).locator(".file-head").textContent(), /Page 3 · Chat: watering.*Oct 12, 2026.*edited Oct 13, 2026/);
    assert.match(await f.locator(".folder-day").textContent(), /Pinned on .*Oct 4, 2026/);
    assert.equal(new URL(page.url()).hash, "#view=topics&topic=garden-beds");
    if (shot) await page.screenshot({ path: shot, fullPage: true });
  });

  await step("a note's Open › opens that page of the pin; ← Topics comes back with the folder still open", async () => {
    await page.getByRole("button", { name: "Open page 3 of Garden Beds" }).click();
    await page.locator(".page-paper").waitFor();
    assert.match(await page.locator(".page-no").textContent(), /Page 3 of 3/);
    assert.match(new URL(page.url()).hash, /day=2026-10-04&pin=p-garden&page=3&from=topics/);
    await page.getByRole("button", { name: "← Topics" }).click();
    await page.locator(".folder-tree").waitFor();
    assert.equal(await page.locator(".folder.open .folder-name").textContent(), "Garden Beds");
    await page.locator(".folder.open .folder-row").click(); // close
    assert.equal(await page.locator(".folder.open").count(), 0);
    assert.equal(new URL(page.url()).hash, "#view=topics");
  });

  await step("Days view still works (board, open a pin, back)", async () => {
    await page.locator("#daysTab").click();
    await page.locator(".notes .note").first().waitFor();
    assert.ok((await page.locator(".notes .note h3").allTextContents()).length >= 1);
    await page.locator(".notes .note").first().click();
    await page.locator(".page-paper").waitFor();
    await page.getByRole("button", { name: "← All pins" }).click();
    await page.locator(".notes").waitFor();
  });

  await step("deep link #view=topics&topic=<slug> opens and scrolls to that folder (fresh load); duplicate names get unique slugs", async () => {
    const p2 = await newPage({ width: 1280, height: 500 });
    await p2.goto(base + "#view=topics&topic=bike-podcast");
    await p2.locator(".folder.open").waitFor();
    assert.equal(await p2.locator(".folder.open .folder-name").textContent(), "Bike podcast");
    assert.ok(await p2.locator(".folder.open .folder-row").evaluate(n => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), "scrolled into view");
    const slugs = await p2.locator(".folder[data-slug^=weekend-errands]").evaluateAll(ns => ns.map(n => n.dataset.slug));
    assert.deepEqual(slugs, ["weekend-errands-perrands2", "weekend-errands-perrands1"], "two 'Weekend errands' folders, two different slugs");
    assert.deepEqual(await p2.locator(".folder[data-slug^=weekend-errands] .folder-day-tag").allTextContents(), ["Fri, Oct 16, 2026", "Sun, Oct 4, 2026"], "same name: the day tells them apart");
    assert.equal(await p2.locator(".folder[data-slug=bike-podcast] .folder-day-tag").count(), 0);
    await p2.evaluate(() => { location.hash = "#view=topics&topic=weekend-errands-perrands1"; }); // a link edited by hand (hashchange)
    await p2.waitForFunction(() => document.querySelector('.folder[data-slug="weekend-errands-perrands1"].open'));
    assert.match(await p2.locator('.folder[data-slug="weekend-errands-perrands1"] .file-body').textContent(), /Dry cleaning/);
    await p2.goto(base + "#view=topics&topic=no-such-folder");
    await p2.locator(".toast:not([hidden])").waitFor();
    assert.match(await p2.locator(".toast").textContent(), /No topic folder called “no-such-folder”/);
    await p2.context().close();
  });

  await step("phone width: folders stack without horizontal overflow", async () => {
    const p3 = await newPage({ width: 390, height: 844 });
    await p3.goto(base + "#view=topics&topic=noras-10th-birthday");
    await p3.locator(".folder.open").waitFor();
    assert.ok(await p3.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal scroll");
    if (shot) await p3.screenshot({ path: shot.replace(/(\.\w+)$/, "-mobile$1"), fullPage: false });
    await p3.context().close();
  });

  assert.deepEqual(errors, [], "no console errors");
  assert.deepEqual(supabase, [], "no request to Supabase (fixtures only)");
  console.log(`\n${pass} passed, 0 failed; console errors: 0`);
} catch (e) {
  console.log("FAIL " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n     "));
  if (errors.length) console.log("console errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close(); server.close();
}
