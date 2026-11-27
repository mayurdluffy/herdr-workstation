#!/usr/bin/env bash
# Herdr mods can't import from each other's folders, so lib/*.js is copied into
# every mod that uses it. Edit lib/, then run this (install.sh runs it too).
set -euo pipefail
cd "$(dirname "$0")/.."
for mod in ws-comment ws-comments; do cp lib/comments.js "mods/$mod/comments.js"; done
for mod in ws-review ws-git; do cp lib/git-actions.js "mods/$mod/git-actions.js"; done
for mod in ws-spaces ws-picker; do cp lib/space-look.js "mods/$mod/space-look.js"; done
