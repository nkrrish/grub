// Keeps Grub itself up to date from its GitHub releases, through Electron's free update service
// (update.electronjs.org). Each release carries a signed, notarized Grub-darwin-arm64-<version>.zip and
// Grub-darwin-x64-<version>.zip; Squirrel downloads the one for this Mac's chip in the background and swaps
// the app in when Grub quits.
const { app, autoUpdater, Notification } = require('electron');

const REPO = 'nkrrish/grub';
const FIRST_CHECK = 30 * 1000;
const EVERY = 6 * 3600 * 1000;

const feedURL = () => `https://update.electronjs.org/${REPO}/darwin-${process.arch}/${app.getVersion()}`;

// What About shows: status is dev, idle, checking, downloading, latest, ready or error.
let state = { version: app.getVersion(), status: 'idle', next: null, checkedAt: null };
let isBusy = () => false;
let notify = () => {};

function set(patch) {
  state = { ...state, ...patch };
  notify(state);
}

function check() {
  if (!['idle', 'latest', 'error'].includes(state.status)) return state;
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('updater:', err.message);
    set({ status: 'error' });
  }
  return state;
}

// never restart in the middle of a chore; it'll install on the next quit instead
function install() {
  if (state.status !== 'ready' || isBusy()) return false;
  app.isQuitting = true;
  autoUpdater.quitAndInstall();
  return true;
}

function start(opts) {
  isBusy = opts.isBusy;
  notify = opts.onChange || notify;
  if (!app.isPackaged || process.platform !== 'darwin') return set({ status: 'dev' });
  try {
    autoUpdater.setFeedURL({ url: feedURL() });
  } catch (err) {
    console.warn('updater: no feed', err.message);
    return set({ status: 'dev' });
  }

  // quitAndInstall closes the windows before before-quit fires, and the main window only really closes
  // when Grub is quitting (otherwise it hides to the menu bar), so mark it here or nothing quits
  autoUpdater.on('before-quit-for-update', () => {
    app.isQuitting = true;
  });
  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', () => set({ status: 'downloading' }));
  autoUpdater.on('update-not-available', () => set({ status: 'latest', checkedAt: Date.now() }));
  autoUpdater.on('error', (err) => {
    console.warn('updater:', err.message);
    // a failed background check shouldn't hide an update that's already downloaded
    if (state.status !== 'ready') set({ status: 'error', checkedAt: Date.now() });
  });
  autoUpdater.on('update-downloaded', (_e, _notes, name) => {
    const version = String(name || '').replace(/^grub\s*/i, '').replace(/^v/i, '') || null;
    if (state.status === 'ready' && state.next === version) return;
    set({ status: 'ready', next: version, checkedAt: Date.now() });
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: `Grub ${version || 'update'} is ready to install`,
      body: 'Click to restart Grub now, or it updates the next time you quit.',
      silent: true,
    });
    n.on('click', install);
    n.show();
  });

  setTimeout(check, FIRST_CHECK);
  setInterval(check, EVERY);
}

module.exports = { start, check, install, state: () => state };
