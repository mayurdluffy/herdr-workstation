#!/usr/bin/env bash
# Herdr Workstation installer.
#
#   curl -fsSL https://raw.githubusercontent.com/mayurdluffy/herdr-workstation/main/install.sh | bash
#   ./install.sh [--no-switch]
#
# Installs into Herdr desktop's home (~/.config/herdr-app, or $HERDR_APP_HOME):
#   layouts/workstation.json, the ws-* mods, usage-limits, and our keys (only where free).
# Tools: plannotator-tui (Homebrew, else cargo).
# Run it again to update. ./uninstall.sh removes what it added.
set -euo pipefail

REPO="mayurdluffy/herdr-workstation"
REF="${HERDR_WORKSTATION_REF:-main}"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-workstation"
MARK=".herdr-workstation"   # in every mod folder we own; others are never overwritten

SWITCH=1
for arg in "$@"; do
  case "$arg" in
    --no-browser|--no-agent-skills) ;;   # accepted for old command lines; there is no browser now
    --no-switch) SWITCH=0 ;;
    -h|--help) sed -n 2,9p "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux) PLATFORM=linux ;;
  *) die "macOS or Linux only" ;;
esac
for tool in curl tar git python3; do have "$tool" || die "$tool is required"; done
have herdr-app || die "Herdr desktop (herdr-app) not found. Install it from https://herdr.dev and start it once."
[ -d "$APP_HOME" ] || die "$APP_HOME not found. Start Herdr desktop once, then run this again."

mkdir -p "$DATA"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---------- this repo: the folder the script is in, else a download ----------
SRC=""
if [ -f "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/vendor.lock" ]; then
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  say "Downloading $REPO@$REF"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$TMP"
  SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
fi

# lib/*.js is copied into the mods that use it (mods can't import from each other).
[ -x "$SRC/scripts/sync-lib.sh" ] && "$SRC/scripts/sync-lib.sh"

# NAME REPO REF [PATH] from vendor.lock
lock() { awk -v n="$1" '$1 == n { print $'"$2"' }' "$SRC/vendor.lock"; }

fetch() { # repo ref → extracted folder
  local dir="$TMP/$(echo "$1" | tr / _)-$2"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    curl -fsSL "https://codeload.github.com/$1/tar.gz/$2" | tar -xz -C "$dir" --strip-components 1
  fi
  echo "$dir"
}

MANIFEST="$DATA/installed"
: > "$MANIFEST.new"
record() { echo "$1" >> "$MANIFEST.new"; }

install_mod() { # source folder, name
  local dst="$APP_HOME/mods/$2"
  if [ -e "$dst" ] && [ ! -e "$dst/$MARK" ]; then
    warn "mods/$2 exists and isn't ours; left as it is"
    return
  fi
  rm -rf "$dst.tmp" && cp -R "$1" "$dst.tmp" && touch "$dst.tmp/$MARK"
  rm -rf "$dst" && mv "$dst.tmp" "$dst"
  record "mods/$2"
  say "mods/$2"
}

# ---------- 1. plannotator-tui ----------
PT_VERSION="$(lock plannotator-tui 3)"
if have plannotator-tui; then
  say "plannotator-tui $(plannotator-tui --version 2>/dev/null | awk '{print $2}') already installed"
elif have brew; then
  say "Installing plannotator-tui (Homebrew)"
  brew trust plannotator/tap >/dev/null 2>&1 || true
  brew install plannotator/tap/plannotator-tui
elif have cargo; then
  say "Installing plannotator-tui $PT_VERSION (cargo)"
  cargo install --locked plannotator-tui --version "$PT_VERSION"
else
  warn "plannotator-tui not installed (needs Homebrew or cargo): review and annotate won't work"
fi

# ---------- 2. our layout and mods ----------
say "Installing into $APP_HOME"
mkdir -p "$APP_HOME/layouts" "$APP_HOME/mods"
for f in workstation.json workstation.svg; do
  dst="$APP_HOME/layouts/$f"
  if [ -e "$dst" ] && ! grep -qx "layouts/$f" "$MANIFEST" 2>/dev/null && ! cmp -s "$SRC/layouts/$f" "$dst"; then
    mv "$dst" "$dst.bak-$(date +%Y%m%d%H%M%S)"
    warn "an existing layouts/$f was kept as $f.bak-*"
  fi
  cp "$SRC/layouts/$f" "$dst"
  record "layouts/$f"
done
for dir in "$SRC"/mods/*/; do install_mod "$dir" "$(basename "$dir")"; done

# ---------- 3. usage-limits (pinned) ----------
UL="$(fetch "$(lock usage-limits 2)" "$(lock usage-limits 3)")"
cp "$UL/LICENSE" "$UL/NOTICE" "$UL/$(lock usage-limits 4)/" 2>/dev/null || true
install_mod "$UL/$(lock usage-limits 4)" usage-limits

# ---------- 4. keys ----------
say "Keys"
python3 "$SRC/scripts/merge-keys.py" add "$SRC/keys.json" "$PLATFORM" "$APP_HOME/keys.json"
cp "$SRC/keys.json" "$DATA/keys.json"
cp "$SRC/scripts/merge-keys.py" "$SRC/uninstall.sh" "$DATA/"

# ---------- 6. check ----------
FAILED=0
while read -r entry; do
  case "$entry" in
    mods/*)
      if ! out="$(herdr-app check "$APP_HOME/$entry" 2>&1)"; then
        warn "$entry failed its check:"; echo "$out" | tail -5 >&2; FAILED=1
      fi ;;
  esac
done < "$MANIFEST.new"
mv "$MANIFEST.new" "$MANIFEST"
[ "$FAILED" = 0 ] || die "a mod failed its check (see above)"

# ---------- 6b. forks ----------
# ws-tabs, ws-files, ... are copies of Herdr's own mods: say when Herdr has changed those since.
if [ -x "$SRC/scripts/forks.sh" ]; then
  out="$(HERDR_APP_HOME="$APP_HOME" "$SRC/scripts/forks.sh" --quiet 2>/dev/null || true)"
  if [ -n "$out" ]; then
    warn "Herdr has changed mods the Workstation copies; those copies lack Herdr's newest changes until they're merged:"
    echo "$out" | sed 's/^/  /' >&2
  fi
fi

# ---------- 7. show it ----------
if [ "$SWITCH" = 1 ] && herdr-app status >/dev/null 2>&1; then
  herdr-app do layout.switch --name workstation >/dev/null && say "Switched to the Workstation layout"
  sleep 1
  [ -e "$APP_HOME/layout.error" ] && warn "layout.error: $(cat "$APP_HOME/layout.error")"
fi

KEY=$([ "$PLATFORM" = macos ] && echo "cmd-shift-k" || echo "ctrl-alt-k")
cat <<EOF

Herdr Workstation is installed.
  $KEY            Workstation menu (review, annotate, git graph, Markdown, usage)
  Ctrl/Cmd-click   a .md path in a terminal: preview it beside the pane
  layout.switch    back to your previous layout: cmd-shift-l (Linux: ctrl-shift-l)
  Uninstall:       bash "$DATA/uninstall.sh"
EOF
