#!/usr/bin/env node
// Optional live, anonymous-only permission smoke check. No real row can match:
// DELETE uses both a verified nonexistent UUID and an impossible id-is-null filter.
// Never reads note text, signs in, or loads any owner credential.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../config.js", import.meta.url), "utf8"), sandbox);
const config = sandbox.window.POSTIT_CONFIG;
assert.ok(config?.SUPABASE_URL && config?.SUPABASE_ANON_KEY, "A public Supabase config is required");
const headers = { apikey: config.SUPABASE_ANON_KEY, Authorization: "Bearer " + config.SUPABASE_ANON_KEY,
  Prefer: "return=representation" };
for (const table of ["days", "pins", "pages"]) {
  const id = randomUUID();
  const url = `${config.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=id`;
  const read = await fetch(url, { headers });
  assert.equal(read.status, 200, "Anonymous select must still work");
  assert.deepEqual(await read.json(), [], "Generated test UUID must not exist");
  const response = await fetch(url + "&and=(id.is.null)", { method: "DELETE", headers });
  const result = await response.json();
  assert.ok([401, 403].includes(response.status), "Anonymous DELETE must be refused by table privileges");
  assert.equal(result.code, "42501", "Expected insufficient_privilege, not a network or schema error");
  console.log(`pass: live anonymous DELETE ${table}: HTTP ${response.status}, permission denied; impossible row filter`);
}
