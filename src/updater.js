// Keeps Grub itself up to date from its GitHub releases, through Electron's free update service
// (update.electronjs.org). Each release carries a signed, notarized Grub-darwin-arm64-<version>.zip and
// Grub-darwin-x64-<version>.zip; Squirrel downloads the one for this Mac's chip in the background and swaps
// the app in when Grub quits.
const { app, autoUpdater, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'nkrrish/grub';
const FIRST_CHECK = 30 * 1000;
const EVERY = 6 * 3600 * 1000;

// ShipIt, Squirrel's installer, swaps the app in after Grub quits and logs here. Squirrel empties the folder on
// the next check, so Grub copies the log to its own folder when it starts, while the last attempt is still there.
const SHIPIT_DIR = () => path.join(os.homedir(), 'Library/Caches/com.attechy.grub.ShipIt');
const UPDATE_LOG = () => path.join(app.getPath('userData'), 'update.log');
const PENDING = () => path.join(app.getPath('userData'), 'update-pending.json');
const LOG_LIMIT = 256 * 1024;

const feedURL = () => `https://update.electronjs.org/${REPO}/darwin-${process.arch}/${app.getVersion()}`;

// What About shows: status is dev, idle, checking, downloading, latest, ready or error.
// failedTo: an update that was installing when Grub last quit but didn't land, so About can say so.
let state = { version: app.getVersion(), status: 'idle', next: null, checkedAt: null, failedTo: null };
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
  // the next launch checks this: still the old version means the install didn't land
  try {
    fs.writeFileSync(PENDING(), JSON.stringify({ from: app.getVersion(), to: state.next, at: Date.now() }));
  } catch {}
  // the window vanishes and nothing seems to happen for a few seconds; say so, or people reopen Grub mid-install
  if (Notification.isSupported())
    new Notification({ title: `Updating Grub to ${state.next || 'the new version'}`, body: 'Grub reopens by itself in a few seconds.', silent: true }).show();
  app.isQuitting = true;
  autoUpdater.quitAndInstall();
  return true;
}

// Keeps ShipIt's log from the last install attempt, with what Grub expected, newest last and trimmed to LOG_LIMIT.
function keepShipItLog(note) {
  let shipit = '';
  for (const f of ['ShipIt_stderr.log', 'ShipIt_stdout.log', 'ShipItState.plist']) {
    try {
      const text = fs.readFileSync(path.join(SHIPIT_DIR(), f), 'utf8').trim();
      if (text) shipit += `--- ${f}\n${text}\n`;
    } catch {}
  }
  if (!shipit && !note) return;
  try {
    let log = '';
    try {
      log = fs.readFileSync(UPDATE_LOG(), 'utf8');
    } catch {}
    log += `\n=== ${new Date().toISOString()} Grub ${app.getVersion()} started${note ? `: ${note}` : ''}\n${shipit}`;
    fs.writeFileSync(UPDATE_LOG(), log.length > LOG_LIMIT ? log.slice(-LOG_LIMIT) : log);
  } catch {}
}

// Did the update Restart to update started actually land?
function checkLastInstall() {
  let pending = null;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING(), 'utf8'));
    fs.rmSync(PENDING());
  } catch {}
  if (!pending) return keepShipItLog();
  const landed = app.getVersion() !== pending.from;
  keepShipItLog(landed ? `updated from ${pending.from}` : `the update to ${pending.to} didn't install`);
  if (!landed) set({ failedTo: pending.to || 'the new version' });
}

function start(opts) {
  isBusy = opts.isBusy;
  notify = opts.onChange || notify;
  if (!app.isPackaged || process.platform !== 'darwin') return set({ status: 'dev' });
  checkLastInstall();
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
    set({ status: 'ready', next: version, checkedAt: Date.now(), failedTo: null });
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

module.exports = { start, check, install, state: () => state, logFile: UPDATE_LOG };
