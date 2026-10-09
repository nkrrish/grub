// The big clean: every scan Grub has, one after another, shown as one list. Whatever the person ticks then
// runs start to finish with nobody watching. Like scheduled checkups, it only touches what the person owns
// (no admin steps), so it never stops to ask for a password.
//
// Mole cleans everything its dry run found, so anything left unticked is added to Mole's own whitelist for
// that one run (Mole's documented way to protect a path) and the person's whitelist is put back afterwards,
// even if Grub quits halfway: the original is saved first and restored at the next launch.

const { spawn } = require('child_process');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { findInstallers, INSTALLER_AGE_DAYS, readMole, toLines, parseSize, field } = require('./schedule');

const STEP_TIMEOUT = 30 * 60 * 1000;
const NO_AUTH = { NO_COLOR: '1', MOLE_TEST_NO_AUTH: '1' };

function createSweep({ app, env, mo, home, aiTools, readSettings, isBusy, onChange, notify }) {
  const WHITELIST = path.join(home, '.config/mole/whitelist');
  const CLEAN_LIST = path.join(home, '.config/mole/clean-list.txt');
  const RESTORE = () => path.join(app.getPath('userData'), 'whitelist-restore.json');
  const FILE = () => path.join(app.getPath('userData'), 'sweep.json');

  let state = load();
  let child = null;
  let cancelled = false;

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      // a scan or run that was cut off by quitting isn't still going
      return { ...saved, phase: saved.found ? 'ready' : 'idle', step: null };
    } catch {
      return { phase: 'idle', step: null, found: null, at: 0, result: null };
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify({ found: state.found, at: state.at, result: state.result }));
  }

  function set(patch) {
    state = { ...state, ...patch };
    onChange(snapshot());
  }

  function snapshot() {
    return { ...state, totals: totals(state.found) };
  }

  // What each source would free with its default ticks, for the dashboard.
  function totals(found) {
    if (!found) return null;
    const sum = (items) => items.filter((i) => i.on).reduce((n, i) => n + (i.size || 0), 0);
    const by = {
      clean: sum(found.clean.flatMap((s) => s.items)),
      purge: sum(found.purge),
      installers: sum(found.installers),
      ai: sum(found.ai),
    };
    return { ...by, all: Object.values(by).reduce((a, b) => a + b, 0) };
  }

  function capture(file, args) {
    return new Promise((resolve) => {
      let out = '';
      try {
        // its own session, so nothing can wait on a terminal
        child = spawn(file, args, { cwd: home, env: { ...env, ...NO_AUTH }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return resolve({ code: -1, out: '', error: err.message });
      }
      const t = setTimeout(() => kill(), STEP_TIMEOUT);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', (err) => {
        clearTimeout(t);
        resolve({ code: -1, out, error: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(t);
        child = null;
        resolve({ code, out });
      });
    });
  }

  function kill() {
    try {
      if (child) process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }

  /* ----- scanning ----- */

  // Mole's dry run writes everything it would clean to clean-list.txt, path by path, under === Section === heads.
  function readCleanList() {
    let text = '';
    try {
      text = fs.readFileSync(CLEAN_LIST, 'utf8');
    } catch {
      return [];
    }
    const sections = [];
    let cur = null;
    for (const line of text.split('\n')) {
      const head = /^===\s*(.+?)\s*===$/.exec(line.trim());
      if (head) {
        cur = { name: head[1], items: [] };
        sections.push(cur);
        continue;
      }
      if (!cur || !line.startsWith('/')) continue;
      const cut = line.lastIndexOf('  # ');
      const p = cut > 0 ? line.slice(0, cut) : line.trim();
      const size = cut > 0 ? parseSize(line.slice(cut + 4).replace(/([\d.]+)\s*([KMGT]?B)/, '$1 $2')) : 0;
      cur.items.push({ id: `clean:${p}`, path: p, name: p.replace(home, '~'), size, on: true });
    }
    return sections.filter((s) => s.items.length);
  }

  async function scanClean() {
    const before = fs.existsSync(CLEAN_LIST) ? fs.statSync(CLEAN_LIST).mtimeMs : 0;
    const r = await capture(mo(), ['clean', '--dry-run']);
    // an old list from an earlier run would show things that aren't there any more
    const after = fs.existsSync(CLEAN_LIST) ? fs.statSync(CLEAN_LIST).mtimeMs : 0;
    if (after <= before) return { sections: [], error: r.code === 0 ? null : 'Mole didn’t finish its look around.' };
    return { sections: readCleanList() };
  }

  async function scanPurge() {
    const r = await capture(mo(), ['purge', '--dry-run']);
    return toLines(r.out)
      .map((l) => /^\s*✓\s+\[DRY RUN\]\s+(.+),\s+([\d.]+\s?[KMGT]?B)\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => {
        const p = m[1].replace(/^~(?=\/)/, home);
        return { id: `purge:${p}`, path: p, name: m[1], size: parseSize(m[2]), on: true };
      });
  }

  function scanInstallers() {
    // fresh downloads might still be wanted, so only the ones that have sat a while start ticked
    return findInstallers(home).map((i) => ({
      id: `installer:${i.path}`,
      path: i.path,
      name: i.name,
      sub: `${Math.round(i.age)} day${Math.round(i.age) === 1 ? '' : 's'} old`,
      size: i.size,
      on: i.age >= INSTALLER_AGE_DAYS,
    }));
  }

  async function scanAi() {
    const r = await aiTools.scan(readSettings());
    if (!r.ok) return [];
    return r.data.items.map((i) => ({ id: `ai:${i.id}`, aiId: i.id, name: i.name, sub: i.sub, size: i.bytes, on: !!i.on, blocked: i.blocked || null, group: i.group }));
  }

  const STEPS = [
    ['clean', 'Sniffing caches, logs and the Trash'],
    ['purge', 'Looking for old build junk'],
    ['installers', 'Finding leftover installers'],
    ['ai', 'Checking AI tools'],
  ];

  async function scan() {
    if (state.phase === 'scanning' || state.phase === 'running') return snapshot();
    if (isBusy()) return { ...snapshot(), busy: true };
    cancelled = false;
    const found = { clean: [], purge: [], installers: [], ai: [] };
    const errors = {};
    for (const [key, label] of STEPS) {
      if (cancelled) break;
      set({ phase: 'scanning', step: { key, label, index: STEPS.findIndex(([k]) => k === key), of: STEPS.length } });
      try {
        if (key === 'clean') {
          const r = await scanClean();
          found.clean = r.sections;
          if (r.error) errors.clean = r.error;
        } else if (key === 'purge') found.purge = await scanPurge();
        else if (key === 'installers') found.installers = scanInstallers();
        else found.ai = await scanAi();
      } catch (err) {
        errors[key] = err.message;
      }
    }
    if (cancelled) {
      set({ phase: state.found ? 'ready' : 'idle', step: null });
      return snapshot();
    }
    state.found = { ...found, errors };
    state.at = Date.now();
    save();
    set({ phase: 'ready', step: null });
    return snapshot();
  }

  /* ----- the whitelist, borrowed for one run ----- */

  function protect(paths) {
    if (!paths.length) return;
    let original = null;
    try {
      original = fs.readFileSync(WHITELIST, 'utf8');
    } catch {}
    fs.writeFileSync(RESTORE(), JSON.stringify({ existed: original != null, content: original || '' }));
    const added = ['', '# Added by Grub for one clean and removed when it ends', ...paths].join('\n');
    fs.mkdirSync(path.dirname(WHITELIST), { recursive: true });
    fs.writeFileSync(WHITELIST, (original || '').replace(/\n*$/, '\n') + added + '\n');
  }

  function restoreWhitelist() {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(RESTORE(), 'utf8'));
    } catch {
      return;
    }
    try {
      if (saved.existed) fs.writeFileSync(WHITELIST, saved.content);
      else fs.rmSync(WHITELIST, { force: true });
      fs.rmSync(RESTORE(), { force: true });
    } catch {}
  }

  /* ----- running ----- */

  function freeSpace() {
    try {
      const s = fs.statfsSync('/');
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  async function trashAll(items) {
    let bytes = 0;
    let failed = 0;
    for (const i of items) {
      if (cancelled) break;
      try {
        await shell.trashItem(i.path);
        bytes += i.size || 0;
      } catch {
        failed++;
      }
    }
    return { bytes, failed };
  }

  // picked: ids from the review list. Clean runs first because it empties the Trash; the things Grub moves
  // to the Trash itself come after, so they stay there to be put back.
  async function run(picked) {
    if (!state.found || state.phase === 'running' || state.phase === 'scanning') return snapshot();
    if (isBusy()) return { ...snapshot(), busy: true };
    const on = new Set(Array.isArray(picked) ? picked : []);
    const f = state.found;
    const cleanItems = f.clean.flatMap((s) => s.items);
    const plan = [
      ['clean', 'Cleaning caches, logs and the Trash', cleanItems.some((i) => on.has(i.id))],
      ['purge', 'Clearing old build junk', f.purge.some((i) => on.has(i.id))],
      ['installers', 'Binning old installers', f.installers.some((i) => on.has(i.id))],
      ['ai', 'Tidying AI tools', f.ai.some((i) => on.has(i.id))],
    ].filter(([, , any]) => any);

    cancelled = false;
    const freeBefore = freeSpace();
    const steps = [];
    try {
      // everything left unticked in Mole's lists is protected for this run
      protect([...cleanItems, ...f.purge].filter((i) => !on.has(i.id)).map((i) => i.path));
      for (const [index, [key, label]] of plan.entries()) {
        if (cancelled) break;
        set({ phase: 'running', step: { key, label, index, of: plan.length } });
        try {
          if (key === 'clean') {
            const r = await capture(mo(), ['clean']);
            const freed = field(readMole(toLines(r.out)).summary, /Tracked cleanup:\s*(?:At least\s+)?([\d.]+\s?[KMGT]?B)/i);
            steps.push({ key, ok: r.code === 0, bytes: freed ? parseSize(freed[1]) : 0 });
          } else if (key === 'purge') {
            const r = await capture(mo(), ['purge', '--yes']);
            steps.push({ key, ok: r.code === 0, bytes: f.purge.filter((i) => on.has(i.id)).reduce((n, i) => n + i.size, 0) });
          } else if (key === 'installers') {
            const r = await trashAll(f.installers.filter((i) => on.has(i.id)));
            steps.push({ key, ok: !r.failed, bytes: r.bytes, failed: r.failed });
          } else {
            const ids = f.ai.filter((i) => on.has(i.id) && !i.blocked).map((i) => i.aiId);
            // AI tools refuses to clean without a fresh scan of its own
            await aiTools.scan(readSettings());
            const r = await aiTools.clean(ids);
            const results = r.ok ? r.data.results : [];
            steps.push({ key, ok: r.ok && results.every((x) => x.ok), bytes: r.ok ? r.data.freed : 0, failed: results.filter((x) => !x.ok).length });
          }
        } catch (err) {
          steps.push({ key, ok: false, error: err.message });
        }
      }
    } finally {
      restoreWhitelist();
    }
    const freeAfter = freeSpace();
    const freed = freeBefore != null && freeAfter != null ? Math.max(0, freeAfter - freeBefore) : steps.reduce((n, s) => n + (s.bytes || 0), 0);
    const result = { at: Date.now(), steps, freed, stopped: cancelled };
    // what was cleaned is gone from the list; the next look starts fresh
    state.found = null;
    state.at = 0;
    state.result = result;
    save();
    set({ phase: 'done', step: null });
    notify(result);
    return snapshot();
  }

  function cancel() {
    cancelled = true;
    kill();
  }

  return { get: snapshot, scan, run, cancel, restoreWhitelist, running: () => state.phase === 'scanning' || state.phase === 'running' };
}

module.exports = { createSweep };
