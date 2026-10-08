# Decisions

- **No App Store version.** Grub ships outside the Mac App Store: Developer ID signed, notarized, as a DMG.
  It runs the Mole CLI, needs Full Disk Access and admin prompts, and quits other apps, none of which the
  App Store sandbox allows. Don't re-check App Store eligibility or suggest a sandboxed build.
