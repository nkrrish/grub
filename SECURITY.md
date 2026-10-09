# Security

Grub deletes files, asks for Full Disk Access and runs admin steps through `sudo`, so security reports matter a lot.

## Reporting a vulnerability

Please **don't open a public issue.** Report it privately through GitHub: [Report a vulnerability](https://github.com/nkrrish/grub/security/advisories/new).

Include what you found, how to reproduce it and the Grub version. You should hear back within a few days. Once it's fixed, the advisory is published and you're credited unless you'd rather not be.

## Supported versions

Only the latest release gets fixes. Grub updates itself, so most people are on it already.

## What Grub does with sensitive data

- Your admin password is passed straight to `sudo` and is never stored or logged.
- Grub has no account, no analytics and no tracking. Its only network calls are update checks (GitHub Releases through update.electronjs.org) and Homebrew.
- Releases are signed with a Developer ID and notarized by Apple.
