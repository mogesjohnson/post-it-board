# 📌 Post-it Board

A tiny static website that looks like a middle-school classroom corkboard.
Each **day** gets its own board. Each conversation **topic** is one **pin** (a colored
sticky note), and each pin holds one or more **pages** of notes.

**Live site:** https://mogesjohnson.github.io/post-it-board/ (once GitHub Pages is on, see below)

Plain HTML + CSS + vanilla JS. No frameworks, no build step, no dependencies.

![Demo board](docs/screenshot.jpg)

## Data model

```
Day (board_date)            e.g. 2026-10-05
 └─ Pin (topic)             e.g. "AI"         <- one sticky note per topic
     └─ Page (note)         e.g. page 1 "What is AI", page 2 "LLMs"
```

| table   | columns |
|---------|---------|
| `days`  | `id`, `board_date` (unique), `title`, `created_at` |
| `pins`  | `id`, `day_id → days` (on delete cascade), `title`, `color` (yellow/pink/blue/green), `position`, `created_at`, `updated_at` |
| `pages` | `id`, `pin_id → pins` (on delete cascade), `title`, `body`, `position`, `created_at`, `updated_at` |

Deleting a pin permanently deletes its pages. There is no recycle bin.

## Using the board

- **Day picker** (top): newest day first. Use ‹ › to step to older/newer days.
- **Click a pin** to open it. You see page 1, can go to the previous/next page (or use ← →), and can
  jump with the page chips. **← All pins** (or Esc) takes you back.
- **Owner tools** (only when signed in, or in demo mode):
  - **+** adds a pin (on the board) or a page (inside a pin); **+ day** starts a new day.
  - **✎** renames a pin or edits a page.
  - **☑ Select mode** puts a checkbox on every pin (the whole pin, all pages) and on every page.
    The **🗑 trash can** asks you to confirm, then deletes the selected items for good.
- **🔒 Lock icon:** owner sign-in (email + password). Everyone else gets a read-only board.

Links are shareable via the URL hash, e.g. `#day=2026-10-05&pin=<id>&page=2`.

## Files

| file | what it does |
|------|--------------|
| `index.html` | page layout and decorations (ruler, apple, pencil cup, gold star) |
| `styles.css` | corkboard, wooden frame, sticky notes, pushpins, animations, phone layout |
| `app.js` | the UI: days, pins, pages, select mode, delete, sign-in |
| `store.js` | storage layer (Supabase REST or local demo) + Supabase Auth session |
| `config.js` | Supabase URL + **public anon key** (empty = demo mode) |
| `config.example.js` | example of a filled config |
| `supabase/schema.sql` | tables, cascade deletes, Row Level Security policies |
| `scripts/post.mjs` | command-line poster the bot uses |
| `scripts/write-config.mjs` | writes `config.js` from env vars |
| `.nojekyll` | tells GitHub Pages to serve files as-is |

## Demo mode

If `config.js` is empty, the board runs in **demo mode**: data lives in your browser's
`localStorage`, seeded with one day containing the pin **AI** (pages "What is AI", "LLMs") and the pin
**Agents** (page "LLMs with loops"). A banner says *"Demo mode — Supabase not connected"*. Everything
works (add, edit, delete), but only in that browser. To reset the demo, clear the site data
(or run `localStorage.removeItem("postit.demo.v1")` in the console).

## Connecting Supabase (free plan)

Everything here works on the free plan: just Postgres tables, Row Level Security and Supabase Auth.
No Edge Functions, no paid add-ons.

**Who can do what**

| who | read | add / edit / delete |
|-----|------|---------------------|
| anyone with the site (anon key) | ✅ | ❌ |
| the owner, signed in | ✅ | ✅ |
| any other signed-in user | ✅ | ❌ |

Steps:

1. **Create the owner account.** In the Supabase dashboard go to *Authentication → Users → Add user*.
   Enter your email and a strong password, and tick "Auto confirm user". Copy the user's **UID**.
   Then turn off public sign-ups (*Authentication → Sign In / Providers → Allow new users to sign up* = off).
2. **Create the tables.** Open `supabase/schema.sql` and replace every `<OWNER_USER_UUID>` with that UID
   (9 occurrences; Find & Replace). Paste it into *SQL Editor* and click **Run**. If you forget to
   replace it, the script fails without changing anything.
3. **Point the site at your project.** Find the values in *Project Settings → API*:
   ```bash
   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<public anon key> node scripts/write-config.mjs
   git add config.js && git commit -m "Connect Supabase" && git push
   ```
   (Or just edit `config.js` by hand.) The anon/publishable key is **meant to be public**. RLS keeps it
   read-only. **Never** put the `service_role` / secret key in `config.js`. The script refuses it.
4. Open the site and click the **🔒 lock**. Sign in with the owner email and password. The **+**, select and
   trash tools appear. The session is kept in `localStorage` and refreshed automatically. Click the lock
   again to sign out.

## How the bot posts

`scripts/post.mjs` (Node 18+, no dependencies) finds or creates the day, finds or creates the pin
(the topic name is matched without regard to case), and appends a page at the end:

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_ANON_KEY=<public anon key>
export SUPABASE_OWNER_EMAIL=<owner email>         # preferred: signs in as the owner, so RLS applies
export SUPABASE_OWNER_PASSWORD=<owner password>

node scripts/post.mjs --date 2026-10-05 --pin "AI" --page-title "LLMs" --body "Large language models predict the next word."
echo "long text..." | node scripts/post.mjs --pin "Agents" --page-title "Loops" --body -
node scripts/post.mjs --pin "Python" --body-file notes.txt --color green
node scripts/post.mjs --pin "AI" --body "test" --dry-run        # shows what it would do
```

- `--date` defaults to today. `--color` and `--day-title` only apply when the pin or day is created.
- A literal `\n` inside `--body` becomes a line break.
- Fallback auth: if `SUPABASE_OWNER_EMAIL`/`PASSWORD` aren't set, it uses `SUPABASE_SERVICE_KEY`
  (alias `SUPABASE_KEY`), which bypasses RLS. Keep that key secret and out of the repo.
- It prints one JSON line (`day_id`, `pin_id`, `page_id`, `page_number`) on success.

Credentials only ever come from environment variables. Nothing secret is stored in this repo.

## GitHub Pages

*Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.*
After a minute the board is live at https://mogesjohnson.github.io/post-it-board/.

## Local preview

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
