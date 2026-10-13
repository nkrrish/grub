#!/bin/sh
# Publishes the notarized builds from `npm run dist:notarized` as GitHub release v<version>:
#   Grub-apple-silicon.dmg, Grub-intel.dmg         for downloads (grub.attechy.com/download, /download/intel)
#   Grub-darwin-arm64-<v>.zip, Grub-darwin-x64-<v>.zip   for Grub's in-app updater
#   Mole-<mole version>-source.tar.gz              the source of the Mole inside, as GPL-3.0 asks of anyone shipping it
# Refuses to run unless every file exists, is stapled, and matches package.json's version (and mole.lock.json for Mole).
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
MOLE_VERSION=$(node -p "require('./mole.lock.json').version")
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
  MOLE_BUILT=$("$APP/Contents/Resources/mole/mole" --version | sed -n 's/^Mole version //p')
  [ "$MOLE_BUILT" = "$MOLE_VERSION" ] || { echo "$APP has Mole $MOLE_BUILT but mole.lock.json says $MOLE_VERSION. Rebuild."; exit 1; }
done
MOLE_SRC="out/Mole-$MOLE_VERSION-source.tar.gz"
cp "vendor/cache/$(node -p "require('./mole.lock.json').source.file")" "$MOLE_SRC"
[ "$(shasum -a 256 "$MOLE_SRC" | cut -d' ' -f1)" = "$(node -p "require('./mole.lock.json').source.sha256")" ] || { echo "$MOLE_SRC doesn't match mole.lock.json."; exit 1; }
FILES="$FILES $MOLE_SRC"
# shellcheck disable=SC2086
# GitHub's generated notes only when none are given; with --notes it adds its changelog line a second time
if [ $# -eq 0 ]; then set -- --generate-notes; fi
gh release create "v$VERSION" $FILES --title "Grub $VERSION" "$@"
