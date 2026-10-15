// AI tool cleanup and care: finds what Claude Code, Codex, Cursor and OpenCode leave behind.
// Mole's CLI has no command for this, so Grub does it itself. Everything removed goes to the Trash,
// except finished worktrees (removed with git, their branch stays) and the OpenCode compaction.
const { shell } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DAY = 24 * 3600e3;
const SQLITE = '/usr/bin/sqlite3';
const GIT = '/usr/bin/git';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const P = {
  claude: path.join(HOME, '.claude'),
  claudeVersions: path.join(HOME, '.local/share/claude/versions'),
  claudeBin: path.join(HOME, '.local/bin/claude'),
  codex: path.join(HOME, '.codex'),
  cursorVersions: path.join(HOME, '.local/share/cursor-agent/versions'),
  cursorBins: ['cursor-agent', 'agent'].map((b) => path.join(HOME, '.local/bin', b)),
  opencode: path.join(HOME, '.local/share/opencode'),
};

// AI desktop apps that update themselves and leave the downloads in ~/Library/Caches: Sparkle keeps update
// packages it already installed, Squirrel (ShipIt) keeps a staged update until the app next quits.
const CACHES = path.join(HOME, 'Library/Caches');
const APP_UPDATES = [
  // com.openai.codex is the ChatGPT app now, which hosts Codex; older installs still have Codex.app
  { tool: 'codex', app: 'ChatGPT', apps: ['ChatGPT', 'Codex'], bundle: 'com.openai.codex' },
  { tool: 'chatgpt', app: 'ChatGPT', bundle: 'com.openai.chat' },
  { tool: 'claude', app: 'Claude', bundle: 'com.anthropic.claudefordesktop' },
  { tool: 'cursor', app: 'Cursor', bundle: 'com.todesktop.230313mzl4w4u92' },
];

// Nothing outside these folders can be sent to the Trash, whatever the scan says.
// Editors built on VS Code list extensions they've replaced in extensions/.obsolete and delete them on a
// later start, which often never comes. These are the editors' own records, so only those folders go.
const EDITORS = [
  { tool: 'gemini', app: 'Antigravity', runs: 'antigravity', dir: path.join(HOME, '.antigravity/extensions') },
  { tool: 'gemini', app: 'Antigravity IDE', runs: 'antigravity-ide', dir: path.join(HOME, '.antigravity-ide/extensions') },
  { tool: 'cursor', app: 'Cursor', runs: 'cursor', dir: path.join(HOME, '.cursor/extensions') },
];

const TRASH_ROOTS = [
  ...EDITORS.map((e) => e.dir),
  P.claude,
  P.claudeVersions,
  P.codex,
  P.cursorVersions,
  path.join(P.opencode, 'log'),
  ...APP_UPDATES.flatMap(({ bundle }) => [path.join(CACHES, bundle, 'org.sparkle-project.Sparkle'), path.join(CACHES, `${bundle}.ShipIt`)]),
];

const TOOLS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', chatgpt: 'ChatGPT', gemini: 'Antigravity' };
const DEFAULT_RETENTION = { claude: 30, codex: 90 }; // days; 0 means never clean

function run(cmd, args, { timeout = 60000, cwd = HOME } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
    child.stdin?.end(); // nothing here answers prompts; a tool that asks gets EOF instead of hanging
  });
}

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const ls = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const stat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const idFor = (...parts) => crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);

// Sizes on disk for a batch of paths, in bytes.
async function sizes(paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    const { stdout } = await run('/usr/bin/du', ['-sk', ...batch], { timeout: 120000 });
    for (const line of stdout.split('\n')) {
      const m = /^(\d+)\t(.*)$/.exec(line);
      if (m) out.set(m[2], +m[1] * 1024);
    }
  }
  return out;
}

// Files in a folder untouched for a day: safe to drop while the tool keeps running.
function staleFiles(dir) {
  const cutoff = Date.now() - DAY;
  return ls(dir)
    .map((f) => path.join(dir, f))
    .filter((p) => {
      const s = stat(p);
      return s && s.mtimeMs < cutoff;
    });
}

/* ---------- what's running ---------- */

async function processes() {
  const { stdout } = await run('/bin/ps', ['-axo', 'comm='], { timeout: 5000 });
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function runningTools(procs) {
  const has = (re) => procs.some((p) => re.test(p));
  return {
    codex: has(/(^|\/)codex$|\/Codex\.app\//),
    cursor: has(/\/Cursor\.app\/|(^|\/)cursor-agent$/),
    opencode: has(/(^|\/)opencode$|\/OpenCode\.app\//),
    claude: has(/\/Claude\.app\/|(^|\/)claude$/),
    chatgpt: has(/\/ChatGPT\.app\//),
    antigravity: has(/\/Antigravity\.app\//),
    'antigravity-ide': has(/\/Antigravity IDE\.app\//),
  };
}

/* ---------- old versions ---------- */

const semver = (v) => v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

function current(bin) {
  try {
    return fs.realpathSync(bin);
  } catch {
    return null;
  }
}

// Keeps the version the command points at, the newest one, and any a process is running from.
function oldVersions(tool, dir, bins, procs) {
  const versions = ls(dir).filter((v) => !v.startsWith('.'));
  if (versions.length < 2) return [];
  const keep = new Set([versions.sort(newer).at(-1)]);
  for (const b of bins) {
    const real = current(b);
    if (real?.startsWith(dir + '/')) keep.add(real.slice(dir.length + 1).split('/')[0]);
  }
  for (const p of procs) if (p.startsWith(dir + '/')) keep.add(p.slice(dir.length + 1).split('/')[0]);
  return versions
    .filter((v) => !keep.has(v))
    .map((v) => ({
      id: idFor('version', dir, v),
      tool,
      group: 'cache',
      kind: 'trash',
      name: `${TOOLS[tool]} ${v}`,
      sub: 'An older copy kept after an update',
      paths: [path.join(dir, v)],
      on: true,
    }));
}

/* ---------- caches ---------- */

function cacheItem(tool, name, sub, paths, blocked) {
  if (!paths.length) return null;
  return { id: idFor('cache', tool, name), tool, group: 'cache', kind: 'trash', name, sub, paths, on: !blocked, blocked };
}

function obsoleteExtensions(dir) {
  let marked = {};
  try {
    marked = JSON.parse(fs.readFileSync(path.join(dir, '.obsolete'), 'utf8')) || {};
  } catch {
    return [];
  }
  // a name the editor wrote; anything that isn't a plain folder name in this folder is ignored
  return Object.keys(marked)
    .filter((n) => marked[n] && /^[\w.-]+$/.test(n))
    .map((n) => path.join(dir, n))
    .filter((p) => stat(p)?.isDirectory());
}

function caches(running) {
  const codexBusy = running.codex && 'Quit Codex first';
  return [
    ...EDITORS.map((e) =>
      cacheItem(e.tool, `${e.app} old extension versions`, `Versions ${e.app} already replaced and marked to delete`, obsoleteExtensions(e.dir), running[e.runs] && `Quit ${e.app} first`)
    ),
    cacheItem('claude', 'Claude Code unsent reports', 'Usage reports that never went out', staleFiles(path.join(P.claude, 'telemetry'))),
    cacheItem('claude', 'Claude Code shell snapshots', 'Rebuilt each time a session starts', staleFiles(path.join(P.claude, 'shell-snapshots'))),
    cacheItem('claude', 'Claude Code debug logs', 'Only useful for bug reports', staleFiles(path.join(P.claude, 'debug'))),
    cacheItem('claude', 'Claude Code paste cache', 'Copies of big pastes', staleFiles(path.join(P.claude, 'paste-cache'))),
    cacheItem('codex', 'Codex cache', 'Rebuilds itself', exists(path.join(P.codex, 'cache')) ? [path.join(P.codex, 'cache')] : [], codexBusy),
    cacheItem('codex', 'Codex logs', 'Only useful for bug reports', staleFiles(path.join(P.codex, 'log')), codexBusy),
    cacheItem('opencode', 'OpenCode logs', 'Only useful for bug reports', staleFiles(path.join(P.opencode, 'log'))),
  ].filter(Boolean);
}

/* ---------- leftover app updates ---------- */

// Left alone while the app (or its updater, which lives inside it) is running, since it may be mid-update.
function appUpdates(procs) {
  const items = [];
  for (const { tool, app, apps = [app], bundle } of APP_UPDATES) {
    const open = procs.some((p) => apps.some((a) => p.includes(`/${a}.app/Contents/`)));
    const blocked = open && `Quit ${app} first`;
    const sparkle = path.join(CACHES, bundle, 'org.sparkle-project.Sparkle');
    const sparkleFiles = ls(sparkle).map((f) => path.join(sparkle, f));
    if (sparkleFiles.length)
      items.push({ id: idFor('update', bundle, 'sparkle'), tool, group: 'cache', kind: 'trash', name: `${app} update downloads`, sub: 'Update files the app already installed', paths: sparkleFiles, on: !blocked, blocked });
    // the staged update goes with its state file, so the installer doesn't look for it on the next quit
    const shipit = path.join(CACHES, `${bundle}.ShipIt`);
    const staged = ls(shipit).filter((f) => f.startsWith('update.')).map((f) => path.join(shipit, f));
    if (staged.length) {
      const state = path.join(shipit, 'ShipItState.plist');
      items.push({ id: idFor('update', bundle, 'shipit'), tool, group: 'cache', kind: 'trash', name: `${app} waiting update`, sub: 'Downloaded but not installed yet; the app fetches it again', paths: [...staged, ...(exists(state) ? [state] : [])], on: !blocked, blocked });
    }
  }
  return items;
}

// The app whose icon stands for each tool on its chip. The CLIs have none of their own, so the maker's app stands in.
const TOOL_APPS = { claude: ['Claude'], codex: ['ChatGPT', 'Codex'], cursor: ['Cursor'], opencode: ['OpenCode'], gemini: ['Antigravity', 'Antigravity IDE'] };
function toolApp(key) {
  for (const name of TOOL_APPS[key] || [])
    for (const dir of ['/Applications', path.join(HOME, 'Applications')]) {
      const p = path.join(dir, name + '.app');
      if (exists(p)) return p;
    }
  return null;
}

/* ---------- tools you've removed ---------- */

// Deleting an app or a command leaves its data in your home folder. Each tool's data only shows up once the
// tool is really gone (checked again just before anything moves), as one item so nothing is left half-removed.
// Never ticked: it's a choice to make.
const resolves = (p) => fs.existsSync(p); // follows links, so a dangling one counts as gone

function opencodeBin() {
  const nvm = path.join(HOME, '.nvm/versions/node');
  return [
    path.join(HOME, '.opencode/bin/opencode'),
    path.join(HOME, '.local/bin/opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    path.join(HOME, '.bun/bin/opencode'),
    path.join(HOME, '.npm-global/bin/opencode'),
    path.join(HOME, 'Library/pnpm/opencode'),
    ...ls(nvm).map((v) => path.join(nvm, v, 'bin/opencode')),
  ].find(resolves);
}

const cursorAgentBin = () => P.cursorBins.find(resolves);
// `agent` is a common name, so a link only counts as Cursor's if it points into Cursor's own folder
function isCursorLink(p) {
  try {
    return path.resolve(path.dirname(p), fs.readlinkSync(p)).startsWith(P.cursorVersions + '/');
  } catch {
    return false;
  }
}
const APP_SUPPORT = path.join(HOME, 'Library/Application Support');
const lib = (...p) => path.join(HOME, 'Library', ...p);
// files in a folder whose names match, for the ones that carry a machine id or a date (ByHost plists, backups)
const matching = (dir, re) => ls(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));

function claudeBin() {
  const nvm = path.join(HOME, '.nvm/versions/node');
  return [
    path.join(HOME, '.local/bin/claude'),
    path.join(HOME, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(HOME, '.npm-global/bin/claude'),
    path.join(HOME, '.bun/bin/claude'),
    path.join(HOME, '.volta/bin/claude'),
    path.join(HOME, 'Library/pnpm/claude'),
    ...ls(nvm).map((v) => path.join(nvm, v, 'bin/claude')),
  ].find(resolves);
}

const appIs = (...names) => names.some((n) => ['/Applications', path.join(HOME, 'Applications')].some((d) => exists(path.join(d, n + '.app'))));

// What each AI app and tool leaves behind, checked against real installs (October 2026). Mole's uninstall
// already takes an app's ~/Library files that match its bundle id; these are the ones it misses, plus the
// dot folders in your home that these tools keep their real data in.
//   apps     Grub offers this right after it uninstalls one of these apps
//   tool     the AI tools column it's cleared from when something else removed the app
//   runs     what must not be running while it goes
//   gone     true only when nothing that still uses this data is installed
//   askOnly  never offered on its own after an uninstall: removes a command that's still installed
const LEFTOVERS = [
  {
    key: 'claude-app',
    apps: ['Claude'],
    tool: 'claude',
    runs: 'claude',
    note: 'Claude app removed',
    name: 'What the Claude app left behind',
    sub: 'The Claude app’s chats cache, settings, logs and update files',
    gone: () => !appIs('Claude'),
    paths: () => [
      lib('Application Support/Claude'),
      lib('Application Support/Claude-3p'),
      lib('Caches/com.anthropic.claudefordesktop'),
      lib('Caches/com.anthropic.claudefordesktop.ShipIt'),
      lib('HTTPStorages/com.anthropic.claudefordesktop'),
      lib('Logs/Claude'),
      lib('Preferences/com.anthropic.claudefordesktop.plist'),
      lib('Saved Application State/com.anthropic.claudefordesktop.savedState'),
      ...matching(lib('Preferences/ByHost'), /^com\.anthropic\.claudefordesktop\./),
      ...matching(lib('Application Support/CrashReporter'), /^Claude_.*\.plist$/),
    ],
  },
  {
    // ~/.claude is shared by the Claude app's Code tab and the claude command; it goes only when both are gone
    key: 'claude',
    apps: ['Claude'],
    tool: 'claude',
    runs: 'claude',
    note: 'Removed',
    name: 'Everything Claude Code left behind',
    sub: 'Neither the Claude app nor the claude command is installed. Sessions, settings, plugins and sign-in',
    gone: () => !appIs('Claude') && !claudeBin(),
    paths: () => [
      P.claude,
      P.claudeVersions,
      path.join(HOME, '.cache/claude'),
      lib('Caches/claude-cli-nodejs'),
      ...matching(HOME, /^\.claude\.json(\..*)?$/),
    ],
  },
  {
    // ChatGPT is the app that hosts Codex now (bundle com.openai.codex); com.openai.chat is its older self, and
    // the computer-use agent (com.openai.sky.CUAService) ships inside it. ChatGPT Atlas (com.openai.atlas) is
    // a separate app and is never touched.
    key: 'chatgpt-app',
    apps: ['ChatGPT', 'Codex'],
    tool: 'codex',
    runs: 'chatgpt',
    note: 'ChatGPT app removed',
    name: 'What the ChatGPT app left behind',
    sub: 'ChatGPT and Codex app data, settings, cookies, widgets and its computer-use agent',
    gone: () => !appIs('ChatGPT', 'Codex'),
    paths: () => [
      lib('Application Support/Codex'),
      lib('Application Support/com.openai.chat'),
      lib('Application Support/com.openai.codex'),
      lib('Application Support/OpenAI'),
      lib('Caches/Codex'),
      lib('Caches/com.openai.chat'),
      lib('Caches/com.openai.codex'),
      lib('HTTPStorages/com.openai.chat'),
      lib('HTTPStorages/com.openai.chat.binarycookies'),
      lib('HTTPStorages/com.openai.codex'),
      lib('HTTPStorages/com.openai.codex.binarycookies'),
      lib('HTTPStorages/ChatGPTHelper.binarycookies'),
      lib('HTTPStorages/com.openai.sky.CUAService'),
      lib('HTTPStorages/com.openai.sky.CUAService.binarycookies'),
      lib('WebKit/com.openai.chat'),
      lib('Containers/com.openai.chat.Widgets'),
      lib('Group Containers/group.com.openai.chat'),
      lib('Group Containers/2DC432GLL2.com.openai.codex.notifications'),
      lib('Group Containers/2DC432GLL2.com.openai.sky.CUAService'),
      lib('Application Scripts/com.openai.chat.Widgets'),
      lib('Application Scripts/group.com.openai.chat'),
      lib('Application Scripts/2DC432GLL2.com.openai.sky.CUAService'),
      lib('Saved Application State/com.openai.chat.savedState'),
      lib('Saved Application State/com.openai.codex.savedState'),
      lib('Preferences/ChatGPTHelper.plist'),
      lib('Preferences/com.openai.codex.plist'),
      lib('Preferences/com.openai.sky.CUAService.plist'),
      ...matching(lib('Preferences'), /^com\.openai\.chat(\..*)?\.plist$/),
    ],
  },
  {
    // ~/.codex is shared by the ChatGPT app and the codex command; it goes only when both are gone
    key: 'codex',
    apps: ['ChatGPT', 'Codex'],
    tool: 'codex',
    runs: 'codex',
    note: 'Removed',
    name: 'Everything Codex left behind',
    sub: 'Neither the ChatGPT app nor the codex command is installed. Sessions, settings and sign-in',
    gone: () => !codexBin(),
    paths: () => [P.codex],
  },
  {
    key: 'antigravity',
    apps: ['Antigravity'],
    tool: 'gemini',
    runs: 'antigravity',
    note: 'Antigravity removed',
    name: 'What Antigravity left behind',
    sub: 'Its extensions, settings, conversations and app data',
    gone: () => !appIs('Antigravity'),
    paths: () => [
      path.join(HOME, '.antigravity'),
      lib('Application Support/Antigravity'),
      lib('Caches/com.google.antigravity'),
      lib('Caches/com.google.antigravity.ShipIt'),
      lib('HTTPStorages/com.google.antigravity'),
      lib('Preferences/com.google.antigravity.plist'),
      lib('Saved Application State/com.google.antigravity.savedState'),
      ...matching(lib('Preferences/ByHost'), /^com\.google\.antigravity\.ShipIt\./),
      // conversations both Antigravity apps share; only once the IDE is gone too
      ...(appIs('Antigravity IDE') ? [] : [path.join(HOME, '.gemini/antigravity')]),
    ],
  },
  {
    key: 'antigravity-ide',
    apps: ['Antigravity IDE'],
    tool: 'gemini',
    runs: 'antigravity-ide',
    note: 'Antigravity IDE removed',
    name: 'What Antigravity IDE left behind',
    sub: 'Its extensions, settings and app data',
    gone: () => !appIs('Antigravity IDE'),
    paths: () => [
      path.join(HOME, '.antigravity-ide'),
      lib('Application Support/Antigravity IDE'),
      lib('Caches/com.google.antigravity-ide'),
      lib('Caches/com.google.antigravity-ide.ShipIt'),
      lib('HTTPStorages/com.google.antigravity-ide'),
      lib('Preferences/com.google.antigravity-ide.plist'),
      lib('Saved Application State/com.google.antigravity-ide.savedState'),
      ...matching(lib('Preferences/ByHost'), /^com\.google\.antigravity-ide\.ShipIt\./),
      ...(appIs('Antigravity') ? [] : [path.join(HOME, '.gemini/antigravity')]),
    ],
  },
  {
    key: 'opencode',
    apps: ['OpenCode'],
    tool: 'opencode',
    runs: 'opencode',
    note: 'Removed',
    name: 'Everything OpenCode left behind',
    sub: 'Neither the OpenCode app nor the opencode command is installed. Chats, settings and sign-in',
    gone: () => !opencodeBin() && !appIs('OpenCode'),
    paths: () => [
      P.opencode,
      path.join(HOME, '.config/opencode'),
      path.join(HOME, '.cache/opencode'),
      path.join(HOME, '.local/state/opencode'),
      path.join(HOME, '.opencode'),
      lib('Application Support/ai.opencode.desktop'),
      lib('Caches/ai.opencode.desktop'),
      lib('WebKit/ai.opencode.desktop'),
      lib('HTTPStorages/ai.opencode.desktop'),
      lib('Preferences/ai.opencode.desktop.plist'),
      lib('Saved Application State/ai.opencode.desktop.savedState'),
    ],
  },
  {
    // the OpenCode app is gone but the opencode command stays: only the app's own files
    key: 'opencode-app',
    apps: ['OpenCode'],
    tool: 'opencode',
    runs: 'opencode',
    note: 'OpenCode app removed',
    name: 'What the OpenCode app left behind',
    sub: 'The app’s settings and web data. The opencode command is still installed, so its chats stay',
    gone: () => !appIs('OpenCode') && !!opencodeBin(),
    paths: () => [
      lib('Application Support/ai.opencode.desktop'),
      lib('Caches/ai.opencode.desktop'),
      lib('WebKit/ai.opencode.desktop'),
      lib('HTTPStorages/ai.opencode.desktop'),
      lib('Preferences/ai.opencode.desktop.plist'),
      lib('Saved Application State/ai.opencode.desktop.savedState'),
    ],
  },
  {
    key: 'cursor',
    apps: ['Cursor'],
    tool: 'cursor',
    runs: 'cursor',
    note: 'Removed',
    name: 'Everything Cursor left behind',
    sub: 'Neither the Cursor app nor cursor-agent is installed. Extensions, settings and sign-in',
    gone: () => !appIs('Cursor') && !cursorAgentBin(),
    paths: () => [path.join(HOME, '.cursor'), path.dirname(P.cursorVersions), ...P.cursorBins.filter(isCursorLink), ...cursorAppFiles()],
  },
  {
    // the command-line agent still uses ~/.cursor, so only the editor's part goes
    key: 'cursor-app',
    apps: ['Cursor'],
    tool: 'cursor',
    runs: 'cursor',
    note: 'Cursor app removed',
    name: 'What the Cursor app left behind',
    sub: 'Its extensions and app data. cursor-agent is still installed, so its settings stay',
    gone: () => !appIs('Cursor') && !!cursorAgentBin(),
    paths: () => [path.join(HOME, '.cursor/extensions'), ...cursorAppFiles()],
  },
  {
    // the app is gone but its command-line agent stays; only removed when asked
    key: 'cursor-cli',
    apps: ['Cursor'],
    tool: 'cursor',
    runs: 'cursor',
    askOnly: true,
    keep: 'cursor-agent',
    note: 'cursor-agent is still installed',
    action: 'Remove it',
    name: 'cursor-agent and its settings',
    sub: 'The cursor-agent command, still installed, with its settings, sign-in and MCP setup in ~/.cursor',
    gone: () => !appIs('Cursor') && !!cursorAgentBin(),
    // everything of Cursor's that the app row doesn't take, so the two never overlap
    paths: () => [
      ...ls(path.join(HOME, '.cursor')).filter((n) => n !== 'extensions').map((n) => path.join(HOME, '.cursor', n)),
      path.dirname(P.cursorVersions),
      ...P.cursorBins.filter(isCursorLink),
    ],
  },
];

function cursorAppFiles() {
  const id = 'com.todesktop.230313mzl4w4u92';
  return [
    lib('Application Support/Cursor'),
    lib('Caches/' + id),
    lib('Caches/' + id + '.ShipIt'),
    lib('HTTPStorages/' + id),
    lib('Preferences/' + id + '.plist'),
    lib('Saved Application State/' + id + '.savedState'),
    lib('Logs/Cursor'),
    ...matching(lib('Preferences/ByHost'), new RegExp('^' + id.replace(/\./g, '\\.') + '\\.')),
  ];
}

function leftovers(running) {
  return LEFTOVERS.filter((l) => !running[l.runs] && l.gone())
    .map((l) => ({ ...l, paths: l.paths().filter(exists) }))
    .filter((l) => l.paths.length)
    .map((l) => ({
      id: idFor('leftovers', l.key),
      tool: l.tool,
      group: 'gone',
      kind: 'leftovers',
      leftover: l.key,
      note: l.note,
      action: l.action || 'Clear',
      askOnly: !!l.askOnly,
      name: l.name,
      sub: l.sub,
      paths: l.paths,
      on: false,
    }));
}

/* ---------- Claude Code sessions ---------- */

function readSlice(file, size, fromEnd) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const len = Math.min(size, total);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? total - len : 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function jsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find((c) => c?.type === 'text' || c?.type === 'input_text')?.text || '';
  return '';
}

// First thing a person typed, not the tool's own wrappers.
const isHuman = (t) => t && !/^\s*</.test(t) && !/^Caveat:/.test(t) && !/^\s*#\s*(AGENTS|CLAUDE)\.md instructions/i.test(t);
const tidyTitle = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 90);

function claudeSession(file) {
  const head = jsonLines(readSlice(file, 256 * 1024, false));
  const tail = jsonLines(readSlice(file, 64 * 1024, true));
  let cwd = null;
  let title = null;
  let summary = null;
  for (const o of head) {
    cwd ||= o.cwd;
    if (o.type === 'summary' && o.summary) summary ||= o.summary;
    if (o.customTitle) summary = o.customTitle;
    if (!title && o.type === 'user' && !o.isMeta) {
      const t = textOf(o.message?.content);
      if (isHuman(t)) title = t;
    }
  }
  for (const o of tail) if (o.customTitle) summary = o.customTitle;
  const stamps = tail.map((o) => Date.parse(o.timestamp)).filter(Number.isFinite);
  const last = stamps.length ? Math.max(...stamps) : stat(file).mtimeMs;
  return { cwd, title: tidyTitle(summary || title || 'Untitled session'), last };
}

function claudeSessions(retentionDays) {
  const now = Date.now();
  const sessions = [];
  const cwds = new Set();
  const root = path.join(P.claude, 'projects');
  for (const proj of ls(root)) {
    const dir = path.join(root, proj);
    for (const f of ls(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const file = path.join(dir, f);
      let info;
      try {
        info = claudeSession(file);
      } catch {
        continue;
      }
      if (info.cwd) cwds.add(info.cwd);
      const touched = Math.max(info.last, stat(file)?.mtimeMs || 0);
      if (now - touched < DAY) continue; // used today: never listed
      const orphan = !!info.cwd && !exists(info.cwd);
      const old = retentionDays > 0 && now - info.last > retentionDays * DAY;
      if (!old && !orphan) continue;
      const extras = UUID.test(id)
        ? [
            path.join(dir, id),
            path.join(P.claude, 'file-history', id),
            path.join(P.claude, 'session-env', id),
            ...ls(path.join(P.claude, 'todos'))
              .filter((t) => t.startsWith(id))
              .map((t) => path.join(P.claude, 'todos', t)),
          ].filter(exists)
        : [];
      sessions.push({
        id: idFor('claude-session', file),
        tool: 'claude',
        group: 'session',
        kind: 'trash',
        name: info.title,
        sub: [info.cwd ? path.basename(info.cwd) : null, orphan ? 'Project folder is gone' : null].filter(Boolean).join(' · '),
        last: info.last,
        orphan,
        paths: [file, ...extras],
        on: false,
      });
    }
  }
  return { sessions, cwds };
}

/* ---------- Codex sessions ---------- */

// Codex's own delete command keeps its session list in step; Grub never edits Codex's database.
// Wherever Codex lives: inside the ChatGPT app now, or as a command from Homebrew, npm, bun and friends.
// Apps opened from Finder get a bare PATH, so the usual install spots are checked by hand too.
function codexBin() {
  const nvm = path.join(HOME, '.nvm/versions/node');
  return [
    // Codex now ships inside the ChatGPT app
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    path.join(HOME, 'Applications/ChatGPT.app/Contents/Resources/codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(HOME, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(HOME, '.npm-global/bin/codex'),
    path.join(HOME, '.bun/bin/codex'),
    path.join(HOME, '.volta/bin/codex'),
    path.join(HOME, 'Library/pnpm/codex'),
    ...ls(nvm).map((v) => path.join(nvm, v, 'bin/codex')),
    ...(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'codex')),
  ].find(exists);
}

function codexSessions(retentionDays) {
  if (!(retentionDays > 0)) return [];
  const now = Date.now();
  const out = [];
  const walk = (dir) => {
    for (const f of ls(dir)) {
      const p = path.join(dir, f);
      const s = stat(p);
      if (!s) continue;
      if (s.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(f)) {
        if (now - s.mtimeMs < Math.max(DAY, retentionDays * DAY)) continue;
        let cwd = null;
        let title = null;
        let threadId = null;
        try {
          for (const o of jsonLines(readSlice(p, 256 * 1024, false))) {
            if (o.type === 'session_meta') {
              cwd = o.payload?.cwd;
              threadId = o.payload?.id;
            }
            if (!title && o.type === 'event_msg' && o.payload?.type === 'user_message' && isHuman(o.payload.message)) title = o.payload.message;
            if (!title && o.payload?.type === 'message' && o.payload.role === 'user') {
              // one message can hold Codex's injected instructions first and the person's words after
              const parts = Array.isArray(o.payload.content) ? o.payload.content.map((c) => textOf([c])) : [textOf(o.payload.content)];
              title = parts.find(isHuman) || null;
            }
          }
        } catch {}
        out.push({
          id: idFor('codex-session', p),
          tool: 'codex',
          group: 'session',
          kind: 'codex-session',
          name: tidyTitle(title || 'Untitled session'),
          sub: cwd ? path.basename(cwd) : '',
          last: s.mtimeMs,
          threadId: UUID.test(threadId || '') ? threadId : null,
          paths: [p],
          on: false,
        });
      }
    }
  };
  walk(path.join(P.codex, 'sessions'));
  return out;
}

/* ---------- finished worktrees ---------- */

async function git(dir, ...args) {
  return run(GIT, ['-C', dir, ...args], { timeout: 30000 });
}

async function baseBranch(dir) {
  const head = (await git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).stdout.trim();
  if (head) return head;
  for (const b of ['main', 'master']) if (!(await git(dir, 'rev-parse', '--verify', '--quiet', b)).err) return b;
  return null;
}

// Claude Code makes worktrees in <repo>/.claude/worktrees/<name>. Listed only when git says nothing is uncommitted.
async function worktrees(cwds, recentCwds) {
  const candidates = new Set();
  for (const cwd of cwds) {
    const i = cwd.indexOf('/.claude/worktrees/');
    if (i >= 0) {
      const rest = cwd.slice(i + 19).split('/')[0];
      candidates.add(cwd.slice(0, i) + '/.claude/worktrees/' + rest);
    } else for (const w of ls(path.join(cwd, '.claude/worktrees'))) candidates.add(path.join(cwd, '.claude/worktrees', w));
  }
  const out = [];
  for (const wt of candidates) {
    if (!stat(wt)?.isDirectory()) continue;
    if ([...recentCwds].some((c) => c === wt || c.startsWith(wt + '/'))) continue;
    const status = await git(wt, 'status', '--porcelain');
    if (status.err || status.stdout.trim()) continue;
    const common = (await git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')).stdout.trim();
    if (!common) continue;
    const repo = path.dirname(common);
    if (repo === wt) continue; // the main checkout, not a worktree
    const branch = (await git(wt, 'branch', '--show-current')).stdout.trim();
    const base = await baseBranch(repo);
    const merged = base ? !(await git(wt, 'merge-base', '--is-ancestor', 'HEAD', base)).err : false;
    out.push({
      id: idFor('worktree', wt),
      tool: 'claude',
      group: 'worktree',
      kind: 'worktree',
      name: path.basename(wt),
      sub: [path.basename(repo), branch && `branch ${branch}`, merged ? `already in ${base}` : 'not merged yet, the branch stays'].filter(Boolean).join(' · '),
      repo,
      merged,
      paths: [wt],
      on: false,
    });
  }
  return out;
}

/* ---------- OpenCode compaction ---------- */

async function opencodeCompaction(running) {
  const db = path.join(P.opencode, 'opencode.db');
  const s = stat(db);
  if (!s || s.size < 200e6) return [];
  const q = (await run(SQLITE, ['-readonly', db, 'pragma page_size; pragma freelist_count;'])).stdout.trim().split('\n').map(Number);
  const free = (q[0] || 0) * (q[1] || 0);
  if (free < s.size * 0.1) return [];
  return [
    {
      id: idFor('vacuum', db),
      tool: 'opencode',
      group: 'maint',
      kind: 'vacuum',
      name: 'Compact OpenCode’s session database',
      sub: 'Hands empty space back to the disk. No sessions are removed.',
      paths: [db],
      bytes: free,
      on: false,
      blocked: running.opencode && 'Quit OpenCode first',
    },
  ];
}

/* ---------- scan ---------- */

let last = null; // the most recent scan: cleaning only acts on items it found

async function scan(settings = {}) {
  const retention = { ...DEFAULT_RETENTION, ...(settings.aiRetention || {}) };
  const procs = await processes();
  const running = runningTools(procs);
  const { sessions: claude, cwds } = claudeSessions(retention.claude);
  const recentCwds = new Set(); // worktrees someone used today stay off the list
  for (const proj of ls(path.join(P.claude, 'projects'))) {
    const dir = path.join(P.claude, 'projects', proj);
    for (const f of ls(dir))
      if (f.endsWith('.jsonl') && Date.now() - (stat(path.join(dir, f))?.mtimeMs || 0) < DAY)
        try {
          const cwd = claudeSession(path.join(dir, f)).cwd;
          if (cwd) recentCwds.add(cwd);
        } catch {}
  }

  // With Codex installed, sessions go through `codex delete` so its own list stays right. Without it nothing
  // reads that list any more, so the session file just goes to the Trash.
  const hasCodex = !!codexBin();
  const codex = codexSessions(retention.codex).map((s) =>
    hasCodex && s.threadId ? s : { ...s, kind: 'trash', sub: [s.sub, hasCodex ? null : 'Codex isn’t installed, so the file goes to the Trash'].filter(Boolean).join(' · ') }
  );

  const items = [
    ...oldVersions('claude', P.claudeVersions, [P.claudeBin], procs),
    ...oldVersions('cursor', P.cursorVersions, P.cursorBins, procs),
    ...caches(running),
    ...appUpdates(procs),
    ...claude,
    ...codex,
    ...(await worktrees(cwds, recentCwds)),
    ...(await opencodeCompaction(running)),
    ...leftovers(running),
  ];
  // a tool that's gone entirely is one item; its logs and old versions are already inside it
  const goneAll = new Set(items.filter((i) => i.kind === 'leftovers' && i.leftover === i.tool).map((i) => i.tool));
  for (let i = items.length - 1; i >= 0; i--) if (goneAll.has(items[i].tool) && items[i].kind !== 'leftovers') items.splice(i, 1);

  const measured = await sizes([...new Set(items.filter((i) => i.bytes == null).flatMap((i) => i.paths))]);
  for (const i of items) {
    i.bytes ??= i.paths.reduce((n, p) => n + (measured.get(p) || 0), 0);
    if (i.blocked) i.on = false;
  }
  const worth = items.filter((i) => i.bytes >= 4096 || i.group === 'session');

  const goneTools = new Set(worth.filter((i) => i.group === 'gone').map((i) => i.tool));
  // every place each tool keeps data, so a column matches what clearing a removed tool takes
  const places = {
    claude: [P.claude, P.claudeVersions],
    codex: [P.codex],
    cursor: [path.join(HOME, '.cursor'), P.cursorVersions, path.join(APP_SUPPORT, 'Cursor')],
    opencode: [P.opencode, path.join(HOME, '.config/opencode'), path.join(HOME, '.cache/opencode'), path.join(HOME, '.local/state/opencode'), path.join(APP_SUPPORT, 'ai.opencode.desktop')],
    gemini: [path.join(HOME, '.gemini'), path.join(HOME, '.antigravity'), path.join(HOME, '.antigravity-ide')],
  };
  const footprint = await sizes(Object.values(places).flat().filter(exists));
  const tools = Object.entries(places)
    .map(([key, dirs]) => ({ key, bytes: dirs.reduce((n, d) => n + (footprint.get(d) || 0), 0), dirs: dirs.filter(exists).map((d) => d.replace(HOME, '~')), app: toolApp(key), gone: goneTools.has(key) }))
    .filter((t) => t.bytes > 0 || goneTools.has(t.key));
  // a removed tool's leftovers outside these folders (its ~/Library files) count toward its column too,
  // so the column always holds what its Clear button takes
  for (const t of tools) {
    const inside = (p) => places[t.key].some((d) => p === d || p.startsWith(d + '/'));
    const extra = [...new Set(worth.filter((i) => i.group === 'gone' && i.tool === t.key).flatMap((i) => i.paths))].filter((p) => !inside(p));
    t.bytes += extra.filter((p) => !extra.some((q) => q !== p && p.startsWith(q + '/'))).reduce((n, p) => n + (measured.get(p) || 0), 0);
  }

  last = { at: Date.now(), items: worth, running };
  return { ok: true, data: { at: last.at, items: worth.map(({ repo, threadId, ...rest }) => rest), tools, retention, running } };
}

/* ---------- clean ---------- */

function insideRoots(p) {
  const r = path.resolve(p);
  return r === p && TRASH_ROOTS.some((root) => r.startsWith(root + '/'));
}

async function trash(paths) {
  for (const p of paths) {
    if (!insideRoots(p)) throw new Error('Outside the folders Grub looks after');
    if (exists(p)) await shell.trashItem(p);
  }
}

const firstLine = (t) => t.trim().split('\n')[0];

async function cleanOne(item, running) {
  if (item.kind === 'trash') {
    // a session someone reopened since the scan is left alone
    if (item.group === 'session' && Date.now() - (stat(item.paths[0])?.mtimeMs || 0) < DAY) throw new Error('Used today, so Grub left it');
    return trash(item.paths);
  }
  if (item.kind === 'codex-session') {
    const file = item.paths[0];
    if (!insideRoots(file) || !exists(file)) throw new Error('Already gone');
    const bin = codexBin();
    if (!bin || !item.threadId) throw new Error('Codex isn’t installed to delete it');
    // a recovery copy goes to the Trash first; then Codex deletes its own way (it refuses sessions open in a window)
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grub-codex-')), path.basename(file));
    fs.copyFileSync(file, copy);
    await shell.trashItem(copy);
    const r = await run(bin, ['delete', '--force', item.threadId], { timeout: 60000 });
    if (exists(file)) throw new Error(firstLine(r.stderr) || 'Codex kept it. It may be open in a window. A copy is in the Trash.');
    return;
  }
  if (item.kind === 'worktree') {
    const wt = item.paths[0];
    if (!wt.includes('/.claude/worktrees/')) throw new Error('Not a Claude Code worktree');
    const status = await git(wt, 'status', '--porcelain');
    if (status.err || status.stdout.trim()) throw new Error('It has uncommitted changes now');
    // no --force: git refuses if anything is left that it would lose
    const r = await git(item.repo, 'worktree', 'remove', wt);
    if (r.err) throw new Error(r.stderr.trim() || 'git would not remove it');
    return;
  }
  if (item.kind === 'leftovers') {
    // checked again now: if the tool came back since the scan, its data stays
    const l = LEFTOVERS.find((x) => x.key === item.leftover);
    if (!l) throw new Error('Grub doesn’t know that one');
    if (!l.gone()) throw new Error(`${TOOLS[l.tool]} is installed again, so its data stays`);
    if (runningTools(await processes())[l.runs]) throw new Error('It’s running. Quit it first');
    const allowed = new Set(l.paths().map((p) => path.resolve(p)));
    const refused = [];
    for (const p of item.paths) {
      if (!allowed.has(path.resolve(p))) throw new Error(`Not ${TOOLS[l.tool]}’s folder`);
      // macOS guards some app containers; one it won't let go of shouldn't stop the rest
      if (exists(p)) await shell.trashItem(p).catch(() => refused.push(p.replace(HOME, '~')));
    }
    if (refused.length) throw new Error(`macOS kept ${refused.join(', ')}`);
    return;
  }
  if (item.kind === 'vacuum') {
    if (running.opencode) throw new Error('Quit OpenCode first');
    const r = await run(SQLITE, [item.paths[0], 'vacuum;'], { timeout: 600000 });
    if (r.err) throw new Error(r.stderr.trim() || 'Compaction failed');
  }
}

async function clean(ids) {
  if (!last) return { ok: false, error: 'Scan first.' };
  const running = runningTools(await processes());
  const results = [];
  for (const id of ids) {
    const item = last.items.find((i) => i.id === id);
    if (!item) {
      results.push({ id, ok: false, error: 'Not in the last scan' });
      continue;
    }
    if (item.blocked) {
      results.push({ id, ok: false, error: item.blocked });
      continue;
    }
    try {
      await cleanOne(item, running);
      results.push({ id, ok: true, bytes: item.bytes });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  last = null; // force a fresh scan before anything else is removed
  return { ok: true, data: { results, freed: results.reduce((n, r) => n + (r.ok ? r.bytes || 0 : 0), 0) } };
}

// Mole's uninstall finds an app's files in ~/Library by its bundle id, but these tools keep most of their data
// in dot folders at the top of your home. After Grub uninstalls one, this says what's left there so the person
// can take it in the same step. `app` is what the app alone left; `all` adds a command-line tool that's still
// installed (Cursor's cursor-agent), which only goes when they say so.
async function leftoversForApp(appPath) {
  const name = path.basename(appPath, '.app');
  const keys = LEFTOVERS.filter((l) => l.apps.includes(name)).map((l) => l.key);
  if (!keys.length || fs.existsSync(appPath)) return null;
  const running = runningTools(await processes());
  const found = leftovers(running).filter((i) => keys.includes(i.leftover));
  if (!found.length) return null;
  const measured = await sizes([...new Set(found.flatMap((i) => i.paths))]);
  const pack = (list) => {
    const paths = [...new Set(list.flatMap((i) => i.paths))];
    // a folder inside another one on the list is already counted by it
    const top = paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(q + '/')));
    return { keys: list.map((i) => i.leftover), bytes: top.reduce((n, p) => n + (measured.get(p) || 0), 0), paths: top.map((p) => ({ path: p.replace(HOME, '~'), bytes: measured.get(p) || 0 })) };
  };
  const app = found.filter((i) => !LEFTOVERS.find((l) => l.key === i.leftover)?.askOnly);
  const extra = found.filter((i) => LEFTOVERS.find((l) => l.key === i.leftover)?.askOnly);
  return { tool: name, app: app.length ? pack(app) : null, all: extra.length ? pack(found) : null, keep: LEFTOVERS.find((l) => l.key === extra[0]?.leftover)?.keep || null };
}

// Clears the leftovers named by key, checked again first exactly as the AI tools page does.
async function clearLeftovers(keys) {
  const running = runningTools(await processes());
  const items = leftovers(running).filter((i) => keys.includes(i.leftover));
  const measured = await sizes([...new Set(items.flatMap((i) => i.paths))]);
  let bytes = 0;
  const failed = [];
  for (const i of items) {
    try {
      const before = i.paths.filter(exists);
      await cleanOne(i, running);
      bytes += before.filter((p) => !before.some((q) => q !== p && p.startsWith(q + '/'))).reduce((n, p) => n + (measured.get(p) || 0), 0);
    } catch (err) {
      failed.push(`${i.name}: ${err.message}`);
    }
  }
  return { ok: !failed.length, bytes, failed };
}

module.exports = { scan, clean, leftoversForApp, clearLeftovers, DEFAULT_RETENTION };
