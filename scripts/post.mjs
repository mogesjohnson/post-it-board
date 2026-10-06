#!/usr/bin/env node
// Post-it Board writer (Supabase). Node 18+ (global fetch). No dependencies.
//
// 1) Quick add (CLI):
//   node scripts/post.mjs --date 2026-10-05 --pin "AI" --page-title "LLMs" --body "..."
//   Finds (or creates) the day and the pin (case-insensitive exact title), then appends a page.
//   Options: --date YYYY-MM-DD (default: today in America/New_York) --pin "Topic" (required)
//            --page-title "..." --body "..." | --body - (stdin) | --body-file path
//            --color yellow|pink|blue|green (new pin) --day-title "..." (new day) --dry-run
//
// 2) Command file (used by the GitHub inbox workflow):
//   node scripts/post.mjs --command-file inbox/foo.json [--result-file inbox/results/foo.json] [--dry-run]
//   JSON: {"op":"add"|"edit"|"delete", "date", "pin", "title", "body", "color",
//          "target":"pin"|"page", "page", "pageNumber", "newPin"}   (see inbox/README.md)
//   Prints a result object {status, op, input, matched, message, processedAt} and writes it to
//   --result-file. Exit 0 when handled or skipped; non-zero only for real failures.
//
// Environment (never commit these):
//   SUPABASE_URL              https://<ref>.supabase.co                  (required)
//   SUPABASE_ANON_KEY         public anon key (apikey for owner sign-in)
//   SUPABASE_OWNER_EMAIL      bot/owner account email     } preferred: signs in as a board owner
//   SUPABASE_OWNER_PASSWORD   bot/owner account password  } (listed in public.board_owners), so RLS applies
//                             e.g. the bot account johnsonmoges+postit-bot@gmail.com
//   SUPABASE_SERVICE_KEY      fallback only (bypasses RLS) — alias: SUPABASE_KEY

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const COLORS = ["yellow", "pink", "blue", "green"];
const TZ = "America/New_York";
const LIMITS = { pin: 200, title: 200, body: 5000 };
const DEDUP_MINUTES = 10;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
class InvalidInput extends Error {}

function todayNY() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function isValidDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
// "Post-it  Board!" -> "postit board" (case, accents, punctuation, extra spaces ignored; keeps + and #)
function norm(s) {
  return String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}\s+#]/gu, "").replace(/\s+/g, " ").trim();
}
const squash = s => norm(s).replace(/ /g, "");                 // also ignore spaces
const exactCI = s => String(s).trim().replace(/\s+/g, " ").toLowerCase(); // edit/delete matching
// Edit distance (optimal string alignment: insert/delete/substitute/swap neighbours = 1 each)
function levenshtein(a, b) {
  if (a === b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
// Allowed typo distance depends on the length of the shorter title, so "AI" never merges into "UI".
function maxTypos(len) { return len <= 3 ? 0 : len <= 6 ? 1 : 2; }
function sameBody(a, b) {
  const n = s => String(s ?? "").replace(/\r\n?/g, "\n").trim();
  return n(a) === n(b);
}
const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.created_at).localeCompare(String(b.created_at));

/* ------------------------------------------------------------------ */
/* Supabase connection                                                 */
/* ------------------------------------------------------------------ */
async function connect() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const email = process.env.SUPABASE_OWNER_EMAIL || "";
  const password = process.env.SUPABASE_OWNER_PASSWORD || "";
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "";
  if (!url) throw new Error("SUPABASE_URL is not set.");

  let apikey, bearer, authMode;
  if (email && password) {
    const key = anonKey || serviceKey;
    if (!key) throw new Error("Owner sign-in needs SUPABASE_ANON_KEY (the public anon key) as the apikey.");
    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Owner sign-in failed: ${data.error_description || data.msg || data.error_code || res.status}`);
    apikey = key; bearer = data.access_token; authMode = "board owner account";
  } else if (serviceKey) {
    apikey = serviceKey; bearer = serviceKey; authMode = "service key";
  } else {
    throw new Error("Set SUPABASE_OWNER_EMAIL + SUPABASE_OWNER_PASSWORD (preferred) or SUPABASE_SERVICE_KEY.");
  }

  async function rest(method, path, payload) {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json",
        ...(method === "GET" ? {} : { Prefer: "return=representation" }),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const hint = /row-level security/i.test(data?.message || "") ? " (this account is not in public.board_owners)" : "";
      throw new Error(`${method} ${path.split("?")[0]} failed (${res.status}): ${data?.message || text}${hint}`);
    }
    if (method !== "GET" && Array.isArray(data) && data.length === 0) {
      throw new Error(`${method} ${path.split("?")[0]} affected no rows — is this account listed in public.board_owners?`);
    }
    return data;
  }
  return { rest, authMode };
}
const enc = encodeURIComponent;

/* ------------------------------------------------------------------ */
/* command-file mode                                                   */
/* ------------------------------------------------------------------ */
function validate(raw) {
  const errs = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InvalidInput("Command must be a JSON object.");
  const str = (k, max, { required = false, allowEmpty = false } = {}) => {
    const v = raw[k];
    if (v === undefined || v === null) { if (required) errs.push(`"${k}" is required`); return undefined; }
    if (typeof v !== "string") { errs.push(`"${k}" must be a string`); return undefined; }
    if (!allowEmpty && !v.trim()) { if (required) errs.push(`"${k}" must not be empty`); return allowEmpty ? v : undefined; }
    if (v.length > max) errs.push(`"${k}" is too long (max ${max} characters)`);
    return v;
  };
  const cmd = {};
  cmd.op = raw.op;
  if (!["add", "edit", "delete"].includes(cmd.op)) errs.push(`"op" must be "add", "edit" or "delete"`);
  if (raw.date !== undefined && raw.date !== null && raw.date !== "") {
    if (!isValidDate(raw.date)) errs.push(`"date" must be a real date in YYYY-MM-DD format`);
    cmd.date = raw.date;
  }
  cmd.pin = str("pin", LIMITS.pin, { required: true });
  cmd.title = str("title", LIMITS.title, { allowEmpty: true });
  cmd.body = str("body", LIMITS.body, { allowEmpty: true });
  cmd.page = str("page", LIMITS.title);
  cmd.newPin = str("newPin", LIMITS.pin);
  if (raw.color !== undefined && raw.color !== null) {
    if (!COLORS.includes(raw.color)) errs.push(`"color" must be one of ${COLORS.join(", ")}`);
    cmd.color = raw.color;
  }
  if (raw.pageNumber !== undefined && raw.pageNumber !== null) {
    if (!Number.isInteger(raw.pageNumber) || raw.pageNumber < 1 || raw.pageNumber > 10000) errs.push(`"pageNumber" must be a whole number >= 1`);
    cmd.pageNumber = raw.pageNumber;
  }
  if (raw.target !== undefined && raw.target !== null) cmd.target = raw.target;

  if (cmd.op === "add") {
    if (!(cmd.body && cmd.body.trim()) && !(cmd.title && cmd.title.trim())) errs.push(`add needs "body" (and/or "title")`);
  }
  if (cmd.op === "edit" || cmd.op === "delete") {
    if (!["pin", "page"].includes(cmd.target)) errs.push(`${cmd.op} needs "target": "pin" or "page"`);
    if (cmd.target === "page") {
      const hasTitle = cmd.page !== undefined, hasNum = cmd.pageNumber !== undefined;
      if (hasTitle === hasNum) errs.push(`target "page" needs exactly one of "page" (page title) or "pageNumber"`);
    }
    if (cmd.op === "edit" && cmd.target === "pin" && cmd.newPin === undefined && cmd.color === undefined) {
      errs.push(`edit of a pin needs "newPin" and/or "color"`);
    }
    if (cmd.op === "edit" && cmd.target === "page" && cmd.title === undefined && cmd.body === undefined) {
      errs.push(`edit of a page needs "title" and/or "body" (the new values)`);
    }
  }
  if (errs.length) throw new InvalidInput(errs.join("; "));
  cmd.date = cmd.date || todayNY();
  return cmd;
}

// Fuzzy pin lookup for "add": returns {pin, matchType} | {ambiguous:[...]} | {} (no match)
function fuzzyFindPin(pins, wanted) {
  const wk = squash(wanted), wn = norm(wanted);
  if (!wk) return {};
  const exact = pins.filter(p => squash(p.title) === wk);
  if (exact.length === 1) return { pin: exact[0], matchType: "exact" };
  if (exact.length > 1) return { ambiguous: exact };
  const close = pins.filter(p => {
    const pk = squash(p.title), pn = norm(p.title);
    if (!pk) return false;
    const shorter = Math.min(pk.length, wk.length);
    if (levenshtein(pk, wk) <= maxTypos(shorter)) return true;
    // whole-word prefix, e.g. "Python" ~ "Python lists" (only for 4+ character titles)
    const [s, l] = pn.length <= wn.length ? [pn, wn] : [wn, pn];
    return s.length >= 4 && l.startsWith(s + " ");
  });
  if (close.length === 1) return { pin: close[0], matchType: "fuzzy" };
  if (close.length > 1) return { ambiguous: close };
  return {};
}

async function runCommand(cmd, api, dry) {
  const { rest } = api;
  const matched = { dayId: null, pinId: null, pageId: null, pinTitle: null };
  const out = (status, message, extra = {}) => ({ status, message, matched, ...extra });

  const [day] = await rest("GET", `days?select=id,board_date&board_date=eq.${enc(cmd.date)}`);
  if (day) matched.dayId = day.id;
  const pins = day ? await rest("GET", `pins?select=id,title,color,position&day_id=eq.${enc(day.id)}&order=position.asc,created_at.asc`) : [];

  /* ----- add ----- */
  if (cmd.op === "add") {
    const found = fuzzyFindPin(pins, cmd.pin);
    if (found.ambiguous) {
      return out("skipped_ambiguous", `"${cmd.pin}" could match several pins on ${cmd.date}: ${found.ambiguous.map(p => `"${p.title}"`).join(", ")}. Nothing was added; use the exact pin title.`,
        { candidates: found.ambiguous.map(p => ({ pinId: p.id, pinTitle: p.title })) });
    }
    let pin = found.pin, pages = [];
    if (pin) {
      matched.pinId = pin.id; matched.pinTitle = pin.title;
      pages = await rest("GET", `pages?select=id,title,body,position,created_at&pin_id=eq.${enc(pin.id)}`);
      const cutoff = Date.now() - DEDUP_MINUTES * 60 * 1000;
      const dup = pages.find(pg => sameBody(pg.body, cmd.body) && Date.parse(pg.created_at) >= cutoff);
      if (dup) {
        matched.pageId = dup.id;
        return out("skipped_duplicate", `The same text was already added to "${pin.title}" in the last ${DEDUP_MINUTES} minutes.`);
      }
    }
    const notes = [];
    let dayId = day?.id;
    if (!dayId) {
      notes.push(`created day ${cmd.date}`);
      dayId = dry ? "(new-day)" : (await rest("POST", "days", { board_date: cmd.date }))[0].id;
      matched.dayId = dayId;
    }
    if (!pin) {
      const position = pins.reduce((m, p) => Math.max(m, (p.position ?? 0) + 1), 0);
      const color = cmd.color || COLORS[position % COLORS.length];
      notes.push(`created pin "${cmd.pin.trim()}"`);
      pin = dry ? { id: "(new-pin)", title: cmd.pin.trim() } :
        (await rest("POST", "pins", { day_id: dayId, title: cmd.pin.trim(), color, position }))[0];
      matched.pinId = pin.id; matched.pinTitle = pin.title;
    } else {
      notes.push(`${found.matchType === "fuzzy" ? "matched existing pin" : "using pin"} "${pin.title}"`);
    }
    const position = pages.reduce((m, p) => Math.max(m, (p.position ?? 0) + 1), 0);
    const page = dry ? { id: "(new-page)" } :
      (await rest("POST", "pages", { pin_id: pin.id, title: cmd.title?.trim() || null, body: cmd.body ?? "", position }))[0];
    matched.pageId = page.id;
    notes.push(`added page ${position + 1}${cmd.title?.trim() ? ` "${cmd.title.trim()}"` : ""}`);
    return out("ok", notes.join("; ") + ".", { matchType: found.matchType || "new", pageNumber: position + 1 });
  }

  /* ----- edit / delete: exact matches only, never guess ----- */
  if (!day) return out("skipped_not_found", `There is no board for ${cmd.date}.`);
  const hits = pins.filter(p => exactCI(p.title) === exactCI(cmd.pin));
  if (hits.length === 0) return out("skipped_not_found", `No pin titled "${cmd.pin}" on ${cmd.date}.`);
  if (hits.length > 1) return out("skipped_ambiguous", `${hits.length} pins are titled "${cmd.pin}" on ${cmd.date}; nothing was changed.`);
  const pin = hits[0];
  matched.pinId = pin.id; matched.pinTitle = pin.title;

  if (cmd.target === "pin") {
    if (cmd.op === "delete") {
      if (!dry) await rest("DELETE", `pins?id=eq.${enc(pin.id)}`);
      return out("ok", `Deleted pin "${pin.title}" and all its pages.`);
    }
    const patch = {};
    if (cmd.newPin !== undefined) {
      const newTitle = cmd.newPin.trim();
      const clash = pins.find(p => p.id !== pin.id && exactCI(p.title) === exactCI(newTitle));
      if (clash) return out("skipped_ambiguous", `Another pin is already titled "${clash.title}" on ${cmd.date}; not renamed.`);
      patch.title = newTitle;
    }
    if (cmd.color !== undefined) patch.color = cmd.color;
    if (!dry) await rest("PATCH", `pins?id=eq.${enc(pin.id)}`, patch);
    return out("ok", `Updated pin "${pin.title}"${patch.title ? ` -> "${patch.title}"` : ""}${patch.color ? ` (color ${patch.color})` : ""}.`);
  }

  // target === "page"
  const pages = (await rest("GET", `pages?select=id,title,position,created_at&pin_id=eq.${enc(pin.id)}`)).sort(byPosition);
  let page;
  if (cmd.pageNumber !== undefined) {
    page = pages[cmd.pageNumber - 1];
    if (!page) return out("skipped_not_found", `Pin "${pin.title}" has ${pages.length} page(s); there is no page ${cmd.pageNumber}.`);
  } else {
    const ph = pages.filter(pg => pg.title && exactCI(pg.title) === exactCI(cmd.page));
    if (ph.length === 0) return out("skipped_not_found", `No page titled "${cmd.page}" in pin "${pin.title}".`);
    if (ph.length > 1) return out("skipped_ambiguous", `${ph.length} pages are titled "${cmd.page}" in pin "${pin.title}"; use "pageNumber".`);
    page = ph[0];
  }
  matched.pageId = page.id;
  const number = pages.indexOf(page) + 1;
  if (cmd.op === "delete") {
    if (!dry) await rest("DELETE", `pages?id=eq.${enc(page.id)}`);
    return out("ok", `Deleted page ${number}${page.title ? ` "${page.title}"` : ""} from pin "${pin.title}".`, { pageNumber: number });
  }
  const patch = {};
  if (cmd.title !== undefined) patch.title = cmd.title.trim() || null;
  if (cmd.body !== undefined) patch.body = cmd.body;
  if (!dry) await rest("PATCH", `pages?id=eq.${enc(page.id)}`, patch);
  return out("ok", `Updated page ${number} of pin "${pin.title}".`, { pageNumber: number });
}

async function commandFileMode(args) {
  const dry = !!args["dry-run"];
  const result = { status: "error", op: null, input: null, matched: { dayId: null, pinId: null, pageId: null, pinTitle: null }, message: "", processedAt: null };
  let exitCode = 0;
  try {
    const text = readFileSync(args["command-file"], "utf8"); // missing file = real failure
    let raw;
    try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); }
    catch (e) { result.input = text.slice(0, 2000); throw new InvalidInput(`Not valid JSON: ${e.message}`); }
    result.input = raw;
    result.op = raw && typeof raw === "object" ? raw.op ?? null : null;
    const cmd = validate(raw);
    const api = await connect();
    Object.assign(result, await runCommand(cmd, api, dry));
    result.date = cmd.date;
  } catch (e) {
    if (e instanceof InvalidInput) { result.status = "error_invalid"; result.message = e.message; }
    else { result.status = "error"; result.message = e.message; exitCode = 1; }
  }
  if (dry) { result.dryRun = true; result.message = `[dry run, nothing written] ${result.message}`; }
  result.processedAt = new Date().toISOString();
  // key order: status, op, input, matched, message, processedAt, then extras
  const ordered = { status: result.status, op: result.op, input: result.input, matched: result.matched, message: result.message, processedAt: result.processedAt };
  for (const [k, v] of Object.entries(result)) if (!(k in ordered)) ordered[k] = v;
  const json = JSON.stringify(ordered, null, 2) + "\n";
  if (args["result-file"]) {
    mkdirSync(dirname(args["result-file"]), { recursive: true });
    writeFileSync(args["result-file"], json);
  }
  process.stdout.write(json);
  return exitCode;
}

/* ------------------------------------------------------------------ */
/* quick-add CLI mode (unchanged behaviour)                            */
/* ------------------------------------------------------------------ */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function cliMode(args) {
  if (!args.pin) throw new Error('--pin "Topic" is required.');
  const date = args.date || todayNY();
  if (!isValidDate(date)) throw new Error("--date must be YYYY-MM-DD.");

  let body = args.body ?? "";
  if (args["body-file"]) body = readFileSync(args["body-file"], "utf8");
  else if (body === "-") body = (await readStdin()).replace(/\s+$/, "");
  else body = body.replace(/\\n/g, "\n"); // allow a literal \n in --body for line breaks
  const pageTitle = args["page-title"] || null;
  if (!body.trim() && !pageTitle) throw new Error("Nothing to post: give --body/--body-file and/or --page-title.");

  const { rest, authMode } = await connect();
  const dry = !!args["dry-run"];
  const log = (...m) => console.error(...m);
  log(`Posting as ${authMode}${dry ? " [dry run]" : ""}`);

  let [day] = await rest("GET", `days?select=id,board_date&board_date=eq.${enc(date)}`);
  if (!day) {
    log(`Creating day ${date}`);
    day = dry ? { id: "(new-day)" } : (await rest("POST", "days", { board_date: date, title: args["day-title"] || null }))[0];
  }
  const pins = day.id === "(new-day)" ? [] :
    await rest("GET", `pins?select=id,title,position&day_id=eq.${enc(day.id)}&order=position.asc`);
  const wanted = args.pin.trim().toLowerCase();
  let pin = pins.find(p => p.title.trim().toLowerCase() === wanted);
  if (!pin) {
    const position = pins.reduce((m, p) => Math.max(m, (p.position ?? 0) + 1), 0);
    const color = COLORS.includes(args.color) ? args.color : COLORS[position % COLORS.length];
    log(`Creating pin "${args.pin}" (${color})`);
    pin = dry ? { id: "(new-pin)" } : (await rest("POST", "pins", { day_id: day.id, title: args.pin.trim(), color, position }))[0];
  }
  const pages = pin.id === "(new-pin)" ? [] :
    await rest("GET", `pages?select=id,position&pin_id=eq.${enc(pin.id)}`);
  const position = pages.reduce((m, p) => Math.max(m, (p.position ?? 0) + 1), 0);
  log(`Appending page ${position + 1}${pageTitle ? ` "${pageTitle}"` : ""}`);
  const page = dry ? { id: "(new-page)" } :
    (await rest("POST", "pages", { pin_id: pin.id, title: pageTitle, body, position }))[0];
  console.log(JSON.stringify({ ok: true, dry_run: dry, date, day_id: day.id, pin_id: pin.id, page_id: page.id, page_number: position + 1 }));
  return 0;
}

/* ------------------------------------------------------------------ */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === "dry-run" || key === "help") { out[key] = true; continue; }
    const val = argv[i + 1];
    if (val === undefined || (val.startsWith("--") && val !== "-")) throw new Error(`Missing value for --${key}`);
    out[key] = val; i++;
  }
  return out;
}
function usage() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`Error: ${e.message}`); return 2; }
  if (args.help) { usage(); return 0; }
  if (args["command-file"]) return commandFileMode(args);
  return cliMode(args);
}

main().then(code => process.exit(code ?? 0), err => { console.error(`Error: ${err.message}`); process.exit(1); });

