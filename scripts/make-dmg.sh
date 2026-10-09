#!/bin/sh
# Wraps each Grub.app build in a compressed DMG whose window is laid out and styled for Grub:
# background, icon positions and window size come from scripts/dmg-settings.py.
#   out/Grub-apple-silicon.dmg   from out/Grub-darwin-arm64/Grub.app
#   out/Grub-intel.dmg           from out/Grub-darwin-x64/Grub.app
# dmgbuild writes the window layout directly (no Finder scripting); it lives in a private venv under out/.
set -e
cd "$(dirname "$0")/.."
VENV="out/.dmgbuild"
if [ ! -x "$VENV/bin/dmgbuild" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check dmgbuild
fi
for pair in arm64:apple-silicon x64:intel; do
  ARCH=${pair%%:*}; NAME=${pair##*:}
  APP="out/Grub-darwin-$ARCH/Grub.app"
  DMG="out/Grub-$NAME.dmg"
  [ -d "$APP" ] || { echo "Missing $APP. Run: npm run package:signed"; exit 1; }
  rm -f "$DMG"
  "$VENV/bin/dmgbuild" -s scripts/dmg-settings.py -D app="$APP" "Grub" "$DMG" >/dev/null
  echo "$DMG"
done
