#!/bin/sh
# Wraps the universal Grub.app in a compressed DMG with an Applications shortcut.
set -e
cd "$(dirname "$0")/.."
APP="out/Grub-darwin-universal/Grub.app"
STAGE="out/dmg-stage"
DMG="out/Grub.dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Grub" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "$DMG"
