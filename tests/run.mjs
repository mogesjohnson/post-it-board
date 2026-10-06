#!/usr/bin/env node
// Offline tests for scripts/post.mjs: runs the real script against tests/mock.mjs (no network, no dependencies).
//   node tests/run.mjs            # exits 1 if any check fails
//   node tests/run.mjs dedup      # only checks whose name contains "dedup"
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POST = join(HERE, "..", "scripts", "post.mjs");
const D = "2026-10-05";
const only = process.argv[2] || "";
const tmp = mkdtempSync(join(tmpdir(), "postit-tests-"));
const mock = await startMock();
const ENV = { SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: "x", SUPABASE_OWNER_EMAIL: "a", SUPABASE_OWNER_PASSWORD: "b" };

let n = 0, pass = 0;
const failures = [];

/* ---------- helpers ---------- */
function runPost(args, timeoutMs = 15000) {
  return new Promise(res => {
    const env = { ...process.env, ...ENV };
    delete env.SUPABASE_SERVICE_KEY; delete env.SUPABASE_KEY;
    const p = spawn(process.execPath, [POST, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill(); err += "\n(timed out)"; }, timeoutMs);
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => err += d);
    p.on("close", code => { clearTimeout(timer); res({ code, out, err }); });
  });
}
async function runFile(path, extra = []) {
  const rf = join(tmp, `r${++n}.json`);
  const r = await runPost(["--command-file", path, "--result-file", rf, ...extra]);
  return { ...r, result: existsSync(rf) ? JSON.parse(readFileSync(rf, "utf8")) : null };
}
// run a command object, or raw file contents (string / Buffer)
function run(cmd, extra) {
  const f = join(tmp, `c${++n}.json`);
  writeFileSync(f, typeof cmd === "string" || Buffer.isBuffer(cmd) ? cmd : JSON.stringify(cmd));
  return runFile(f, extra);
}
const add = (pin, body, title, more = {}) => run({ op: "add", date: D, pin, ...(title !== undefined && { title }), ...(body !== undefined && { body }), ...more });
const db = () => mock.db;
function setup(pinTitles = []) {
  mock.reset();
  const day = mock.seed("days", { board_date: D, title: null });
  const pins = pinTitles.map((t, i) => mock.seed("pins", { day_id: day.id, title: t, color: "yellow", position: i }));
  return { day, pins };
}
const seedPage = (pin, title, body, position) => mock.seed("pages", { pin_id: pin.id, title, body, position });
const brief = r => `status=${r.result?.status} exit=${r.code} msg=${JSON.stringify(r.result?.message)} pins=${JSON.stringify(db().pins.map(p => p.title))} pages=${db().pages.length}${r.err.trim() ? ` stderr=${r.err.trim().slice(0, 200)}` : ""}`;

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    await fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
function expect(cond, r, what = "") {
  if (!cond) throw new Error(`${what}${what ? ": " : ""}${r && r.code !== undefined ? brief(r) : JSON.stringify(r)}`);
}
const ok = (r, extra = true) => expect(r.code === 0 && r.result?.status === "ok" && extra, r);
const status = (r, s, code = 0) => expect(r.code === code && r.result?.status === s, r, `expected ${s}/exit ${code}`);

/* ---------- add ---------- */
await test("add: creates day, pin and page", async () => {
  mock.reset();
  const r = await add("AI", "hello", "T1");
  ok(r, r.result.matchType === "new" && r.result.pageNumber === 1 && db().days.length === 1 && db().pins.length === 1 && db().pages.length === 1);
});
await test("add: exact match ignores case, spaces and punctuation", async () => {
  const { pins } = setup(["Post-it Board", "QA Live Zebra"]);
  let r = await add("  postit   BOARD!! ", "b", "x");
  ok(r, r.result.matchType === "exact" && db().pages[0].pin_id === pins[0].id);
  r = await add("qa live zebra!", "b2", "y");
  ok(r, r.result.matchType === "exact" && db().pins.length === 2 && db().pages[1].pin_id === pins[1].id);
});
await test("add: whole-word prefix matches (Python lists -> Python)", async () => {
  setup(["Python"]);
  const r = await add("Python lists", "b");
  ok(r, r.result.matchType === "fuzzy" && db().pins.length === 1);
});
await test("add: prefix ambiguity -> skipped_ambiguous with candidates, nothing written", async () => {
  setup(["Python lists", "Python loops"]);
  const r = await add("Python", "b");
  status(r, "skipped_ambiguous");
  expect(r.result.candidates?.length === 2 && db().pages.length === 0, r);
});
await test("add: two pins with the same normalized title -> skipped_ambiguous", async () => {
  setup(["Cats", "cats!"]);
  const r = await add("cats", "b");
  status(r, "skipped_ambiguous");
  expect(db().pages.length === 0, r);
});

/* ---------- H2: typo tolerance ---------- */
const TRUE_MATCHES = [
  ["QA Live Zebra", "QA Live Zebar"],   // swapped neighbours
  ["Python lists", "Pyhton lists"],     // swapped neighbours
  ["Garage shelves", "Garage shelvs"],  // missing letter
  ["AI agents", "AI agent"],            // plural
  ["Kitchen remodel", "Kitchen remodell"], // extra letter
  ["Zebra Lions", "Zebar Loins"],       // two differing words is the most allowed
];
for (const [seed, typed] of TRUE_MATCHES) {
  await test(`H2 typo match: "${typed}" -> "${seed}"`, async () => {
    setup([seed]);
    const r = await add(typed, "b");
    ok(r, r.result.matchType === "fuzzy" && db().pins.length === 1 && r.result.matched.pinTitle === seed);
  });
}
const FALSE_MERGES = [
  ["Code", "Node"], ["Cars", "Cats"], ["Rust", "Dust"], ["Home ideas", "Game ideas"], ["Book notes", "Cook notes"],
  ["Watch", "Match"], ["Bread", "Break"], ["AI", "UI"], ["Python", "Pythonic"], ["Market", "Marker"], ["Planning", "Planting"],
  ["Train", "Strain"],                          // a slip, but the first letter changed
  ["Plan", "Plans"],                            // a slip, but in a 4-letter word
  ["Zebra Lions Tigers", "Zebar Loins Tigres"], // three slipped words is too many
  ["Order 10243", "Order 10234"],               // digits never get typo tolerance
  ["Standup 20261105", "Standup 20261015"],
  ["Git", "Git tips"],                          // prefix rule needs 4+ letters/digits in the shorter title
  ["AI x", "AI x notes"],                       // ... and spaces don't count toward the 4
  ["C++ x", "C++ x notes"],                     // ... nor do + and #
  ["कल", "काल"],                                // vowel signs of other scripts are not accents
];
for (const [seed, typed] of FALSE_MERGES) {
  await test(`H2 stays separate: "${typed}" vs "${seed}"`, async () => {
    setup([seed]);
    const r = await add(typed, "b");
    ok(r, r.result.matchType === "new" && db().pins.length === 2);
  });
}
await test('exact match still ignores Latin accents ("Café" = "cafe")', async () => {
  setup(["Café"]);
  const r = await add("cafe", "b");
  ok(r, r.result.matchType === "exact" && db().pins.length === 1);
});
await test("prefix rule: 4 letters/digits qualify even with a space (AI 20 -> AI 20 recap)", async () => {
  setup(["AI 20"]);
  const r = await add("AI 20 recap", "b");
  ok(r, r.result.matchType === "fuzzy" && db().pins.length === 1);
});
await test("H2 typo ambiguity -> skipped_ambiguous", async () => {
  setup(["Zebra notes", "Zebars notes"]); // "Zebar notes" is one slip from both
  const r = await add("Zebar notes", "b");
  status(r, "skipped_ambiguous");
  expect(r.result.candidates?.length === 2, r);
});

/* ---------- H3: emoji / punctuation-only titles ---------- */
for (const t of ["🚗", "!!!"]) {
  await test(`H3 "${t}" twice reuses one pin`, async () => {
    mock.reset();
    const a = await add(t, "one", "a");
    const b = await add(t, "two", "b");
    ok(a, a.result.matchType === "new");
    ok(b, b.result.matchType === "exact" && db().pins.length === 1 && db().pages.length === 2);
  });
}
await test("H3 emoji with and without the variation selector are the same pin (❤️ = ❤)", async () => {
  mock.reset();
  await add("❤️", "one", "a");
  const b = await add("❤", "two", "b");
  ok(b, b.result.matchType === "exact" && db().pins.length === 1 && db().pages.length === 2);
});
await test("H3 ... in the other direction too (❤ pin, then ❤️)", async () => {
  mock.reset();
  await add("❤", "one", "a");
  const b = await add("❤️", "two", "b");
  ok(b, b.result.matchType === "exact" && db().pins.length === 1 && db().pages.length === 2);
});
for (const other of ["☀️", "🚗️"]) {
  await test(`H3 "${other}" never lands in the "❤️" pin (selectors are not the title)`, async () => {
    mock.reset();
    await add("❤️", "one", "a");
    const b = await add(other, "two", "b");
    ok(b, b.result.matchType === "new" && db().pins.length === 2);
  });
}
for (const typed of ["Tools", "🛠 Tools"]) {
  await test(`emoji decoration is ignored next to words: "${typed}" -> "🛠️ Tools"`, async () => {
    setup(["🛠️ Tools"]);
    const r = await add(typed, "b");
    ok(r, r.result.matchType === "exact" && db().pins.length === 1);
  });
}
await test(`H3 different emoji stay separate; same emoji+page is a duplicate`, async () => {
  mock.reset();
  await add("🚗", "one", "a");
  const b = await add("🚕", "one", "a");
  ok(b, b.result.matchType === "new" && db().pins.length === 2);
  const c = await add("🚗", "one", "a");
  status(c, "skipped_duplicate");
});
await test("H3 edit/delete still find emoji pins", async () => {
  mock.reset();
  await add("🚗", "x");
  ok(await run({ op: "edit", target: "pin", date: D, pin: "🚗", color: "blue" }), db().pins[0].color === "blue");
});

/* ---------- H1: dedup compares title and text ---------- */
await test("H1 title-only pages with different titles are both added", async () => {
  mock.reset();
  const a = await add("Notes", undefined, "First idea");
  const b = await add("Notes", undefined, "Second idea");
  ok(a); ok(b, b.result.pageNumber === 2 && db().pages.length === 2);
});
await test("H1 same text with a different title is added", async () => {
  mock.reset();
  await add("Notes", "same text", "A");
  ok(await add("Notes", "same text", "B"), db().pages.length === 2);
});
await test("H1 same title-only page twice -> skipped_duplicate", async () => {
  mock.reset();
  await add("Notes", undefined, "First idea");
  status(await add("Notes", undefined, "  First idea "), "skipped_duplicate");
});
await test('H1 missing, "" and blank titles count as the same title', async () => {
  mock.reset();
  await add("Notes", "x", "");
  status(await add("Notes", "x"), "skipped_duplicate");
  status(await add("Notes", "x", "   "), "skipped_duplicate");
  expect(db().pages.length === 1, db().pages);
});
await test("dedup: CRLF and trailing whitespace ignored; window is 10 minutes", async () => {
  setup(["AI"]);
  await add("AI", "same", "t");
  status(await add("AI", "same\r\n", "t"), "skipped_duplicate");
  mock.backdate("pages", "*", 11);
  ok(await add("AI", "same", "t"), db().pages.length === 2);
  mock.backdate("pages", "*", 9);
  status(await add("AI", "same", "t"), "skipped_duplicate");
});

/* ---------- H7: page numbers in results ---------- */
await test("H7 skipped_duplicate reports pageNumber, matchType and the existing pageId", async () => {
  const { pins } = setup(["AI"]);
  seedPage(pins[0], "p1", "one", 0);
  const p2 = seedPage(pins[0], "t", "same", 1);
  seedPage(pins[0], "p3", "three", 2);
  const r = await add("AI", "same", "t");
  status(r, "skipped_duplicate");
  expect(r.result.pageNumber === 2 && r.result.matchType === "exact" && r.result.matched.pageId === p2.id
    && r.result.matched.pinTitle === "AI" && r.result.date === D, r.result);
});
await test("H7 skipped_duplicate of page 1 of 3 reports pageNumber 1 (pages are put in order first)", async () => {
  const { pins } = setup(["AI"]);
  const p1 = seedPage(pins[0], "t", "same", 0);
  seedPage(pins[0], "p2", "two", 1);
  seedPage(pins[0], "p3", "three", 2);
  const r = await add("AI", "same", "t");
  status(r, "skipped_duplicate");
  expect(r.result.pageNumber === 1 && r.result.matched.pageId === p1.id, r.result);
});
await test("H7 add reports the real page number when positions have gaps", async () => {
  const { pins } = setup(["AI"]);
  seedPage(pins[0], "a", "1", 0);
  seedPage(pins[0], "c", "3", 5); // a page in between was deleted
  const r = await add("AI", "new", "d");
  ok(r, r.result.pageNumber === 3);
  const e = await run({ op: "edit", target: "page", date: D, pin: "AI", pageNumber: 3, body: "edited" });
  ok(e, db().pages.find(p => p.title === "d").body === "edited");
});

/* ---------- edit / delete ---------- */
await test("edit/delete: exact matches only, every path", async () => {
  const { pins } = setup(["AI"]);
  seedPage(pins[0], "A", "one", 0); seedPage(pins[0], "B", "two", 1); seedPage(pins[0], "B", "dup", 2);
  let r = await run({ op: "edit", target: "page", date: D, pin: "ai", page: "a", body: "ONE!" });
  ok(r, r.result.pageNumber === 1 && db().pages.find(p => p.title === "A").body === "ONE!");
  ok(await run({ op: "edit", target: "page", date: D, pin: "AI", pageNumber: 2, title: "B2" }), db().pages.find(p => p.body === "two").title === "B2");
  seedPage(pins[0], "B2", "dupB2", 3);
  status(await run({ op: "edit", target: "page", date: D, pin: "AI", page: "B2", body: "x" }), "skipped_ambiguous");
  status(await run({ op: "edit", target: "page", date: D, pin: "AI", pageNumber: 9, body: "x" }), "skipped_not_found");
  status(await run({ op: "edit", target: "page", date: D, pin: "AI", page: "nope", body: "x" }), "skipped_not_found");
  status(await run({ op: "edit", target: "page", date: D, pin: "A", page: "A", body: "x" }), "skipped_not_found"); // never guesses the pin
  ok(await run({ op: "edit", target: "pin", date: D, pin: "AI", newPin: "AI Agents", color: "blue" }), db().pins[0].title === "AI Agents" && db().pins[0].color === "blue");
  ok(await run({ op: "edit", target: "pin", date: D, pin: "ai agents", color: "pink" }), db().pins[0].color === "pink");
  ok(await run({ op: "delete", target: "page", date: D, pin: "AI Agents", page: "A" }), db().pages.length === 3);
  ok(await run({ op: "delete", target: "page", date: D, pin: "AI Agents", pageNumber: 1 }), db().pages.length === 2);
  ok(await run({ op: "delete", target: "pin", date: D, pin: "AI AGENTS" }), db().pins.length === 0 && db().pages.length === 0 && db().days.length === 1);
  status(await run({ op: "delete", target: "pin", date: D, pin: "AI Agents" }), "skipped_not_found");
  status(await run({ op: "edit", target: "pin", date: "2030-01-01", pin: "x", color: "blue" }), "skipped_not_found");
});
await test("delete: two pins with the same title -> skipped_ambiguous, nothing deleted", async () => {
  setup(["A", "a"]);
  status(await run({ op: "delete", target: "pin", date: D, pin: "A" }), "skipped_ambiguous");
  expect(db().pins.length === 2, db().pins);
});
await test("H6 rename onto another pin's title -> skipped_ambiguous, nothing changed", async () => {
  setup(["Alpha", "Beta"]);
  status(await run({ op: "edit", target: "pin", date: D, pin: "Alpha", newPin: "  bETA ", color: "green" }), "skipped_ambiguous");
  expect(db().pins.map(p => p.title + "/" + p.color).join() === "Alpha/yellow,Beta/yellow", db().pins);
  ok(await run({ op: "edit", target: "pin", date: D, pin: "Alpha", newPin: "alpha" }), db().pins[0].title === "alpha");
});

/* ---------- H5: validation ---------- */
const INVALID = [
  ["pageNumber as a string", { op: "edit", target: "page", date: D, pin: "P", pageNumber: "2", body: "x" }],
  ["both page and pageNumber", { op: "edit", target: "page", date: D, pin: "P", page: "t", pageNumber: 1, body: "x" }],
  ["pin edit without newPin or color", { op: "edit", target: "pin", date: D, pin: "P" }],
  ["page edit without title or body", { op: "edit", target: "page", date: D, pin: "P", pageNumber: 1 }],
  ["edit without target", { op: "edit", date: D, pin: "P", body: "x" }],
  ["body over 5000 characters", { op: "add", date: D, pin: "P", body: "x".repeat(5001) }],
  ["impossible date", { op: "add", date: "2026-02-30", pin: "P", body: "x" }],
  ["JSON array", [{ op: "add", date: D, pin: "P", body: "x" }]],
  ["unknown op", { op: "upsert", date: D, pin: "P", body: "x" }],
  ["missing pin", { op: "add", date: D, title: "t", body: "x" }],
  ["add with no title and no body", { op: "add", date: D, pin: "P" }],
  ["bad color", { op: "add", date: D, pin: "P", body: "x", color: "red" }],
  ["not JSON", "{not json"],
];
for (const [name, cmd] of INVALID) {
  await test(`H5 error_invalid: ${name}`, async () => {
    const { pins } = setup(["P"]);
    seedPage(pins[0], "t", "b", 0);
    const before = JSON.stringify(db());
    const r = await run(cmd);
    status(r, "error_invalid", 0);
    expect(JSON.stringify(db()) === before, r, "nothing written");
  });
}
await test("H5 a 5000-character body is accepted", async () => {
  setup(["P"]);
  ok(await add("P", "x".repeat(5000)));
});
await test("H5 a UTF-8 BOM before the JSON is accepted", async () => {
  setup();
  ok(await run(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify({ op: "add", date: D, pin: "P", body: "x" }))])), db().pages.length === 1);
});

/* ---------- real failures (exit 1, command kept by the workflow) ---------- */
await test("error: sign-in failure -> error, exit 1", async () => {
  mock.reset(); mock.fail({ match: "AUTH" });
  status(await add("x", "y"), "error", 1);
});
await test("error: database read failure -> error, exit 1", async () => {
  mock.reset(); mock.fail({ match: "GET /rest/v1/days" });
  status(await add("x", "y"), "error", 1);
});
await test("error: missing command file -> error, exit 1", async () => {
  status(await runFile(join(tmp, "does-not-exist.json")), "error", 1);
});
await test("H4 failed page insert leaves day+pin; the retry converges to one page", async () => {
  mock.reset(); mock.fail({ match: "POST /rest/v1/pages" });
  const cmd = { op: "add", date: D, pin: "Fresh", title: "T", body: "B" };
  status(await run(cmd), "error", 1);
  expect(db().days.length === 1 && db().pins.length === 1 && db().pages.length === 0, db());
  const r = await run(cmd);
  ok(r, r.result.matchType === "exact" && db().pins.length === 1 && db().pages.length === 1);
  status(await run(cmd), "skipped_duplicate");
});

/* ---------- misc ---------- */
await test("dry run writes nothing", async () => {
  mock.reset();
  const r = await run({ op: "add", date: D, pin: "x", body: "y" }, ["--dry-run"]);
  ok(r, r.result.dryRun === true && db().days.length + db().pins.length + db().pages.length === 0);
});
await test("README inbox examples are accepted", async () => {
  mock.reset();
  ok(await run({ op: "add", date: D, pin: "AI", title: "LLMs", body: "Large language models predict the next word." }));
  ok(await run({ op: "add", date: D, pin: "AI", title: "Agents", body: "Loops." }));
  ok(await run({ op: "edit", target: "page", date: D, pin: "AI", pageNumber: 2, body: "Corrected text." }));
  ok(await run({ op: "delete", target: "pin", date: D, pin: "AI" }), db().pins.length === 0);
});
await test("quick-add CLI: appends a page and prints its page number", async () => {
  setup(["AI"]);
  const r = await runPost(["--date", D, "--pin", "ai", "--page-title", "LLMs", "--body", "line 1\\nline 2"]);
  const line = JSON.parse(r.out.trim().split("\n").pop());
  expect(r.code === 0 && line.page_number === 1 && db().pins.length === 1 && db().pages[0].body === "line 1\nline 2", r);
});
await test("quick-add CLI: page number is the place in order, even with position gaps", async () => {
  const { pins } = setup(["AI"]);
  seedPage(pins[0], "a", "1", 0);
  seedPage(pins[0], "c", "3", 5); // a page in between was deleted
  const r = await runPost(["--date", D, "--pin", "AI", "--body", "new"]);
  const line = JSON.parse(r.out.trim().split("\n").pop());
  expect(r.code === 0 && line.page_number === 3 && db().pages.length === 3, r);
});
await test("process exits by itself with the right code (keep-alive connections)", async () => {
  mock.reset();
  const t = Date.now();
  const r = await run({ op: "add", date: D, pin: "x", body: "y" });
  ok(r);
  expect(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
  mock.fail({ match: "AUTH" });
  status(await add("x", "z"), "error", 1);
});

/* ---------- done ---------- */
await mock.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => `  - ${f}`).join("\n")); process.exitCode = 1; }
