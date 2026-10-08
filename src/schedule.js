// Grub's schedule: runs chores on their own at the times people pick, then files a report.
// Everything here runs unattended, so every chore is either a read-only scan ("report")
// or the engine's own unattended mode ("auto"). Nothing ever waits for a password.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEYS = ['clean', 'optimize', 'purge', 'installer', 'updates'];
const MAX_REPORTS = 40;
const TASK_TIMEOUT = 30 * 60 * 1000;
const INSTALLER_AGE_DAYS = 30;

const DEFAULT_CADENCE = { freq: 'weekly', weekday: 1, monthday: 1, time: '09:00' };

function defaults() {
  return {
    routines: Object.fromEntries(KEYS.map((k) => [k, { mode: 'off', cadence: { ...DEFAULT_CADENCE }, since: 0, lastRun: 0 }])),
    reports: [],
  };
}

/* ---------- time ---------- */

function at(date, time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();

// The occurrence of a cadence in the month/week/day that contains `ref`, shifted by `step` units.
function occurrence(c, ref, step) {
  if (c.freq === 'daily') {
    const d = new Date(ref);
    d.setDate(d.getDate() + step);
    return at(d, c.time);
  }
  if (c.freq === 'weekly') {
    const d = new Date(ref);
    d.setDate(d.getDate() - d.getDay() + c.weekday + step * 7);
    return at(d, c.time);
  }
  const y = ref.getFullYear();
  const m = ref.getMonth() + step;
  const first = new Date(y, m, 1);
  first.setDate(Math.min(c.monthday, daysIn(first.getFullYear(), first.getMonth())));
  return at(first, c.time);
}

function prevRun(c, now = new Date()) {
  for (let step = 0; step > -3; step--) {
    const d = occurrence(c, now, step);
    if (d <= now) return d;
  }
  return null;
}

function nextRun(c, now = new Date()) {
  for (let step = 0; step < 3; step++) {
    const d = occurrence(c, now, step);
    if (d > now) return d;
  }
  return null;
}

/* ---------- reading engine output ---------- */

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;
const SIZE = /(\d+(?:\.\d+)?)\s?(TB|GB|MB|KB|B)\b/;

function parseSize(s) {
  const m = SIZE.exec(s || '');
  if (!m) return 0;
  return parseFloat(m[1]) * { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]];
}

function lastSize(s) {
  const all = [...(s || '').matchAll(new RegExp(SIZE.source, 'g'))];
  return all.length ? parseSize(all.at(-1)[0]) : 0;
}

function toLines(out) {
  return out
    .replace(ANSI, '')
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
}

// Splits Mole's output into ➤ sections with their items, plus the boxed summary at the end.
function readMole(lines) {
  const sections = [];
  const summary = [];
  let cur = null;
  let dividers = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (/^={12,}$/.test(t)) {
      dividers++;
      continue;
    }
    if (dividers % 2 === 1) {
      summary.push(t);
      continue;
    }
    const head = /^➤\s+(.+)$/.exec(t);
    if (head) {
      cur = { name: head[1], items: [] };
      sections.push(cur);
      continue;
    }
    const item = /^\s+([✓→◎⊙])\s+(.+)$/.exec(raw);
    if (item && cur) {
      const [name, ...rest] = item[2].split(' · ');
      cur.items.push({ mark: item[1], name, detail: rest.join(' · '), size: lastSize(rest.join(' ')) });
    }
  }
  return { sections, summary };
}

function field(summary, re) {
  for (const l of summary) {
    const m = re.exec(l);
    if (m) return m;
  }
  return null;
}

/* ---------- the runner ---------- */

function createScheduler({ app, env, mo, brew, home, notify, onChange, isBusy, readStatus }) {
  const FILE = () => path.join(app.getPath('userData'), 'schedule.json');
  let state = load();
  let running = null; // { id, current, child, cancelled }
  let timer = null;
  let bootAt = Date.now();

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      const base = defaults();
      for (const k of KEYS) base.routines[k] = { ...base.routines[k], ...(saved.routines?.[k] || {}) };
      base.routines = Object.fromEntries(KEYS.map((k) => [k, { ...base.routines[k], cadence: { ...DEFAULT_CADENCE, ...base.routines[k].cadence } }]));
      base.reports = Array.isArray(saved.reports) ? saved.reports : [];
      return base;
    } catch {
      return defaults();
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(state, null, 2));
  }

  function snapshot() {
    const now = new Date();
    const routines = Object.fromEntries(
      KEYS.map((k) => {
        const r = state.routines[k];
        return [k, { ...r, next: r.mode === 'off' ? null : nextRun(r.cadence, now)?.getTime() ?? null }];
      })
    );
    const next = Object.values(routines)
      .map((r) => r.next)
      .filter(Boolean)
      .sort((a, b) => a - b)[0];
    const nextKeys = next ? KEYS.filter((k) => routines[k].next === next) : [];
    return {
      routines,
      next: next || null,
      nextKeys,
      reports: state.reports,
      running: running && { id: running.id, current: running.current, keys: running.keys },
    };
  }

  function changed() {
    onChange(snapshot());
  }

  /* ----- running a single chore ----- */

  function capture(file, args, extraEnv = {}) {
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        // its own session, so nothing can reach a terminal or wait on one
        child = spawn(file, args, { cwd: home, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return resolve({ code: -1, out: '', error: err.message });
      }
      running.child = child;
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
      };
      const t = setTimeout(kill, TASK_TIMEOUT);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', (err) => {
        clearTimeout(t);
        resolve({ code: -1, out, error: err.code === 'ENOENT' ? 'missing' : err.message });
      });
      child.on('close', (code) => {
        clearTimeout(t);
        if (running) running.child = null;
        resolve({ code, out });
      });
    });
  }

  const NO_AUTH = { NO_COLOR: '1', MOLE_TEST_NO_AUTH: '1' };

  async function doClean(auto) {
    const r = await capture(mo(), auto ? ['clean'] : ['clean', '--dry-run'], NO_AUTH);
    const { sections, summary } = readMole(toLines(r.out));
    const items = sections.flatMap((s) => s.items.filter((i) => i.mark === '→' || (auto && i.mark === '✓' && i.size)).map((i) => ({ ...i, section: s.name })));
    const highlights = items
      .filter((i) => i.size)
      .sort((a, b) => b.size - a.size)
      .slice(0, 4)
      .map((i) => ({ name: i.name, size: i.size }));
    const big = sections
      .flatMap((s) => s.items)
      .filter((i) => i.mark === '⊙' && i.size >= 1e9)
      .slice(0, 2)
      .map((i) => ({ name: i.name, size: i.size, review: true }));
    if (auto) {
      const freed = field(summary, /Tracked cleanup:\s*(?:At least\s+)?([\d.]+\s?[KMGT]?B)/i);
      return { ok: r.code === 0, bytes: freed ? parseSize(freed[1]) : 0, count: items.length, highlights: highlights.concat(big) };
    }
    const found = field(summary, /Potential space:\s*(?:At least\s+)?([\d.]+\s?[KMGT]?B)/i);
    const count = field(summary, /Items:\s*(\d+)/i);
    return { ok: r.code === 0, bytes: found ? parseSize(found[1]) : 0, count: count ? +count[1] : items.length, highlights: highlights.concat(big) };
  }

  async function doOptimize(auto) {
    const r = await capture(mo(), auto ? ['optimize'] : ['optimize', '--dry-run'], NO_AUTH);
    const { sections, summary } = readMole(toLines(r.out));
    const would = field(summary, /(?:Would apply|Applied)\s+(\d+)\s+optimi[sz]ations?/i);
    const warnings = sections.flatMap((s) => s.items.filter((i) => i.mark === '◎').map((i) => ({ name: i.name })));
    const count = would ? +would[1] : 0;
    return {
      // optimize exits non-zero when one step fails, which is normal without admin access
      ok: r.code === 0 || summary.length > 0,
      bytes: 0,
      count,
      note: summary.find((l) => /unchanged|skipped/i.test(l)) || '',
      highlights: warnings.slice(0, 3),
    };
  }

  async function doPurge(auto) {
    const r = await capture(mo(), auto ? ['purge', '--yes'] : ['purge', '--dry-run'], { NO_COLOR: '1' });
    const lines = toLines(r.out);
    const { summary } = readMole(lines);
    const found = lines
      .map((l) => /^\s*✓\s+(?:\[DRY RUN\]\s+)?(.+),\s+([\d.]+\s?[KMGT]?B)\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ name: m[1], size: parseSize(m[2]) }));
    const total = field(summary, /(?:Would free approximately|Estimated space freed|freed)[:\s]+([\d.]+\s?[KMGT]?B)/i);
    const count = field(summary, /Items:\s*(\d+)/i);
    return {
      ok: r.code === 0,
      bytes: total ? parseSize(total[1]) : found.reduce((n, i) => n + i.size, 0),
      count: count ? +count[1] : found.length,
      highlights: found.sort((a, b) => b.size - a.size).slice(0, 4),
    };
  }

  const INSTALLER_DIRS = ['Downloads', 'Desktop', 'Documents', 'Library/Downloads'].map((d) => path.join(home, d)).concat(['/Users/Shared']);
  const INSTALLER_EXT = /\.(dmg|pkg|mpkg|iso|xip)$/i;

  function findInstallers() {
    const out = [];
    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory() && !e.name.endsWith('.app') && depth < 2) walk(p, depth + 1);
        else if (e.isFile() && INSTALLER_EXT.test(e.name)) {
          try {
            const st = fs.statSync(p);
            out.push({ path: p, name: e.name, size: st.size, age: (Date.now() - st.mtimeMs) / 864e5 });
          } catch {}
        }
      }
    };
    INSTALLER_DIRS.forEach((d) => walk(d, 1));
    return out.sort((a, b) => b.size - a.size);
  }

  async function doInstallers(auto) {
    const all = findInstallers();
    if (!auto) {
      return {
        ok: true,
        bytes: all.reduce((n, i) => n + i.size, 0),
        count: all.length,
        old: all.filter((i) => i.age >= INSTALLER_AGE_DAYS).length,
        highlights: all.slice(0, 4).map((i) => ({ name: i.name, size: i.size })),
      };
    }
    // only the ones that have been sitting around a while, and only to the Trash
    const stale = all.filter((i) => i.age >= INSTALLER_AGE_DAYS);
    const { shell } = require('electron');
    const done = [];
    for (const i of stale) {
      if (running?.cancelled) break;
      try {
        await shell.trashItem(i.path);
        done.push(i);
      } catch {}
    }
    return {
      ok: true,
      bytes: done.reduce((n, i) => n + i.size, 0),
      count: done.length,
      left: all.length - done.length,
      highlights: done.slice(0, 4).map((i) => ({ name: i.name, size: i.size })),
    };
  }

  async function doUpdates(auto) {
    const quiet = { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' };
    const list = async () => {
      const r = await capture(brew(), ['outdated', '--json=v2'], quiet);
      const start = r.out.search(/[[{]/);
      try {
        const data = JSON.parse(r.out.slice(start));
        return { ok: true, formulae: data.formulae || [], casks: data.casks || [] };
      } catch {
        return { ok: false, formulae: [], casks: [], error: r.error };
      }
    };
    const before = await list();
    if (!before.ok) return { ok: false, error: before.error === 'missing' ? 'Homebrew is not installed.' : 'Homebrew did not answer.' };
    if (auto && before.formulae.length && !running?.cancelled) {
      // tools only: upgrading apps can quit them mid-use, so those wait for a person
      await capture(brew(), ['upgrade', '--formula'], { HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' });
      const after = await list();
      const upgraded = before.formulae.filter((f) => !after.formulae.some((a) => a.name === f.name));
      return {
        ok: after.ok,
        count: upgraded.length,
        apps: after.casks.length,
        highlights: upgraded.slice(0, 4).map((f) => ({ name: f.name, detail: `${(f.installed_versions || []).at(-1)} → ${f.current_version}` })),
      };
    }
    const all = [...before.casks.map((c) => ({ ...c, cask: true })), ...before.formulae];
    return {
      ok: true,
      count: all.length,
      apps: before.casks.length,
      highlights: all.slice(0, 4).map((f) => ({ name: f.name, detail: `${(f.installed_versions || []).at(-1)} → ${f.current_version}` })),
    };
  }

  const DO = { clean: doClean, optimize: doOptimize, purge: doPurge, installer: doInstallers, updates: doUpdates };

  function freeSpace() {
    try {
      const s = fs.statfsSync('/');
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  /* ----- a batch: every chore that is due, one report ----- */

  async function runBatch(keys, trigger) {
    if (running || !keys.length) return null;
    const id = `r${Date.now()}`;
    running = { id, keys, current: null, child: null, cancelled: false };
    changed();
    const report = { id, at: Date.now(), trigger, read: false, tasks: [], freeBefore: freeSpace(), health: readStatus()?.health_score ?? null };
    for (const key of keys) {
      if (running.cancelled) {
        report.tasks.push({ key, mode: state.routines[key].mode, skipped: true });
        continue;
      }
      running.current = key;
      changed();
      const mode = state.routines[key].mode === 'auto' ? 'auto' : 'report';
      let result;
      try {
        result = await DO[key](mode === 'auto');
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      if (running.cancelled && !result.bytes && !result.count) result = { skipped: true };
      report.tasks.push({ key, mode, ...result });
      if (trigger === 'schedule') state.routines[key].lastRun = Date.now();
    }
    report.freeAfter = freeSpace();
    report.stopped = running.cancelled || false;
    report.finishedAt = Date.now();
    state.reports = [report, ...state.reports].slice(0, MAX_REPORTS);
    running = null;
    save();
    changed();
    notify(report);
    return report;
  }

  function due(now = new Date()) {
    return KEYS.filter((k) => {
      const r = state.routines[k];
      if (r.mode === 'off') return false;
      const prev = prevRun(r.cadence, now);
      // catch up on a run missed while the Mac slept or Grub was closed, but never
      // fire for a time that passed before the routine was set up
      return prev && prev.getTime() > Math.max(r.lastRun || 0, r.since || 0);
    });
  }

  function lowBattery() {
    const bat = readStatus()?.batteries?.[0];
    if (!bat) return false;
    return /discharg/i.test(bat.status || '') && bat.percent != null && bat.percent < 20;
  }

  function tick() {
    if (running) return;
    // give the app a moment after launch or wake before chewing on anything
    if (Date.now() - bootAt < 60_000) return;
    const keys = due();
    if (!keys.length || isBusy() || lowBattery()) return;
    runBatch(keys, 'schedule');
  }

  return {
    start() {
      bootAt = Date.now();
      clearInterval(timer);
      timer = setInterval(tick, 30_000);
      setTimeout(tick, 61_000);
    },
    wake() {
      bootAt = Date.now();
      setTimeout(tick, 61_000);
    },
    get: snapshot,
    set(key, patch) {
      if (!KEYS.includes(key)) return snapshot();
      const r = state.routines[key];
      const next = { ...r };
      if (patch.mode && ['off', 'report', 'auto'].includes(patch.mode)) next.mode = patch.mode;
      if (patch.cadence) next.cadence = sanitizeCadence({ ...r.cadence, ...patch.cadence });
      // turning a routine on or moving its time starts the clock from now
      if (next.mode !== 'off' && (r.mode === 'off' || patch.cadence)) next.since = Date.now();
      state.routines[key] = next;
      save();
      changed();
      return snapshot();
    },
    setAll(patch) {
      for (const k of KEYS) {
        const r = state.routines[k];
        if (patch.cadence) r.cadence = sanitizeCadence({ ...r.cadence, ...patch.cadence });
        if (patch.modes?.[k]) r.mode = patch.modes[k];
        r.since = Date.now();
      }
      save();
      changed();
      return snapshot();
    },
    runNow(keys) {
      const list = (keys?.length ? keys : KEYS.filter((k) => state.routines[k].mode !== 'off')).filter((k) => KEYS.includes(k));
      runBatch(list, 'manual');
      return snapshot();
    },
    cancel() {
      if (!running) return;
      running.cancelled = true;
      try {
        if (running.child) process.kill(-running.child.pid, 'SIGTERM');
      } catch {}
    },
    isRunning: () => !!running,
    markRead(ids) {
      let dirty = false;
      for (const r of state.reports) if (!r.read && (!ids || ids.includes(r.id))) (r.read = true), (dirty = true);
      if (dirty) {
        save();
        changed();
      }
      return snapshot();
    },
    removeReport(id) {
      state.reports = state.reports.filter((r) => r.id !== id);
      save();
      changed();
      return snapshot();
    },
  };
}

function sanitizeCadence(c) {
  const freq = ['daily', 'weekly', 'monthly'].includes(c.freq) ? c.freq : 'weekly';
  const weekday = Math.min(6, Math.max(0, Math.round(+c.weekday || 0)));
  const monthday = Math.min(28, Math.max(1, Math.round(+c.monthday || 1)));
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(c.time) ? c.time : '09:00';
  return { freq, weekday, monthday, time };
}

module.exports = { createScheduler, nextRun, prevRun };
