const { app, BrowserWindow, ipcMain, shell, nativeImage, Tray, screen, Notification, powerMonitor } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { createScheduler } = require('./schedule');
const aiTools = require('./aitools');
const updater = require('./updater');

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

// Someone is looking: the window or the popover is on screen.
const watched = () => [win, popover].some((w) => w && !w.isDestroyed() && w.isVisible());

// Full speed while someone is looking. Otherwise only the menu bar needs readings: a few seconds apart
// for CPU or memory, and rarely for free disk (or nothing at all, but checkups still read the latest one).
function sampleEvery() {
  if (watched()) return 2;
  const items = readSettings().menuBarItems || [];
  return items.includes('cpu') || items.includes('memory') ? 5 : 30;
}

let watcherEvery = 0;

function startWatcher() {
  if (watcher) return;
  watcherEvery = sampleEvery();
  const current = (watcher = spawn(mo(), ['status', '--watch', '--interval', `${watcherEvery}s`], { env: ENV, cwd: HOME }));
  let buf = '';
  current.stdout.on('data', (chunk) => {
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
      updateTrayTitle(lastStatus);
      // naming the hungriest apps means a full process list, so it's only done for someone looking
      if (watched()) sendStatus(lastStatus);
      // window events can be missed when they come close together; each reading checks the pace too
      if (sampleEvery() !== watcherEvery) retuneWatcher();
    }
  });
  current.on('exit', () => {
    if (watcher !== current) return; // replaced on purpose
    watcher = null;
    setTimeout(startWatcher, 5000);
  });
  current.on('error', () => {});
}

// Called when a window opens or closes, or the menu bar picks change. Waits a beat, since clicking
// "Open Grub" hides the popover and shows the window in one go.
let retuneTimer;
function retuneWatcher() {
  clearTimeout(retuneTimer);
  retuneTimer = setTimeout(() => {
    if (!watcher || sampleEvery() === watcherEvery) return;
    const old = watcher;
    watcher = null;
    old.kill();
    startWatcher();
  }, 300);
}

function sendStatus(raw) {
  nameProcesses(raw).then((st) => {
    if (st !== lastStatus) return; // a newer snapshot arrived meanwhile
    for (const w of [win, popover]) if (w && !w.isDestroyed() && w.isVisible()) w.webContents.send('status', st);
  });
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

// Every process with its parent. Each one belongs to the .app it runs from or, failing that,
// to the nearest ancestor that runs from one (so an editor's language servers count as the editor).
async function processTable() {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,uid=,pcpu=,rss=,comm='], { timeout: 5000 });
  const procs = new Map();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.set(+m[1], { pid: +m[1], ppid: +m[2], uid: +m[3], cpu: +m[4], mem: +m[5] * 1024, comm: m[6] });
  }
  const own = /^(.*?\.app)\//;
  const owner = (p, seen = 0) => {
    if (p.app !== undefined) return p.app;
    const direct = own.exec(p.comm)?.[1];
    const parent = procs.get(p.ppid);
    p.app = direct || (p.ppid > 1 && parent && seen < 64 ? owner(parent, seen + 1) : null);
    return p.app;
  };
  for (const p of procs.values()) owner(p);
  return procs;
}

async function nameProcesses(s) {
  const apps = new Map();
  for (const p of (await processTable()).values()) {
    const name = path.basename(p.comm);
    const label = p.app ? path.basename(p.app, '.app') : FRIENDLY[name] || name;
    const row = apps.get(label) || apps.set(label, { name, label, app: p.app, cpu: 0, memory_bytes: 0, count: 0 }).get(label);
    row.cpu += p.cpu;
    row.memory_bytes += p.mem;
    row.count++;
  }
  s.top_processes = [...apps.values()].sort((a, b) => b.cpu - a.cpu).slice(0, 6);
  return s;
}

/* ---------- quitting a hungry app ---------- */

// Asks AppKit to quit (or force quit) the app at this bundle path. No Automation prompt needed.
const QUIT_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const out = [];
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    const u = a.bundleURL;
    const p = u.isNil() ? '' : ObjC.unwrap(u.path);
    // nested apps count too: Docker's window is Docker.app/Contents/MacOS/Docker Desktop.app
    if (p === argv[0] || p.startsWith(argv[0] + '/')) {
      argv[1] === '1' ? a.forceTerminate : a.terminate;
      out.push(a.processIdentifier);
    }
  }
  return JSON.stringify(out);
}`;

// The app, its helpers, and anything they started. Only this user's processes,
// and never Grub or anything Grub started.
async function family(appPath, also = []) {
  const procs = await processTable();
  const grub = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs.values()) if (!grub.has(p.pid) && grub.has(p.ppid)) (grub.add(p.pid), (grew = true));
  }
  // a child whose parent already quit is re-parented to launchd, so earlier members are matched by pid + path
  const earlier = new Map(also.map((p) => [p.pid, p.comm]));
  const uid = process.getuid();
  return [...procs.values()].filter(
    (p) => p.uid === uid && !grub.has(p.pid) && (p.app === appPath || earlier.get(p.pid) === p.comm)
  );
}

function signal(procs, sig) {
  for (const { pid } of procs)
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

  const before = await family(appPath);
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', QUIT_SCRIPT, appPath, force ? '1' : '0'], { timeout: 10000 });
  let windows = [];
  try {
    windows = JSON.parse(stdout.trim() || '[]');
  } catch {}
  // a polite quit can stall on "save your changes?", so the rest is only stopped once the app's windows are gone
  for (let i = 0; i < (force ? 4 : 16); i++) {
    await wait(500);
    const left = await family(appPath, before);
    if (!left.length) return { ok: true, stopped: before.length };
    if (force || !left.some((p) => windows.includes(p.pid))) signal(left, 'SIGTERM');
  }
  const left = await family(appPath, before);
  if (!left.length) return { ok: true, stopped: before.length };
  if (!force) return { ok: false, waiting: true, error: 'It’s still open. It may be asking about unsaved work.' };
  signal(left, 'SIGKILL');
  await wait(500);
  return (await family(appPath, before)).length
    ? { ok: false, error: 'Some of it wouldn’t stop. It may belong to another user.' }
    : { ok: true, stopped: before.length };
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
  // a person asking for something beats a scheduled checkup
  scheduler.cancel();
  if (session) session.kill();
  session = pty.spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: HOME, env: ENV });
  const current = session;
  // the window reads the engine's screens and answers its prompts, so it runs at full speed in the background
  win?.webContents.setBackgroundThrottling(false);
  current.onData((d) => win?.webContents.send('session:data', d));
  current.onExit(({ exitCode }) => {
    if (session === current) {
      session = null;
      win?.webContents.setBackgroundThrottling(true);
    }
    win?.webContents.send('session:exit', exitCode);
  });
  return (file === BREW ? 'brew ' : 'mo ') + (label || args.join(' '));
});
ipcMain.on('session:input', (_e, d) => session?.write(d));
ipcMain.on('session:resize', (_e, { cols, rows }) => session?.resize(cols, rows));
ipcMain.on('session:kill', () => session?.kill());

/* ---------- schedule ---------- */

const TASK_NAMES = { clean: 'Clean', optimize: 'Optimize', purge: 'Purge projects', installer: 'Installers', updates: 'Updates' };

function reportHeadline(r) {
  const ate = r.tasks.filter((t) => t.mode === 'auto' && t.bytes).reduce((n, t) => n + t.bytes, 0);
  const found = r.tasks.filter((t) => t.mode === 'report' && t.bytes).reduce((n, t) => n + t.bytes, 0);
  const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
  const updates = r.tasks.find((t) => t.key === 'updates' && t.mode === 'report')?.count || 0;
  const parts = [];
  if (ate) parts.push(`Grub ate ${fmt(ate)}`);
  if (found) parts.push(`${ate ? 'found' : 'Found'} ${fmt(found)} more to eat`);
  if (updates) parts.push(`${updates} update${updates === 1 ? '' : 's'} waiting`);
  return parts.length ? parts.join(', ') + '.' : 'Nothing to eat. Your Mac is spotless.';
}

const scheduler = createScheduler({
  app,
  env: ENV,
  mo,
  brew: () => find('brew') || 'brew',
  home: HOME,
  readStatus: () => lastStatus,
  isBusy: () => !!session,
  onChange: (snap) => {
    broadcast('schedule', snap);
    updateDockBadge(snap);
  },
  notify: (report) => {
    if (report.trigger !== 'schedule' || !Notification.isSupported()) return;
    const n = new Notification({ title: "Grub's checkup is in", body: reportHeadline(report), silent: true });
    n.on('click', () => sendToWindow('navigate', 'schedule'));
    n.show();
  },
});

function updateDockBadge(snap) {
  const unread = snap.reports.filter((r) => !r.read).length;
  if (process.platform === 'darwin') app.dock?.setBadge(unread ? String(unread) : '');
}

ipcMain.handle('schedule:get', () => scheduler.get());
ipcMain.handle('schedule:set', (_e, { key, patch }) => scheduler.set(key, patch || {}));
ipcMain.handle('schedule:setAll', (_e, patch) => scheduler.setAll(patch || {}));
ipcMain.handle('schedule:runNow', (_e, keys) => (session ? scheduler.get() : scheduler.runNow(keys)));
ipcMain.handle('schedule:cancel', () => scheduler.cancel());
ipcMain.handle('schedule:read', (_e, ids) => scheduler.markRead(ids));
ipcMain.handle('schedule:remove', (_e, id) => scheduler.removeReport(id));

/* ---------- settings ---------- */

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  onboarded: false,
  autoUpdateMole: true,
  lastMoleUpdate: 0,
  menuBarItems: ['disk'], // what sits next to the icon; free disk is what a cleaner is for
  menuSections: ['cpu', 'memory', 'disk', 'network', 'battery', 'apps', 'actions'],
  aiCare: true, // show AI tools cleanup when there's something to clean
  aiRetention: aiTools.DEFAULT_RETENTION,
};

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    // 0.1.x had one on/off switch for the numbers; off still means icon only
    if (!saved.menuBarItems && saved.menuBarText === false) saved.menuBarItems = [];
    return { ...DEFAULTS, ...saved };
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
// keep(res) false hands the answer back without remembering it (say, one that is only a permission prompt).
function cached(key, fresh, scan, keep = () => true) {
  const hit = cacheStore()[key];
  if (hit && !fresh) return { ok: true, ...hit };
  if (!inflight.has(key)) {
    inflight.set(
      key,
      scan()
        .then((res) => {
          if (!res.ok) return res;
          if (!keep(res)) {
            delete cacheStore()[key];
            saveCache();
            return { ...res, at: Date.now() };
          }
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
  if ('menuBarItems' in patch) {
    if (lastStatus) updateTrayTitle(lastStatus);
    retuneWatcher();
  }
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
ipcMain.handle('link:open', (_e, url) => /^https:\/\/((grub\.)?attechy\.com|naguleskrrish\.com|github\.com|brew\.sh)\//.test(url) && shell.openExternal(url));

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

/* ---------- keeping Grub fresh ---------- */

ipcMain.handle('grub:update:state', () => updater.state());
ipcMain.handle('grub:update:check', () => updater.check());
ipcMain.handle('grub:update:install', () => updater.install());

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
ipcMain.handle('ai:scan', () => aiTools.scan(readSettings()));
ipcMain.handle('ai:clean', (_e, ids) => (Array.isArray(ids) ? aiTools.clean(ids.filter((i) => typeof i === 'string')) : { ok: false }));
ipcMain.handle('startup:list', (_e, fresh) =>
  cached('startup', fresh, listStartup, (res) => !res.data.loginDenied && !res.data.loginError)
);
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
  if (view) sendToWindow('navigate', view);
  else showWindow();
});
ipcMain.on('app:run', (_e, opts) => {
  popover?.hide();
  sendToWindow('run', opts);
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
    // throttled when hidden, so a closed window costs next to nothing; a running chore switches it off
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // the newest reading straight away, then full-speed readings while it's open
  win.on('show', () => {
    clearTimeout(freeWindowTimer);
    if (lastStatus) sendStatus(lastStatus);
    retuneWatcher();
  });
  win.on('hide', () => {
    retuneWatcher();
    scheduleFreeWindow();
  });
  win.on('closed', () => (win = null));
  // closing the window keeps Grub in the menu bar
  win.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    win.hide();
  });
}

// A window closed for a while is let go, which frees its page (tens of MB); opening Grub builds it again.
// Never while a chore runs, since the window is the one driving it.
const FREE_AFTER = 10 * 60 * 1000;
let freeWindowTimer;

function scheduleFreeWindow() {
  clearTimeout(freeWindowTimer);
  freeWindowTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isVisible()) return;
    if (session) return scheduleFreeWindow();
    win.destroy();
  }, FREE_AFTER);
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

// Sends to the window once its page is ready, which takes a moment when it's just been rebuilt.
function sendToWindow(channel, value) {
  showWindow();
  const wc = win.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(channel, value));
  else wc.send(channel, value);
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
  popover.on('show', () => {
    if (lastStatus) sendStatus(lastStatus);
    retuneWatcher();
  });
  popover.on('hide', retuneWatcher);
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
  const items = readSettings().menuBarItems || [];
  // two bare percentages would be ambiguous, so they get labels only when both show
  const label = items.includes('cpu') && items.includes('memory');
  const parts = items
    .map((item) => {
      if (item === 'cpu') return `${label ? 'CPU ' : ''}${Math.round(s.cpu?.usage ?? 0)}%`;
      if (item === 'memory') return `${label ? 'MEM ' : ''}${Math.round(s.memory?.used_percent ?? 0)}%`;
      if (item === 'disk') {
        const disk = (s.disks || []).find((d) => d.mount === '/');
        if (!disk) return null;
        const free = (disk.total - disk.used) / 1e9;
        return `${free < 10 ? free.toFixed(1) : Math.round(free)}G`;
      }
      return null;
    })
    .filter(Boolean);
  tray?.setTitle(parts.length ? ` ${parts.join(' · ')}` : '', { fontType: 'monospacedDigit' });
}

app.setName('Grub');
app.whenReady().then(() => {
  const icon = path.join(__dirname, '..', 'build', 'icon.png');
  if (process.platform === 'darwin' && fs.existsSync(icon)) app.dock.setIcon(nativeImage.createFromPath(icon));
  createWindow();
  createTray();
  if (find('mo')) startWatcher();
  scheduler.start();
  updateDockBadge(scheduler.get());
  // a run missed while the lid was shut catches up shortly after waking
  powerMonitor.on('resume', () => scheduler.wake());
  const { autoUpdateMole, lastMoleUpdate } = readSettings();
  if (autoUpdateMole && Date.now() - lastMoleUpdate > 24 * 3600 * 1000) setTimeout(updateMoleQuietly, 15000);
  updater.start({ isBusy: () => !!session, onChange: (state) => broadcast('grub:update', state) });
});
app.on('activate', showWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  app.isQuitting = true;
  session?.kill();
  scheduler.cancel();
  watcher?.removeAllListeners('exit');
  watcher?.kill();
});
