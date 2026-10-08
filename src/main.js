const { app, BrowserWindow, ipcMain, shell, nativeImage, Tray, screen } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

// Apps launched from Finder get a bare PATH, so look for Homebrew's tools directly.
const PATH_EXTRA = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const ENV = {
  ...process.env,
  PATH: [...PATH_EXTRA, process.env.PATH || ''].join(':'),
  TERM: 'xterm-256color',
  LANG: process.env.LANG || 'en_US.UTF-8',
};
const find = (name) => ['/opt/homebrew/bin/', '/usr/local/bin/'].map((d) => d + name).find((p) => fs.existsSync(p));
// re-resolved on each use so a fresh `brew install mole` is picked up
const mo = () => find('mo') || 'mo';
const BREW = find('brew') || 'brew';
const UID = os.userInfo().uid;
const HOME = os.homedir();

// Only these mo subcommands can reach the shell.
const MO_COMMANDS = ['clean', 'optimize', 'purge', 'installer', 'uninstall', 'update'];
const SAFE_NAME = /^[\w@.+\/ -]+$/;

let win;
let tray;
let popover;
let session; // the one interactive process at a time
let watcher; // mo status --watch
let lastStatus;

function run(cmd, args, { timeout = 120000, env = ENV } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 64 * 1024 * 1024, cwd: HOME }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

async function runJson(cmd, args, opts) {
  const { err, stdout } = await run(cmd, args, opts);
  const start = stdout.search(/[[{]/);
  if (start < 0) return { ok: false, error: err?.code === 'ENOENT' ? 'missing' : err?.message || 'No output.' };
  try {
    return { ok: true, data: JSON.parse(stdout.slice(start)) };
  } catch {
    return { ok: false, error: 'Got something we could not parse.' };
  }
}

/* ---------- status stream: feeds the window and the menu bar ---------- */

function broadcast(channel, value) {
  for (const w of [win, popover]) if (w && !w.isDestroyed()) w.webContents.send(channel, value);
}

function startWatcher() {
  if (watcher) return;
  watcher = spawn(mo(), ['status', '--watch', '--interval', '2s'], { env: ENV, cwd: HOME });
  let buf = '';
  watcher.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        lastStatus = JSON.parse(line);
      } catch {
        continue;
      }
      nameProcesses(lastStatus).then((st) => {
        if (st !== lastStatus) return; // a newer snapshot arrived meanwhile
        broadcast('status', st);
        updateTrayTitle(st);
      });
    }
  });
  watcher.on('exit', () => {
    watcher = null;
    setTimeout(startWatcher, 5000);
  });
  watcher.on('error', () => {});
}

// Plain names for the system processes people actually see at the top.
const FRIENDLY = {
  kernel_task: 'macOS itself',
  WindowServer: 'Screen drawing',
  cloudd: 'iCloud sync',
  bird: 'iCloud Drive',
  cloudphotod: 'iCloud Photos',
  coreduetd: 'Siri suggestions',
  duetexpertd: 'Siri suggestions',
  cfprefsd: 'Settings storage',
  corespotlightd: 'Spotlight search',
  ANECompilerService: 'Apple Intelligence',
  photolibraryd: 'Photos library',
  mds: 'Spotlight search',
  mds_stores: 'Spotlight search',
  mdworker: 'Spotlight search',
  mdworker_shared: 'Spotlight search',
  'com.apple.WebKit.WebContent': 'Web pages',
  'com.apple.WebKit.GPU': 'Web pages',
  photoanalysisd: 'Photos scanning',
  mediaanalysisd: 'Photos scanning',
  backupd: 'Time Machine',
  softwareupdated: 'Software Update',
  coreaudiod: 'Sound',
  screencapture: 'Screenshot',
  screencaptureui: 'Screenshot',
  bluetoothd: 'Bluetooth',
  launchd: 'macOS startup',
  syspolicyd: 'App security checks',
  XprotectService: 'Malware scanning',
  trustd: 'Certificate checks',
  fileproviderd: 'Cloud files',
  nsurlsessiond: 'Background downloads',
  Python: 'Python script',
  node: 'Node script',
};

// Mole lists only 5 processes, so Grub samples them all and adds each app's helpers together.
async function nameProcesses(s) {
  const { stdout } = await run('/bin/ps', ['-axo', 'pcpu=,rss=,comm='], { timeout: 5000 });
  const apps = new Map();
  for (const line of stdout.split('\n')) {
    const m = /^\s*([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const appPath = /^(.*?\.app)\//.exec(m[3])?.[1] || null;
    const name = path.basename(m[3]);
    const label = appPath ? path.basename(appPath, '.app') : FRIENDLY[name] || name;
    const row = apps.get(label) || apps.set(label, { name, label, app: appPath, cpu: 0, memory_bytes: 0 }).get(label);
    row.cpu += +m[1];
    row.memory_bytes += +m[2] * 1024;
  }
  s.top_processes = [...apps.values()].sort((a, b) => b.cpu - a.cpu).slice(0, 6);
  return s;
}

/* ---------- quitting a hungry app ---------- */

// Asks AppKit to quit (or force quit) the app at this bundle path. No Automation prompt needed.
const QUIT_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  let n = 0;
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    const u = a.bundleURL;
    if (!u.isNil() && ObjC.unwrap(u.path) === argv[0]) {
      argv[1] === '1' ? a.forceTerminate : a.terminate;
      n++;
    }
  }
  return n;
}`;

// Every process running from inside the bundle: the app, its helpers, its background bits.
async function bundlePids(appPath) {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 5000 });
  return stdout
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m) => m && m[2].startsWith(appPath + '/') && +m[1] !== process.pid)
    .map((m) => ({ pid: +m[1], main: m[2].startsWith(appPath + '/Contents/MacOS/') }));
}

function signal(pids, sig) {
  for (const { pid } of pids)
    try {
      process.kill(pid, sig);
    } catch {}
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function quitApp(appPath, force) {
  const own = app.getAppPath().split('.app/')[0] + '.app';
  if (typeof appPath !== 'string' || !appPath.endsWith('.app') || !fs.existsSync(appPath)) return { ok: false, error: 'Grub can’t find that app.' };
  if (appPath === own) return { ok: false, error: 'Grub won’t eat itself.' };
  if (appPath.startsWith('/System/Library/')) return { ok: false, error: 'That’s part of macOS. Grub leaves it alone.' };

  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', QUIT_SCRIPT, appPath, force ? '1' : '0'], { timeout: 10000 });
  // a polite quit can stall on "save your changes?", so only the leftovers get stopped once the app itself is gone
  for (let i = 0; i < (force ? 4 : 16); i++) {
    await wait(500);
    const left = await bundlePids(appPath);
    if (!left.length) return { ok: true };
    if (force || !left.some((p) => p.main)) signal(left, 'SIGTERM');
  }
  const left = await bundlePids(appPath);
  if (!left.length) return { ok: true };
  if (!force) return { ok: false, waiting: true, error: 'It’s still open. It may be asking about unsaved work.' };
  signal(left, 'SIGKILL');
  await wait(500);
  return (await bundlePids(appPath)).length ? { ok: false, error: 'Some of it wouldn’t stop. It may belong to another user.' } : { ok: true };
}

ipcMain.handle('app:quitProcess', (_e, { app: appPath, force }) => quitApp(appPath, !!force));

/* ---------- startup items ---------- */

async function plist(file) {
  const r = await runJson('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  return r.ok ? r.data : null;
}

async function listStartup() {
  const dirs = [
    { dir: path.join(HOME, 'Library/LaunchAgents'), scope: 'user' },
    { dir: '/Library/LaunchAgents', scope: 'system' },
    { dir: '/Library/LaunchDaemons', scope: 'daemon' },
  ];
  const loaded = new Set(
    (await run('/bin/launchctl', ['list'])).stdout
      .split('\n')
      .slice(1)
      .map((l) => l.split('\t')[2])
      .filter(Boolean)
  );
  const disabledOut = (await run('/bin/launchctl', ['print-disabled', `gui/${UID}`])).stdout;
  const disabled = new Set([...disabledOut.matchAll(/"([^"]+)" => (?:disabled|true)/g)].map((m) => m[1]));

  const agents = [];
  for (const { dir, scope } of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.plist'));
    } catch {}
    for (const f of files) {
      const file = path.join(dir, f);
      const p = await plist(file);
      const label = p?.Label || f.replace(/\.plist$/, '');
      const prog = p?.Program || p?.ProgramArguments?.[0] || '';
      agents.push({
        label,
        file,
        scope,
        program: prog,
        runAtLoad: !!p?.RunAtLoad,
        loaded: loaded.has(label),
        disabled: disabled.has(label) || p?.Disabled === true,
      });
    }
  }

  const login = await run('/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to get {name, path} of every login item',
  ]);
  let loginItems = [];
  if (!login.err) {
    const parts = login.stdout.trim().split(', ');
    const half = parts.length / 2;
    loginItems = parts.slice(0, half).map((name, i) => ({ name, path: parts[half + i] }));
  }
  // -1743: the user has not allowed (or has refused) control of System Events
  const loginDenied = !!login.err && /-1743|not authori[sz]ed/i.test(login.stderr);
  const loginError = login.err ? login.stderr.trim() : null;
  return { ok: true, data: { agents, loginItems, loginError, loginDenied } };
}

async function toggleAgent({ label, file, enable }) {
  const all = (await listStartup()).data.agents;
  const agent = all.find((a) => a.label === label && a.file === file && a.scope === 'user');
  if (!agent) return { ok: false, error: 'Only your own launch agents can be switched here.' };
  const target = `gui/${UID}/${label}`;
  if (enable) {
    await run('/bin/launchctl', ['enable', target]);
    await run('/bin/launchctl', ['bootstrap', `gui/${UID}`, file]);
  } else {
    await run('/bin/launchctl', ['bootout', target]);
    await run('/bin/launchctl', ['disable', target]);
  }
  return { ok: true };
}

async function removeLoginItem(name) {
  if (!SAFE_NAME.test(name) || name.includes('"')) return { ok: false, error: 'Odd name, skipped.' };
  const r = await run('/usr/bin/osascript', ['-e', `tell application "System Events" to delete login item "${name}"`]);
  return r.err ? { ok: false, error: r.stderr.trim() } : { ok: true };
}

/* ---------- interactive sessions ---------- */

function buildSession(opts) {
  if (opts.tool === 'brew') {
    const names = (opts.names || []).filter((n) => SAFE_NAME.test(n) && !n.includes(' '));
    const action = opts.action === 'install' ? 'install' : 'upgrade';
    return { file: BREW, args: [action, ...(opts.cask ? ['--cask'] : []), ...names] };
  }
  if (opts.tool === 'tidy') {
    // one-click: clean, then optimize, each with Mole's own confirmations
    const dry = opts.dryRun ? ' --dry-run' : '';
    return { file: '/bin/zsh', args: ['-c', `"${mo()}" clean${dry} && "${mo()}" optimize${dry}`], label: `clean${dry} && mo optimize${dry}` };
  }
  if (!MO_COMMANDS.includes(opts.command)) throw new Error('Not on the menu.');
  const args = [opts.command];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.command === 'uninstall' && opts.appName) args.push(opts.appName);
  return { file: mo(), args };
}

ipcMain.handle('session:start', (_e, opts) => {
  const { file, args, label } = buildSession(opts);
  if (session) session.kill();
  session = pty.spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: HOME, env: ENV });
  const current = session;
  current.onData((d) => win?.webContents.send('session:data', d));
  current.onExit(({ exitCode }) => {
    if (session === current) session = null;
    win?.webContents.send('session:exit', exitCode);
  });
  return (file === BREW ? 'brew ' : 'mo ') + (label || args.join(' '));
});
ipcMain.on('session:input', (_e, d) => session?.write(d));
ipcMain.on('session:resize', (_e, { cols, rows }) => session?.resize(cols, rows));
ipcMain.on('session:kill', () => session?.kill());

/* ---------- settings ---------- */

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  onboarded: false,
  autoUpdateMole: true,
  lastMoleUpdate: 0,
  menuBarText: true,
  menuSections: ['cpu', 'memory', 'disk', 'network', 'battery', 'apps', 'actions'],
};

function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2));
  return next;
}

/* ---------- scan cache: slow listings survive restarts and refresh on request ---------- */

const CACHE_FILE = () => path.join(app.getPath('userData'), 'scan-cache.json');
const MAX_FOLDERS = 40; // Disk remembers this many folders
let scanCache;
const inflight = new Map(); // key -> pending scan, so a click and a background refresh share one run

function cacheStore() {
  if (!scanCache) {
    try {
      scanCache = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8'));
    } catch {
      scanCache = {};
    }
  }
  return scanCache;
}

function saveCache() {
  const store = cacheStore();
  const folders = Object.keys(store)
    .filter((k) => k.startsWith('analyze:'))
    .sort((a, b) => store[a].at - store[b].at);
  for (const k of folders.slice(0, -MAX_FOLDERS)) delete store[k];
  fs.mkdirSync(path.dirname(CACHE_FILE()), { recursive: true });
  fs.writeFileSync(CACHE_FILE(), JSON.stringify(store));
}

// Answers from the cache unless asked for a fresh scan; results carry `at` so the page can say how old they are.
function cached(key, fresh, scan) {
  const hit = cacheStore()[key];
  if (hit && !fresh) return { ok: true, ...hit };
  if (!inflight.has(key)) {
    inflight.set(
      key,
      scan()
        .then((res) => {
          if (!res.ok) return res;
          cacheStore()[key] = { at: Date.now(), data: res.data };
          saveCache();
          return { ok: true, ...cacheStore()[key] };
        })
        .finally(() => inflight.delete(key))
    );
  }
  return inflight.get(key);
}

ipcMain.handle('cache:drop', (_e, prefixes) => {
  const store = cacheStore();
  for (const k of Object.keys(store)) if (prefixes.some((p) => k.startsWith(p))) delete store[k];
  saveCache();
});

ipcMain.handle('settings:get', () => ({ ...readSettings(), openAtLogin: app.getLoginItemSettings().openAtLogin }));
ipcMain.handle('settings:set', (_e, patch) => {
  if ('openAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.openAtLogin });
  const { openAtLogin: _ignored, ...rest } = patch;
  const next = writeSettings(rest);
  broadcast('settings', next);
  if ('menuBarText' in patch && lastStatus) updateTrayTitle(lastStatus);
  return { ...next, openAtLogin: app.getLoginItemSettings().openAtLogin };
});

// The menu grows to fit the sections people pick, up to the screen height.
ipcMain.on('popover:height', (_e, h) => {
  if (!popover || !Number.isFinite(h)) return;
  const b = popover.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const height = Math.min(Math.ceil(h), area.height - 16);
  if (b.height !== height) popover.setBounds({ ...b, height });
});

/* ---------- permissions ---------- */

const PANES = {
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

// The TCC folder is only readable with Full Disk Access.
function hasFullDiskAccess() {
  try {
    fs.readdirSync('/Library/Application Support/com.apple.TCC');
    return true;
  } catch {
    return false;
  }
}

async function automationState() {
  const r = await run('/usr/bin/osascript', ['-e', 'tell application "System Events" to count login items'], { timeout: 60000 });
  if (!r.err) return 'granted';
  return /-1743|not authori[sz]ed/i.test(r.stderr) ? 'denied' : 'unknown';
}

ipcMain.handle('perm:check', async () => ({
  mole: !!find('mo'),
  brew: !!find('brew'),
  fullDisk: hasFullDiskAccess(),
}));
// Asking System Events for anything triggers the one-time macOS prompt.
ipcMain.handle('perm:automation', automationState);
ipcMain.handle('perm:open', (_e, pane) => PANES[pane] && shell.openExternal(PANES[pane]));
ipcMain.handle('link:open', (_e, url) => /^https:\/\/(github\.com|mole\.fit|brew\.sh)\//.test(url) && shell.openExternal(url));

/* ---------- keeping Mole fresh ---------- */

let moleUpdating = null;

function updateMoleQuietly() {
  if (moleUpdating || !find('mo') || !find('brew')) return moleUpdating;
  moleUpdating = run(BREW, ['upgrade', 'mole'], { timeout: 600000 }).then(async (r) => {
    moleUpdating = null;
    writeSettings({ lastMoleUpdate: Date.now() });
    const version = (await run(mo(), ['--version'])).stdout.trim();
    const result = { ok: !r.err || /already installed/i.test(r.stderr), version };
    broadcast('mole:updated', result);
    return result;
  });
  return moleUpdating;
}

ipcMain.handle('mole:update', updateMoleQuietly);

/* ---------- data ---------- */

ipcMain.handle('mole:available', () => !!find('mo'));
ipcMain.handle('mole:version', async () => (await run(mo(), ['--version'])).stdout.trim());
ipcMain.handle('mole:analyze', (_e, target, fresh) =>
  cached('analyze:' + (target || HOME), fresh, () => runJson(mo(), ['analyze', '--json', target || HOME], { timeout: 300000 }))
);
ipcMain.handle('mole:history', () => runJson(mo(), ['history', '--json']));
ipcMain.handle('mole:apps', (_e, fresh) => cached('apps', fresh, () => runJson(mo(), ['uninstall', '--list'])));
ipcMain.handle('mole:home', () => HOME);
ipcMain.handle('mole:reveal', (_e, p) => shell.showItemInFolder(p));

// Real app icons for lists; cached because the same apps show up on several screens.
const iconCache = new Map();
ipcMain.handle('app:icon', async (_e, p) => {
  if (typeof p !== 'string' || !p.endsWith('.app')) return null;
  if (!iconCache.has(p)) {
    iconCache.set(
      p,
      // Quick Look renders the real icon; getFileIcon often returns the generic one on new macOS
      nativeImage
        .createThumbnailFromPath(p, { width: 64, height: 64 })
        .catch(() => app.getFileIcon(p, { size: 'normal' }))
        .then((img) => (img.isEmpty() ? null : img.toDataURL()))
        .catch(() => null)
    );
  }
  return iconCache.get(p);
});
ipcMain.handle('startup:list', listStartup);
ipcMain.handle('startup:toggle', (_e, a) => toggleAgent(a));
ipcMain.handle('startup:removeLogin', (_e, name) => removeLoginItem(name));
ipcMain.handle('updates:list', (_e, fresh) =>
  cached('updates', fresh, () =>
    runJson(BREW, ['outdated', '--json=v2'], { timeout: 180000, env: { ...ENV, HOMEBREW_NO_AUTO_UPDATE: '1' } })
  )
);
ipcMain.handle('status:last', () => lastStatus);
ipcMain.on('status:start', startWatcher);

// menu bar popover actions
ipcMain.on('app:open', (_e, view) => {
  popover?.hide();
  showWindow();
  if (view) win.webContents.send('navigate', view);
});
ipcMain.on('app:run', (_e, opts) => {
  popover?.hide();
  showWindow();
  win.webContents.send('run', opts);
});
ipcMain.on('app:quit', () => app.quit());

/* ---------- windows ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    title: 'Grub',
    backgroundColor: '#14110F',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // keep driving the engine at full speed while the window is in the background
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // closing the window keeps Grub in the menu bar
  win.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Grub');
  tray.on('click', togglePopover);
  tray.on('right-click', togglePopover);

  popover = new BrowserWindow({
    width: 340,
    height: 452,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  popover.loadFile(path.join(__dirname, 'renderer', 'tray.html'));
  popover.on('blur', () => popover.hide());
}

function togglePopover() {
  if (popover.isVisible()) return popover.hide();
  const b = tray.getBounds();
  const { width } = popover.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const x = Math.min(Math.max(Math.round(b.x + b.width / 2 - width / 2), area.x + 8), area.x + area.width - width - 8);
  popover.setPosition(x, Math.round(b.y + b.height + 4));
  popover.show();
  popover.focus();
}

function updateTrayTitle(s) {
  if (!readSettings().menuBarText) return tray?.setTitle('');
  const disk = (s.disks || []).find((d) => d.mount === '/');
  const free = disk ? (disk.total - disk.used) / 1e9 : null;
  const cpu = Math.round(s.cpu?.usage ?? 0);
  tray?.setTitle(` ${cpu}%${free != null ? ` · ${free < 10 ? free.toFixed(1) : Math.round(free)}G` : ''}`, {
    fontType: 'monospacedDigit',
  });
}

app.setName('Grub');
app.whenReady().then(() => {
  const icon = path.join(__dirname, '..', 'build', 'icon.png');
  if (process.platform === 'darwin' && fs.existsSync(icon)) app.dock.setIcon(nativeImage.createFromPath(icon));
  createWindow();
  createTray();
  if (find('mo')) startWatcher();
  const { autoUpdateMole, lastMoleUpdate } = readSettings();
  if (autoUpdateMole && Date.now() - lastMoleUpdate > 24 * 3600 * 1000) setTimeout(updateMoleQuietly, 15000);
});
app.on('activate', showWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  app.isQuitting = true;
  session?.kill();
  watcher?.removeAllListeners('exit');
  watcher?.kill();
});
