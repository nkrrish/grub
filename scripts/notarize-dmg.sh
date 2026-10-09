#!/bin/sh
# Signs, notarizes and staples both DMGs made by make-dmg.sh, then staples each app too and zips it for
# in-app updates (update.electronjs.org needs a signed Grub-darwin-<arch>-<version>.zip on each release).
# Notarizing a DMG also notarizes the Grub.app inside it, so the same app in out/ can be stapled directly.
# Both DMGs go to Apple at once, so the wait is about the same as for one.
# Credentials: a notarytool keychain profile in GRUB_NOTARY_PROFILE (default "grub"), made once with
#   xcrun notarytool store-credentials grub --apple-id <id> --team-id NY6MJC8WU5
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
IDENTITY="${GRUB_SIGN_IDENTITY:-Developer ID Application: Attechy Ltd (NY6MJC8WU5)}"
PROFILE="${GRUB_NOTARY_PROFILE:-grub}"

for NAME in apple-silicon intel; do
  codesign --force --timestamp --sign "$IDENTITY" "out/Grub-$NAME.dmg"
done
xcrun notarytool submit "out/Grub-apple-silicon.dmg" --keychain-profile "$PROFILE" --wait &
ARM=$!
xcrun notarytool submit "out/Grub-intel.dmg" --keychain-profile "$PROFILE" --wait &
INTEL=$!
wait $ARM
wait $INTEL

rm -f out/Grub-darwin-*.zip
for pair in arm64:apple-silicon x64:intel; do
  ARCH=${pair%%:*}; NAME=${pair##*:}
  DMG="out/Grub-$NAME.dmg"
  APP="out/Grub-darwin-$ARCH/Grub.app"
  ZIP="out/Grub-darwin-$ARCH-$VERSION.zip"
  xcrun stapler staple "$DMG"
  spctl --assess --type open --context context:primary-signature -v "$DMG"
  xcrun stapler staple "$APP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  echo "$DMG"
  echo "$ZIP"
done
