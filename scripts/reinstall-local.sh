#!/usr/bin/env bash
# Full reset: disable → remove ~/.local copy → build → install → enable → optional logout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="spotify-search@emanuel.github.io"
cd "$ROOT"

echo "==> 1/5 Disabling extension (ok if it was not enabled)"
gnome-extensions disable "$UUID" 2>/dev/null || true

echo "==> 2/5 Removing installed extension directory"
node scripts/uninstall-local.mjs

echo "==> 3/5 Building and copying to ~/.local/share/gnome-shell/extensions/"
npm run install-ext

echo "==> 4/5 Enabling extension"
if gnome-extensions enable "$UUID"; then
  echo "    Enabled $UUID"
else
  echo "    WARN: enable failed. After you log back in, run: gnome-extensions enable $UUID"
fi

echo ""
echo "==> 5/5 GNOME Shell only loads new extension.js after you log out or restart the session."
echo "    If search still does nothing, check: gnome-extensions info $UUID"
echo "    and: journalctl /usr/bin/gnome-shell -b | rg -i 'spotify-search|spotify-search@'"
echo ""

read -r -p "Log out now (ends session immediately, no extra dialog)? [y/N] " ans
if [[ "${ans:-}" =~ ^[Yy]$ ]]; then
  if command -v gnome-session-quit >/dev/null 2>&1; then
    exec gnome-session-quit --logout --no-prompt
  else
    echo "gnome-session-quit not in PATH; please log out manually from the system menu."
  fi
else
  echo "Skipped logout. When ready, log out or press Alt+F2, type r, Enter (X11 only) to restart Shell."
fi
