#!/usr/bin/env bash
# Runs the "Process command files" step of .github/workflows/inbox.yml locally, against tests/mock.mjs and a
# throwaway git remote, with `bash -e` exactly like GitHub runs it. No network. Needs bash, git, node and curl.
#   Usage: bash tests/workflow.sh
# Cases C and F wait ~10 s and ~22 s on purpose (the step's push retry back-off).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${MOCK_PORT:-54395}"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export SUPABASE_URL="http://127.0.0.1:$PORT" SUPABASE_ANON_KEY=x SUPABASE_OWNER_EMAIL=a SUPABASE_OWNER_PASSWORD=b
unset SUPABASE_SERVICE_KEY SUPABASE_KEY

node "$HERE/mock.mjs" "$PORT" 2>/dev/null & MOCK=$!
trap 'kill $MOCK 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$PORT/_ctl/state" >/dev/null && break; sleep 0.1; done

# The step's script, exactly as it is in the workflow file.
STEP="$WORK/step.sh"
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split(/\r?\n/);
  const at = lines.findIndex(l => /- name: Process command files/.test(l));
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = lines[run + 1].match(/^ */)[0].length, out = [];
  for (const l of lines.slice(run + 1)) { if (l.trim() && l.match(/^ */)[0].length < indent) break; out.push(l.slice(indent)); }
  require("fs").writeFileSync(process.argv[2], out.join("\n") + "\n");
' "$ROOT/.github/workflows/inbox.yml" "$STEP"

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }
ctl() { curl -s -X POST "http://127.0.0.1:$PORT/_ctl/$1" -d "${2:-{\}}" >/dev/null; }
pages() { curl -s "http://127.0.0.1:$PORT/_ctl/state" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).pages.length)'; }
page_titles() { curl -s "http://127.0.0.1:$PORT/_ctl/state" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).pages.map(p => p.title).sort().join(","))'; }
seed() { curl -s -X POST "http://127.0.0.1:$PORT/_ctl/seed" -d "$1" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).id)'; }

# setup CASE: bare remote with an inbox branch, a checkout of it, and main's scripts next to it (like the workflow)
setup() {
  C="$WORK/$1"; mkdir -p "$C/main-branch/scripts"
  git init -q --bare "$C/origin.git"
  git clone -q "$C/origin.git" "$C/seed" 2>/dev/null
  (cd "$C/seed" && git checkout -q -b inbox && mkdir inbox && echo readme > inbox/README.md && git add -A && git commit -q -m init && git push -q origin inbox)
  git --git-dir="$C/origin.git" symbolic-ref HEAD refs/heads/inbox
  git clone -q -b inbox "$C/origin.git" "$C/inbox-branch"
  cp "$ROOT/scripts/post.mjs" "$C/main-branch/scripts/post.mjs"
  export GITHUB_STEP_SUMMARY="$C/summary.md"; : > "$GITHUB_STEP_SUMMARY"
}
command() { printf '%s' "$2" > "$C/inbox-branch/inbox/$1"; }
push_commands() { (cd "$C/inbox-branch" && git add -A inbox && git commit -q -m "add commands" && git push -q origin HEAD:inbox); }
# GitHub runs a `run:` step with no `shell:` as `bash -e {0}`, so the test does too.
run_step() { (cd "$C/inbox-branch" && bash -e "$STEP") > "$C/log.txt" 2>&1; echo $?; }
reject_pushes() { printf '#!/bin/sh\necho "rejected by test hook" >&2\nexit 1\n' > "$C/origin.git/hooks/pre-receive"; chmod +x "$C/origin.git/hooks/pre-receive"; }
remote_has() { git --git-dir="$C/origin.git" cat-file -e "inbox:$1" 2>/dev/null; }

D=2026-10-05
echo "== A: two commands, both applied"
ctl reset; setup a
command a1.json "{\"op\":\"add\",\"date\":\"$D\",\"pin\":\"AI\",\"title\":\"one\",\"body\":\"first\"}"
command a2.json "{\"op\":\"add\",\"date\":\"$D\",\"pin\":\"Garage\",\"title\":\"two\",\"body\":\"second\"}"
push_commands
code=$(run_step)
check "A exits 0" '[ "$code" = 0 ]'
check "A results pushed" 'remote_has inbox/results/a1.json && remote_has inbox/results/a2.json'
check "A command files removed" '! remote_has inbox/a1.json && ! remote_has inbox/a2.json'
check "A step summary lists both" 'grep -q "a1.json | ok" "$GITHUB_STEP_SUMMARY" && grep -q "a2.json | ok" "$GITHUB_STEP_SUMMARY"'

echo "== B: real failure (sign-in 500) keeps the command"
ctl reset; setup b
command b1.json "{\"op\":\"add\",\"date\":\"$D\",\"pin\":\"AI\",\"body\":\"x\"}"
push_commands
ctl fail '{"match":"AUTH","status":500,"times":99}'
code=$(run_step)
check "B exits 1" '[ "$code" = 1 ]'
check "B command kept for a retry" 'remote_has inbox/b1.json'
check "B error result pushed" 'git --git-dir="$C/origin.git" show inbox:inbox/results/b1.json | grep -q "\"status\": \"error\""'

echo "== C: results can't be pushed -> the run fails loudly"
ctl reset; setup c
command c1.json "{\"op\":\"add\",\"date\":\"$D\",\"pin\":\"AI\",\"body\":\"hello\"}"
command c2.json "{\"op\":\"add\",\"date\":\"$D\",\"pin\":\"AI\"}"   # error_invalid: changes nothing
push_commands
reject_pushes
code=$(run_step)
check "C exits 1 (was 0 before the fix)" '[ "$code" = 1 ]'
check "C prints an ::error:: naming the applied command" 'grep -q "::error::.*c1.json" "$C/log.txt"'
check "C the ::error:: does not name the command that changed nothing" '! grep "::error::" "$C/log.txt" | grep -q "c2.json"'
check "C no rebase or retry after the 5th push" '[ "$(grep -c "Push rejected" "$C/log.txt")" = 4 ]'
check "C the command was applied once" '[ "$(pages)" = 1 ]'

echo "== D: mixed batch (ok delete + failing add) under bash -e"
ctl reset; setup d
day=$(seed "{\"table\":\"days\",\"row\":{\"board_date\":\"$D\"}}")
pin=$(seed "{\"table\":\"pins\",\"row\":{\"day_id\":\"$day\",\"title\":\"AI\",\"color\":\"yellow\",\"position\":0}}")
for i in 0 1 2; do seed "{\"table\":\"pages\",\"row\":{\"pin_id\":\"$pin\",\"title\":\"p$i\",\"body\":\"b$i\",\"position\":$i}}" >/dev/null; done
command d1.json "{\"op\":\"delete\",\"target\":\"page\",\"date\":\"$D\",\"pin\":\"AI\",\"pageNumber\":1}"
command d2.json "{\"op\":\"add\",\"date\":\"$D\",\"pin\":\"AI\",\"title\":\"new\",\"body\":\"n\"}"
push_commands
ctl fail '{"match":"POST /rest/v1/pages","status":500,"times":99}'
code=$(run_step)
check "D exits 1" '[ "$code" = 1 ]'
check "D the ok delete's result is pushed and its command removed" 'remote_has inbox/results/d1.json && ! remote_has inbox/d1.json'
check "D the failed add's error result is pushed and its command kept" 'remote_has inbox/results/d2.json && remote_has inbox/d2.json'
check "D the board lost exactly one page" '[ "$(page_titles)" = "p1,p2" ]'
ctl clearfail
rm -rf "$C/inbox-branch"; git clone -q -b inbox "$C/origin.git" "$C/inbox-branch"   # the re-run starts from a fresh checkout
code=$(run_step)
check "D re-run exits 0 and only retries the failed add" '[ "$code" = 0 ] && [ "$(page_titles)" = "new,p1,p2" ]'
check "D re-run leaves no command files" '! remote_has inbox/d1.json && ! remote_has inbox/d2.json'

echo "== E: first push rejected, second accepted"
ctl reset; setup e
command e1.json "{\"op\":\"add\",\"date\":\"$D\",\"pin\":\"AI\",\"body\":\"hello\"}"
push_commands
printf '#!/bin/sh\nif [ ! -f rejected-once ]; then touch rejected-once; echo "rejected once" >&2; exit 1; fi\nexit 0\n' > "$C/origin.git/hooks/pre-receive"
chmod +x "$C/origin.git/hooks/pre-receive"
code=$(run_step)
check "E exits 0 after a retry" '[ "$code" = 0 ] && grep -q "Push rejected (attempt 1)" "$C/log.txt"'
check "E result pushed and command removed" 'remote_has inbox/results/e1.json && ! remote_has inbox/e1.json'
check "E no ::error::" '! grep -q "::error::" "$C/log.txt"'

echo "== F: rebase conflict on every attempt -> fails loudly, no rebase left in progress"
ctl reset; setup f
command f1.json "{\"op\":\"add\",\"date\":\"$D\",\"pin\":\"AI\",\"body\":\"hello\"}"
push_commands
# Someone changes the same command file on the remote after the runner checked out: modify/delete conflict.
(cd "$C/seed" && git pull -q origin inbox && printf '{"op":"add","date":"%s","pin":"AI","body":"changed"}' "$D" > inbox/f1.json && git commit -qam "edit f1" && git push -q origin HEAD:inbox)
code=$(run_step)
check "F exits 1" '[ "$code" = 1 ]'
check "F warns about the failed rebase and names the applied command" 'grep -q "::warning::Rebase" "$C/log.txt" && grep -q "::error::.*f1.json" "$C/log.txt"'
check "F leaves no rebase in progress" '[ ! -d "$C/inbox-branch/.git/rebase-merge" ] && [ ! -d "$C/inbox-branch/.git/rebase-apply" ]'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
