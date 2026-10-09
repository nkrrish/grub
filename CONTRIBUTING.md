# Contributing to Grub

Thanks for helping. Grub is small, so the process is light.

## Run it locally

You need macOS 12 or later, Node.js 20+ and [Homebrew](https://brew.sh).

```bash
brew install mole
npm install
npm start
```

The app is plain Electron: `src/main.js` is the main process and `src/` holds the UI. There's no bundler or build step for development.

## Reporting bugs

Open a [bug report](https://github.com/nkrrish/grub/issues/new?template=bug.yml) with your macOS version, your chip (Apple Silicon or Intel), the Grub version (click the version number in the sidebar) and what you expected to happen. Questions and ideas go in [Discussions](https://github.com/nkrrish/grub/discussions).

Security problems go through [private reporting](https://github.com/nkrrish/grub/security/advisories/new), not public issues. See `SECURITY.md`.

## Pull requests

- Open an issue or discussion first for anything bigger than a small fix, so we can agree on the approach.
- Keep each PR to one change, and match the style of the surrounding code.
- Anything that deletes files must stay safe: keep the dry run ("Sniff first") working, send files to the Trash where possible, and never touch data the user hasn't been shown.
- Test on a real Mac before opening the PR and say what you tried.

Cleaning itself is done by [Mole](https://github.com/tw93/Mole). Bugs in what Mole cleans belong in Mole's repo.

## License

By contributing you agree that your work is released under the GPL-3.0-or-later, like the rest of Grub. The Grub name and artwork are not part of that license (see `NOTICE`).
