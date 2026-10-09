#!/bin/sh
# Signs, notarizes and staples the DMG made by make-dmg.sh.
# Credentials: a notarytool keychain profile in GRUB_NOTARY_PROFILE (default "grub"), made once with
#   xcrun notarytool store-credentials grub --apple-id <id> --team-id NY6MJC8WU5
set -e
cd "$(dirname "$0")/.."
DMG="out/Grub.dmg"
IDENTITY="${GRUB_SIGN_IDENTITY:-Developer ID Application: Attechy Ltd (NY6MJC8WU5)}"
PROFILE="${GRUB_NOTARY_PROFILE:-grub}"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature -v "$DMG"
echo "$DMG"
