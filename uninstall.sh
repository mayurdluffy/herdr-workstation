#!/usr/bin/env bash
# Removes what install.sh added: our layout and mods (only folders it marked), our keys
# (only where they still hold our action) and, if installed, herdr-web-browser's parts.
# Tools stay installed: `brew uninstall plannotator-tui`, `rustup self uninstall`.
set -euo pipefail

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-workstation"
MANIFEST="$DATA/installed"
[ -f "$MANIFEST" ] || { echo "Nothing to uninstall ($MANIFEST not found)."; exit 0; }
case "$(uname -s)" in Darwin) PLATFORM=macos ;; *) PLATFORM=linux ;; esac

# Leave the layout first, so Herdr isn't showing what we remove.
if herdr-app status 2>/dev/null | grep -q '"layout": "workstation"'; then
  herdr-app do layout.switch --name main >/dev/null 2>&1 || true
fi

while read -r entry; do
  case "$entry" in
    mods/*) [ -e "$APP_HOME/$entry/.herdr-workstation" ] && rm -rf "${APP_HOME:?}/$entry" && echo "removed $entry" ;;
    layouts/*) rm -f "$APP_HOME/$entry" && echo "removed $entry" ;;
    browser)
      if [ -x "$DATA/herdr-web-browser/target/release/herdr-web-browser" ]; then
        HERDR_APP_HOME="$APP_HOME" "$DATA/herdr-web-browser/target/release/herdr-web-browser" uninstall || true
      fi ;;
  esac
done < "$MANIFEST"

[ -f "$DATA/keys.json" ] && python3 "$DATA/merge-keys.py" remove "$DATA/keys.json" "$PLATFORM" "$APP_HOME/keys.json"
rm -rf "$DATA"
echo "Herdr Workstation removed."
