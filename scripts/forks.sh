#!/usr/bin/env bash
# Our copies of Herdr's shipped mods (upstream/forks) don't pick up Herdr's changes by
# themselves. This compares Herdr's installed mods with the base each copy was made from
# (upstream/<name>/main.js) and merges what changed into ours.
#
#   scripts/forks.sh            status: which upstream mods changed since our last merge
#   scripts/forks.sh merge      three-way merge each change into mods/ws-*/main.js; the base
#                               moves to Herdr's new file. Conflicts are left marked in ours
#                               (<<<<<<<); resolve them, then herdr-app check the mod.
#   scripts/forks.sh --quiet    status, printing only when something changed (install.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODE="${1:-status}"
QUIET=0; [ "$MODE" = "--quiet" ] && { QUIET=1; MODE=status; }
have_version="$(herdr-app --version 2>/dev/null | awk '{print $2}' || true)"
base_version="$(cat upstream/VERSION 2>/dev/null || echo "?")"
changed=0; conflicts=0

while read -r ours up; do
  case "$ours" in ''|\#*) continue ;; esac
  base="upstream/$up/main.js"; theirs="$APP_HOME/mods/$up/main.js"; mine="mods/$ours/main.js"
  if [ ! -f "$theirs" ]; then [ "$QUIET" = 1 ] || echo "$ours: Herdr has no mods/$up here (start Herdr once)"; continue; fi
  if cmp -s "$base" "$theirs"; then [ "$QUIET" = 1 ] || echo "$ours: up to date with Herdr's $up"; continue; fi
  changed=$((changed + 1))
  lines="$(diff "$base" "$theirs" | grep -c '^[<>]' || true)"
  if [ "$MODE" != merge ]; then
    echo "$ours: Herdr's $up changed since our copy ($lines lines, Herdr $base_version -> ${have_version:-?}). Run scripts/forks.sh merge."
    continue
  fi
  tmp="$(mktemp)"
  if git merge-file -p -L "ours ($ours)" -L "base ($up $base_version)" -L "Herdr ($up ${have_version:-new})" "$mine" "$base" "$theirs" > "$tmp"; then
    echo "$ours: merged Herdr's $up cleanly ($lines lines)"
  else
    conflicts=$((conflicts + 1))
    echo "$ours: merged with conflicts: resolve the <<<<<<< blocks in $mine"
  fi
  mv "$tmp" "$mine"
  cp "$theirs" "$base"
done < upstream/forks

if [ "$MODE" = merge ] && [ "$changed" -gt 0 ]; then
  [ -n "$have_version" ] && echo "$have_version" > upstream/VERSION
  echo "Then: herdr-app check each merged mod, ./install.sh, and look at it in Herdr."
fi
[ "$conflicts" = 0 ]
