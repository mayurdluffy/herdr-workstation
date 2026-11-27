#!/usr/bin/env bash
# Herdr mods can't import from each other's folders, so lib/*.js is copied into
# every mod that uses it. Edit lib/, then run this (install.sh runs it too).
#   scripts/sync-lib.sh --check   only report stale copies (exit 1 if any)
set -euo pipefail
cd "$(dirname "$0")/.."
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
stale=0
copy() { # lib file, mods...
  local src="lib/$1"; shift
  for mod in "$@"; do
    local dst="mods/$mod/$(basename "$src")"
    if [ "$CHECK" = 1 ]; then cmp -s "$src" "$dst" || { echo "stale: $dst (run scripts/sync-lib.sh)"; stale=1; }
    else cp "$src" "$dst"; fi
  done
}
copy comments.js ws-comment ws-comments ws-activity ws-prs
copy git-actions.js ws-review ws-git
copy space-look.js ws-spaces ws-picker
copy diff-words.js ws-review ws-git-graph ws-prs
exit "$stale"
