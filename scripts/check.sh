#!/usr/bin/env bash
# Everything that should pass before a commit goes to origin:
#   lib/ copies in sync, node tests, herdr-app check on every mod (when Herdr is here),
#   and whether Herdr changed the mods we copy.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== lib copies"
scripts/sync-lib.sh --check && echo "ok" || fail=1

echo "== tests"
npm test --silent || fail=1

if command -v herdr-app >/dev/null 2>&1; then
  echo "== herdr-app check"
  for dir in mods/*/; do
    if out="$(herdr-app check "$dir" 2>&1)"; then echo "ok   $dir"; else echo "FAIL $dir"; echo "$out" | grep -v WARN | tail -5; fail=1; fi
  done
  echo "== forks"
  scripts/forks.sh || true
else
  echo "(herdr-app not found: mods not checked)"
fi
exit "$fail"
