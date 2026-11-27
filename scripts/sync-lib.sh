#!/usr/bin/env bash
# Herdr mods can't import from each other's folders, so lib/*.js is copied into
# every mod that uses it. Edit lib/, then run this (install.sh runs it too).
set -euo pipefail
cd "$(dirname "$0")/.."
for mod in ws-comment ws-comments; do cp lib/comments.js "mods/$mod/comments.js"; done
