#!/bin/sh
# Wraps the universal Grub.app in a compressed DMG whose window is laid out and styled for Grub:
# background, icon positions and window size come from scripts/dmg-settings.py.
# dmgbuild writes the window layout directly (no Finder scripting); it lives in a private venv under out/.
set -e
cd "$(dirname "$0")/.."
APP="out/Grub-darwin-universal/Grub.app"
DMG="out/Grub.dmg"
VENV="out/.dmgbuild"
if [ ! -x "$VENV/bin/dmgbuild" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check dmgbuild
fi
rm -f "$DMG"
"$VENV/bin/dmgbuild" -s scripts/dmg-settings.py -D app="$APP" "Grub" "$DMG" >/dev/null
echo "$DMG"
