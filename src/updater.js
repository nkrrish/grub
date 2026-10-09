// Keeps Grub itself up to date from its GitHub releases, through Electron's free update service
// (update.electronjs.org). Each release carries a signed, notarized Grub-darwin-arm64-<version>.zip and
// Grub-darwin-x64-<version>.zip; Squirrel downloads the one for this Mac's chip in the background and swaps
// the app in when Grub quits.
const { app, autoUpdater, Notification } = require('electron');

const REPO = 'nkrrish/grub';
const FIRST_CHECK = 30 * 1000;
const EVERY = 6 * 3600 * 1000;

const feedURL = () => `https://update.electronjs.org/${REPO}/darwin-${process.arch}/${app.getVersion()}`;

function start({ isBusy, onReady }) {
  if (!app.isPackaged || process.platform !== 'darwin') return;
  try {
    autoUpdater.setFeedURL({ url: feedURL() });
  } catch (err) {
    console.warn('updater: no feed', err.message);
    return;
  }

  let announced = null;
  autoUpdater.on('error', (err) => console.warn('updater:', err.message));
  autoUpdater.on('update-downloaded', (_e, _notes, name) => {
    const version = String(name || '').replace(/^v/i, '') || 'A new version';
    if (announced === version) return;
    announced = version;
    onReady?.(version);
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: `Grub ${version} is ready to install`,
      body: 'Click to restart Grub now, or it updates the next time you quit.',
      silent: true,
    });
    // never restart in the middle of a chore; it'll install on the next quit instead
    n.on('click', () => !isBusy() && autoUpdater.quitAndInstall());
    n.show();
  });

  const check = () => {
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      console.warn('updater:', err.message);
    }
  };
  setTimeout(check, FIRST_CHECK);
  setInterval(check, EVERY);
}

module.exports = { start };
