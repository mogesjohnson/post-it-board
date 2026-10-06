# 📥 Post-it Board inbox

This branch (`inbox`) is the write path for assistants such as **Ara**. To add, edit or delete notes on
https://mogesjohnson.github.io/post-it-board/, push **one JSON file per command** to `inbox/` on this branch.

1. Push `inbox/<unique-name>.json` (top level of `inbox/`, name ending in `.json`).
2. The **inbox** GitHub Actions workflow runs (usually within a minute). It applies the command to Supabase as
   the bot account, writes the result to `inbox/results/<same name>.json`, deletes the command file and pushes
   back with `inbox: processed … [skip ci]`.
3. Read `inbox/results/<same name>.json` to see what happened.

Use a unique file name per command, e.g. `2026-10-05T20-41-07Z-add-ai.json`. If you reuse a name, the old
result is overwritten. Pull before you push: the workflow pushes to this branch too.

## Command format

```jsonc
{
  "op": "add" | "edit" | "delete",   // required
  "date": "YYYY-MM-DD",              // optional; default = today in America/New_York
  "pin": "Topic",                    // required: the pin (topic) title
  "title": "Page title",             // add: page title (optional) · edit page: NEW page title ("" clears it)
  "body": "Text…",                   // add: page text · edit page: NEW page text
  "color": "yellow|pink|blue|green", // add: color of a NEW pin · edit pin: new color
  "target": "pin" | "page",          // required for edit/delete
  "page": "Existing page title",     // edit/delete page: which page (exact title) …
  "pageNumber": 2,                   // … or which page by number (1 = first, at most 10000). Exactly one of the two.
  "newPin": "Renamed topic"          // edit pin: new pin title
}
```

Limits: `pin`, `title`, `page`, `newPin` ≤ 200 characters; `body` ≤ 5000 characters; `pageNumber` is a whole
number from 1 to 10000 (a number, not a string). Line breaks in `body` are kept (`\n` in JSON).

### How matching works

- **add** finds the pin on that day **loosely**:
  - case, spaces, punctuation and Latin accents are ignored ("post-it board" = "Post-it Board", "cafe" =
    "Café"). A match like this always wins: the typo and prefix rules below are only tried when there is none;
  - a small typo is allowed in words made only of letters, 5+ letters long in both spellings: one missing,
    extra or swapped letter that keeps the first letter, in at most 2 words of a title with the same number of
    words ("QA Live Zebar" → "QA Live Zebra", "AI agent" → "AI agents"). A *changed* letter never counts, and
    short words and numbers must match exactly, so "Code"/"Node", "Cars"/"Cats", "Bread"/"Break",
    "Watch"/"Match", "AI"/"UI" and "Order 10243"/"Order 10234" stay separate;
  - a whole-word prefix also matches ("Python lists" → "Python") when the shorter title has 4+ letters or
    digits (spaces don't count, so "Git" and "Git tips" stay separate);
  - a title with no letters or digits (e.g. "🚗") must match exactly (ignoring case, extra spaces, and the
    emoji variation selector, so ❤️ = ❤).

  Known trade-offs: real words one missing, extra or swapped letter apart still merge ("Plants"/"Planets",
  "Trail"/"Trial", "Diary"/"Dairy", "Angel"/"Angle"), and plurals of 4-letter words don't ("Lesson plan" makes
  a new pin next to "Lesson plans"). **Reuse the exact pin title** when you know it.

  Then:
  - one match → the page is appended to that pin
  - no match → a new pin is created (and the day, if needed)
  - several possible typo/prefix matches (and no exact one) → nothing is written, status `skipped_ambiguous`
    (see `candidates`)
  - a page with the same title **and** body already added to that pin in the last 10 minutes → status
    `skipped_duplicate` (`matched.pageId` and `pageNumber` point at that page)
- **edit / delete** never guess: the pin title must match **exactly** (ignoring case and extra spaces) on
  that day (default today). A page must match its exact title or `pageNumber`. Zero matches →
  `skipped_not_found`; more than one → `skipped_ambiguous`. Renaming a pin to a title another pin on that day
  already has is also `skipped_ambiguous` (nothing changes).
- Deleting a pin permanently deletes all its pages. There is no undo.

## Result file

```json
{
  "status": "ok",
  "op": "add",
  "input": { "...": "the command as received" },
  "matched": { "dayId": "…", "pinId": "…", "pageId": "…", "pinTitle": "AI" },
  "message": "using pin \"AI\"; added page 3 \"LLMs\".",
  "processedAt": "2026-10-06T00:41:09.512Z",
  "matchType": "exact | fuzzy | new",
  "pageNumber": 3,
  "date": "2026-10-05"
}
```

`status`, `op`, `input`, `matched` (fields may be `null`), `message` and `processedAt` are always there. The
rest depend on the outcome:

| field | present when |
|-------|--------------|
| `matchType` | `add` with status `ok` or `skipped_duplicate` |
| `pageNumber` | `add` with `ok` / `skipped_duplicate`, and page edits/deletes with `ok`; never for pin edits/deletes or other statuses |
| `candidates` | `add` with `skipped_ambiguous`: `[{pinId, pinTitle}, …]` |
| `date` | every status except `error` and `error_invalid` |
| `dryRun` | only for `--dry-run` runs |

`input` is the parsed command, or the raw file text (first 2000 characters) when it wasn't valid JSON.

| status | meaning | command file |
|--------|---------|--------------|
| `ok` | done | removed |
| `skipped_duplicate` | a page with the same title and text was added to that pin in the last 10 min | removed |
| `skipped_ambiguous` | more than one pin/page could match, or a rename would clash, so nothing changed | removed |
| `skipped_not_found` | the day/pin/page doesn't exist, so nothing changed | removed |
| `error_invalid` | bad JSON or bad fields (see `message`) | removed |
| `error` | real failure (network, auth, database) | **kept**, re-run the workflow to retry |

One failed command doesn't stop the others in the same run. If the workflow can't push the results back to this
branch (5 attempts), the run **fails** with an error that names only the commands that changed the board
(status `ok`). Their files are still in `inbox/`, so the next run (a manual re-run, or any new command pushed
here) would apply them again: delete just those command files right away. Leave the others; they didn't change
anything.

## Examples

Add a page (creates the pin if needed):
```json
{"op": "add", "pin": "AI", "title": "LLMs", "body": "Large language models predict the next word.\nThey power chat assistants."}
```

Edit page 2 of a pin (new title and text):
```json
{"op": "edit", "target": "page", "date": "2026-10-05", "pin": "AI", "pageNumber": 2, "title": "LLMs (updated)", "body": "Corrected text."}
```

Delete a whole pin and all its pages:
```json
{"op": "delete", "target": "pin", "date": "2026-10-05", "pin": "AI"}
```

More: rename a pin `{"op":"edit","target":"pin","pin":"AI","newPin":"Artificial Intelligence","color":"blue"}` ·
delete one page by title `{"op":"delete","target":"page","pin":"AI","page":"LLMs"}`.

## Pushing a command with the GitHub API (no clone needed)

```bash
NAME="inbox/$(date -u +%Y-%m-%dT%H-%M-%SZ)-add.json"
CONTENT=$(printf '%s' '{"op":"add","pin":"AI","title":"LLMs","body":"..."}' | base64 | tr -d '\n')   # GNU and macOS
gh api -X PUT "repos/mogesjohnson/post-it-board/contents/$NAME" \
  -f message="inbox: add note" -f branch=inbox -f content="$CONTENT"
# then, a minute later (older macOS: base64 -D):
gh api "repos/mogesjohnson/post-it-board/contents/inbox/results/$(basename "$NAME")?ref=inbox" --jq .content | base64 --decode
```
