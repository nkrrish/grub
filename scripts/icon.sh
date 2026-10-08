#!/bin/sh
# Builds build/icon.icns and build/icon.png from brand/Icon.icon (Icon Composer).
# The glass render sits on the standard 824-in-1024 macOS grid, so older macOS shows it at the right size.
set -e
cd "$(dirname "$0")/.."
TOOL="/Applications/Icon Composer.app/Contents/Executables/icontool"
TMP="$(mktemp -d /tmp/grub-icon.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
# icontool needs a path without spaces
cp -R brand/Icon.icon "$TMP/Icon.icon"
"$TOOL" "$TMP/Icon.icon" --export-preview macOS Light 1024 1024 1 "$TMP/full.png" >/dev/null 2>&1
sips -z 824 824 "$TMP/full.png" --out "$TMP/824.png" >/dev/null
sips -p 1024 1024 "$TMP/824.png" --out build/icon.png >/dev/null
mkdir "$TMP/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o build/icon.icns
echo "build/icon.icns updated from brand/Icon.icon"
