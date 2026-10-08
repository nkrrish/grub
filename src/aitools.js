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

// Nothing outside these folders can be sent to the Trash, whatever the scan says.
const TRASH_ROOTS = [P.claude, P.claudeVersions, P.codex, P.cursorVersions, path.join(P.opencode, 'log')];

const TOOLS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' };
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

function caches(running) {
  const codexBusy = running.codex && 'Quit Codex first';
  return [
    cacheItem('claude', 'Claude Code unsent reports', 'Usage reports that never went out', staleFiles(path.join(P.claude, 'telemetry'))),
    cacheItem('claude', 'Claude Code shell snapshots', 'Rebuilt each time a session starts', staleFiles(path.join(P.claude, 'shell-snapshots'))),
    cacheItem('claude', 'Claude Code debug logs', 'Only useful for bug reports', staleFiles(path.join(P.claude, 'debug'))),
    cacheItem('claude', 'Claude Code paste cache', 'Copies of big pastes', staleFiles(path.join(P.claude, 'paste-cache'))),
    cacheItem('codex', 'Codex cache', 'Rebuilds itself', exists(path.join(P.codex, 'cache')) ? [path.join(P.codex, 'cache')] : [], codexBusy),
    cacheItem('codex', 'Codex logs', 'Only useful for bug reports', staleFiles(path.join(P.codex, 'log')), codexBusy),
    cacheItem('opencode', 'OpenCode logs', 'Only useful for bug reports', staleFiles(path.join(P.opencode, 'log'))),
  ].filter(Boolean);
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
const isHuman = (t) => t && !/^\s*</.test(t) && !/^Caveat:/.test(t);
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
function codexBin() {
  return [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(HOME, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
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
              const t = textOf(o.payload.content);
              if (isHuman(t)) title = t;
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

  const hasCodex = !!codexBin();
  const codex = codexSessions(retention.codex).map((s) =>
    !s.threadId ? { ...s, blocked: 'No session id inside' } : hasCodex ? s : { ...s, blocked: 'Codex isn’t installed to delete it' }
  );

  const items = [
    ...oldVersions('claude', P.claudeVersions, [P.claudeBin], procs),
    ...oldVersions('cursor', P.cursorVersions, P.cursorBins, procs),
    ...caches(running),
    ...claude,
    ...codex,
    ...(await worktrees(cwds, recentCwds)),
    ...(await opencodeCompaction(running)),
  ];

  const measured = await sizes([...new Set(items.filter((i) => i.bytes == null).flatMap((i) => i.paths))]);
  for (const i of items) {
    i.bytes ??= i.paths.reduce((n, p) => n + (measured.get(p) || 0), 0);
    if (i.blocked) i.on = false;
  }
  const worth = items.filter((i) => i.bytes >= 4096 || i.group === 'session');

  const footprint = await sizes([P.claude, P.codex, path.join(HOME, '.cursor'), path.join(HOME, '.gemini'), P.opencode, P.claudeVersions, P.cursorVersions].filter(exists));
  const tools = Object.entries({
    claude: [P.claude, P.claudeVersions],
    codex: [P.codex],
    cursor: [path.join(HOME, '.cursor'), P.cursorVersions],
    opencode: [P.opencode],
    gemini: [path.join(HOME, '.gemini')],
  })
    .map(([key, dirs]) => ({ key, bytes: dirs.reduce((n, d) => n + (footprint.get(d) || 0), 0) }))
    .filter((t) => t.bytes > 0);

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

module.exports = { scan, clean, DEFAULT_RETENTION };
