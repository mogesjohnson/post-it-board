#!/usr/bin/env node
// Post a note to the Post-it Board (Supabase). Node 18+ (uses global fetch). No dependencies.
//
//   node scripts/post.mjs --date 2026-10-05 --pin "AI" --page-title "LLMs" --body "..."
//
// Finds (or creates) the day and the pin (topic, case-insensitive match), then appends a page.
//
// Options:
//   --date YYYY-MM-DD   board day (default: today, local time)
//   --pin "Topic"       pin / topic title (required)
//   --page-title "..."  optional page title
//   --body "..."        page text; use "--body -" to read it from stdin
//   --body-file path    read page text from a file
//   --color yellow|pink|blue|green   color for a NEW pin (default: rotates)
//   --day-title "..."   title for a NEW day
//   --dry-run           show what would happen without writing
//
// Environment (never commit these):
//   SUPABASE_URL              https://<ref>.supabase.co                  (required)
//   SUPABASE_ANON_KEY         public anon key (needed for owner sign-in)
//   SUPABASE_OWNER_EMAIL      bot/owner account email     } preferred: signs in as a board owner
//   SUPABASE_OWNER_PASSWORD   bot/owner account password  } (listed in public.board_owners), so RLS applies
//                             e.g. the bot account johnsonmoges+postit-bot@gmail.com
//   SUPABASE_SERVICE_KEY      fallback only (bypasses RLS) — alias: SUPABASE_KEY

import { readFileSync } from "node:fs";

const COLORS = ["yellow", "pink", "blue", "green"];

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

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function usage(code = 0) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage(0);

  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const email = process.env.SUPABASE_OWNER_EMAIL || "";
  const password = process.env.SUPABASE_OWNER_PASSWORD || "";
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "";

  if (!url) throw new Error("SUPABASE_URL is not set.");
  if (!args.pin) throw new Error('--pin "Topic" is required.');
  const date = args.date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD.");

  let body = args.body ?? "";
  if (args["body-file"]) body = readFileSync(args["body-file"], "utf8");
  else if (body === "-") body = (await readStdin()).replace(/\s+$/, "");
  else body = body.replace(/\\n/g, "\n"); // allow a literal \n in --body for line breaks
  const pageTitle = args["page-title"] || null;
  if (!body.trim() && !pageTitle) throw new Error("Nothing to post: give --body/--body-file and/or --page-title.");

  // ---- auth: owner sign-in (RLS applies) preferred, service key as fallback ----
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
    if (!res.ok) throw new Error(`Owner sign-in failed: ${data.error_description || data.msg || res.status}`);
    apikey = key; bearer = data.access_token; authMode = `owner (${email})`;
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
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const hint = /row-level security/i.test(data?.message || "") ? " (this account is not in public.board_owners)" : "";
      throw new Error(`${method} ${path.split("?")[0]} failed (${res.status}): ${data?.message || text}${hint}`);
    }
    if (method !== "GET" && Array.isArray(data) && data.length === 0) {
      throw new Error(`${method} ${path.split("?")[0]} affected no rows — is this account listed in public.board_owners?`);
    }
    return data;
  }
  const enc = encodeURIComponent;
  const dry = !!args["dry-run"];
  const log = (...m) => console.error(...m);
  log(`Posting as ${authMode}${dry ? " [dry run]" : ""}`);

  // ---- day ----
  let [day] = await rest("GET", `days?select=id,board_date&board_date=eq.${enc(date)}`);
  if (!day) {
    log(`Creating day ${date}`);
    day = dry ? { id: "(new-day)" } : (await rest("POST", "days", { board_date: date, title: args["day-title"] || null }))[0];
  }

  // ---- pin (topic) ----
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

  // ---- page ----
  const pages = pin.id === "(new-pin)" ? [] :
    await rest("GET", `pages?select=id,position&pin_id=eq.${enc(pin.id)}`);
  const position = pages.reduce((m, p) => Math.max(m, (p.position ?? 0) + 1), 0);
  log(`Appending page ${position + 1}${pageTitle ? ` "${pageTitle}"` : ""}`);
  const page = dry ? { id: "(new-page)" } :
    (await rest("POST", "pages", { pin_id: pin.id, title: pageTitle, body, position }))[0];

  console.log(JSON.stringify({ ok: true, dry_run: dry, date, day_id: day.id, pin_id: pin.id, page_id: page.id, page_number: position + 1 }));
}

main().catch(err => { console.error(`Error: ${err.message}`); process.exit(1); });
