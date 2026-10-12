#!/usr/bin/env node
// Unit tests for topics.js (the Topics view's pure helpers). No network, no dependencies.
//   node tests/topics.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const T = createRequire(import.meta.url)("../topics.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("ok   " + name); }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + e.message.split("\n").join("\n     ")); }
}
const pin = (id, title, date, created, updated, pages = []) => ({ id, title, color: "yellow", created_at: created, updated_at: updated, day: { board_date: date }, pages });
const page = (id, position, created, updated, body, title = "Summary") => ({ id, title, body, position, created_at: created, updated_at: updated });

test("every pin across all days, most recently updated first", () => {
  const rows = [
    pin("a", "Old note", "2026-10-01", "2026-10-01T10:00:00Z", "2026-10-01T10:00:00Z", [page("a1", 0, "2026-10-01T10:00:00Z", "2026-10-01T10:00:00Z", "old")]),
    pin("b", "Garden plot", "2026-10-03", "2026-10-03T09:00:00Z", "2026-10-03T09:00:00Z", [page("b1", 0, "2026-10-03T09:00:00Z", "2026-10-11T08:00:00Z", "merged")]),
    pin("c", "Welcome", "2026-10-05", "2026-10-05T12:00:00Z", "2026-10-05T12:00:00Z", []),
  ];
  const t = T.fromRows(rows);
  assert.deepEqual(t.map(x => x.id), ["b", "c", "a"], "an edited page 1 lifts an older day's pin to the top");
  assert.equal(t[0].updated_at, "2026-10-11T08:00:00Z");
  assert.equal(t[0].board_date, "2026-10-03");
  assert.equal(t[0].summary, "merged");
  assert.equal(t[1].summary, ""); assert.equal(t[1].page_count, 0);
});

test("summary = page 1 by position, then created_at (same order as the day view and post.mjs)", () => {
  const t = T.fromRows([pin("p", "X", "2026-10-05", "2026-10-05T00:00:00Z", "2026-10-05T00:00:00Z", [
    page("p3", 1, "2026-10-05T01:00:00Z", null, "second"),
    page("p2", 0, "2026-10-05T03:00:00Z", null, "third"),
    page("p1", 0, "2026-10-05T02:00:00Z", null, "first"),
  ])]);
  assert.equal(t[0].summary, "first"); assert.equal(t[0].page_count, 3); assert.equal(t[0].page_title, "Summary");
});

test("pin rename (pin.updated_at) counts as an update; missing updated_at falls back to created_at", () => {
  const t = T.fromRows([
    pin("a", "A", "2026-10-01", "2026-10-01T00:00:00Z", "2026-10-09T00:00:00Z"),
    { id: "b", title: "B", created_at: "2026-10-08T00:00:00Z", board_date: "2026-10-08", pages: [] },
  ]);
  assert.deepEqual(t.map(x => x.id), ["a", "b"]);
  assert.equal(t[1].board_date, "2026-10-08", "flat board_date accepted (LocalStore)");
});

test("ties are stable: newer day, then title, then id", () => {
  const same = "2026-10-05T00:00:00Z";
  const t = T.fromRows([pin("z", "Beta", "2026-10-04", same, same), pin("y", "Alpha", "2026-10-04", same, same), pin("x", "Zed", "2026-10-05", same, same)]);
  assert.deepEqual(t.map(x => x.id), ["x", "y", "z"]);
});

test("empty / bad input", () => {
  assert.deepEqual(T.fromRows(null), []);
  assert.equal(T.lastUpdated({ updated_at: "nonsense" }), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
