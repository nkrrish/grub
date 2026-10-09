#!/bin/sh
# Publishes the notarized builds from `npm run dist:notarized` as GitHub release v<version>:
#   Grub-apple-silicon.dmg, Grub-intel.dmg         for downloads (grub.attechy.com/download, /download/intel)
#   Grub-darwin-arm64-<v>.zip, Grub-darwin-x64-<v>.zip   for Grub's in-app updater
# Refuses to run unless every file exists, is stapled, and matches package.json's version.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
FILES=""
for pair in arm64:apple-silicon x64:intel; do
  ARCH=${pair%%:*}; NAME=${pair##*:}
  DMG="out/Grub-$NAME.dmg"
  ZIP="out/Grub-darwin-$ARCH-$VERSION.zip"
  APP="out/Grub-darwin-$ARCH/Grub.app"
  [ -f "$DMG" ] && [ -f "$ZIP" ] || { echo "Missing $DMG or $ZIP. Run: npm run dist:notarized"; exit 1; }
  xcrun stapler validate "$DMG" >/dev/null || { echo "$DMG isn't notarized."; exit 1; }
  xcrun stapler validate "$APP" >/dev/null || { echo "$APP isn't stapled."; exit 1; }
  BUILT=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist")
  [ "$BUILT" = "$VERSION" ] || { echo "$APP is $BUILT but package.json says $VERSION. Rebuild."; exit 1; }
  FILES="$FILES $DMG $ZIP"
done
# shellcheck disable=SC2086
gh release create "v$VERSION" $FILES --title "Grub $VERSION" --generate-notes "$@"
