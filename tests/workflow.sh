#!/usr/bin/env bash
# Runs the "Process command files" step of .github/workflows/inbox.yml locally, against tests/mock.mjs and a
# throwaway git remote. No network. Needs bash, git, node and curl.  Usage: bash tests/workflow.sh
# Case C waits ~15 s on purpose (the step's push retry back-off).
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
run_step() { (cd "$C/inbox-branch" && bash "$STEP") > "$C/log.txt" 2>&1; echo $?; }
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
push_commands
printf '#!/bin/sh\necho "rejected by test hook" >&2\nexit 1\n' > "$C/origin.git/hooks/pre-receive"; chmod +x "$C/origin.git/hooks/pre-receive"
code=$(run_step)
check "C exits 1 (was 0 before the fix)" '[ "$code" = 1 ]'
check "C prints an ::error:: naming the applied command" 'grep -q "::error::.*c1.json" "$C/log.txt"'
check "C the command was applied once" '[ "$(pages)" = 1 ]'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
