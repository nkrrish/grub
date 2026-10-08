// Runs engine commands in a hidden terminal and turns their screens into Grub UI.
// The terminal is always fed, so "Watch Grub work" can show the full history.

/* ---------- Grub's mood on the run screen ---------- */

// Each chore gets its own move; prompts and endings override it for a moment.
const MOODS = {
  'clean-dry': 'sniff',
  'optimize-dry': 'sniff',
  clean: 'chomp',
  tidy: 'chomp',
  optimize: 'fluff',
  purge: 'sniff', // scanning; switches to dig once the user confirms
  installer: 'sniff', // scanning; switches to shred once the user confirms
  uninstall: 'evict',
  brew: 'hop',
};

function setMood(mood) {
  $('#runner').dataset.mood = mood;
}

function workMood() {
  if (!run) return 'sniff';
  if (run.removing) return run.key === 'purge' ? 'dig' : 'shred';
  return MOODS[run.key] || 'chomp';
}

/* ---------- ask sheet: confirmations, passwords, reviews ---------- */

let askResolve = null;

function ask({ title, body, list, password, error, buttons }) {
  $('#ask-title').textContent = title;
  $('#ask-body').textContent = body || '';
  $('#ask-error').textContent = error || '';
  $('#ask-error').hidden = !error;
  const listEl = $('#ask-list');
  listEl.hidden = !list?.length;
  listEl.replaceChildren(...(list || []).map((t) => el('li', {}, t)));
  const input = $('#ask-input');
  input.hidden = !password;
  input.value = '';
  $('#ask-actions').replaceChildren(
    ...buttons.map((b) =>
      el('button', { class: 'btn ' + (b.primary ? 'btn-primary' : 'btn-quiet'), onclick: () => closeAsk(b.value) }, b.label)
    )
  );
  document.body.classList.add('ask-open');
  if (run && !run.exited) setMood('wait');
  (password ? input : $('#ask-actions').lastChild).focus();
  return new Promise((r) => (askResolve = r));
}

function closeAsk(value) {
  const r = askResolve;
  askResolve = null;
  const pw = $('#ask-input').value;
  $('#ask-input').value = '';
  document.body.classList.remove('ask-open');
  if (run && !run.exited && !run.picker && !run.stopping) setMood(workMood());
  r?.(value === 'ok-password' ? { password: pw } : value);
}

$('#ask-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeAsk('ok-password');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('ask-open')) closeAsk('cancel');
});

async function confirmRun(body, label, fn) {
  const v = await ask({
    title: 'Ready when you are',
    body,
    buttons: [
      { label: 'Not yet', value: 'cancel' },
      { label, value: 'ok', primary: true },
    ],
  });
  if (v === 'ok') fn();
}

/* ---------- terminal (hidden by default) ---------- */

let term;
let fit;

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    cols: 100,
    rows: 30,
    fontFamily: "'JetBrains Mono', Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 5000,
    theme: {
      background: '#0f0d0b',
      foreground: '#f3ede4',
      cursor: '#b8e34d',
      selectionBackground: 'rgba(184,227,77,0.3)',
      green: '#b8e34d',
      brightGreen: '#c6ec66',
      magenta: '#f4a7b0',
      red: '#ff7a66',
      yellow: '#f2c46d',
      blue: '#8fb8ff',
      cyan: '#7fd6c2',
      black: '#25201c',
      brightBlack: '#7a6f63',
    },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  // typing in the terminal is allowed only while watching
  term.onData((d) => document.body.classList.contains('drawer-open') && window.mole.session.input(d));
  window.mole.session.onData((d) => {
    lastData = Date.now();
    term.write(d, scheduleParse);
  });
  window.mole.session.onExit(onExit);
  new ResizeObserver(refit).observe($('#term'));
  // the terminal font loads lazily; row height grows when it lands, so measure again
  document.fonts.addEventListener('loadingdone', refit);
}

function refit() {
  if (!term || !document.body.classList.contains('drawer-open')) return;
  fit.fit();
  window.mole.session.resize({ cols: term.cols, rows: term.rows });
}

// fetch the terminal font up front so the first measurement uses the real glyphs
document.fonts.load("13px 'JetBrains Mono'").catch(() => {});

function bufferLines(buf = term.buffer.active) {
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
  return out;
}

const send = (keys) => window.mole.session.input(keys);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastData = 0;

// Resolves once the screen has been quiet for a moment after a keypress.
async function settle(quiet = 70, max = 2500) {
  const start = Date.now();
  await sleep(quiet);
  while (Date.now() - lastData < quiet && Date.now() - start < max) await sleep(20);
}

/* ---------- task descriptions ---------- */

const TASKS = {
  'clean-dry': { eyebrow: 'Clean', title: 'Sniffing for junk…', done: (s) => (s.found ? `Grub smells ${bytes(s.found)} of junk.` : 'Hardly a crumb in sight.') },
  clean: { eyebrow: 'Clean', title: 'Chomping your junk…', done: (s) => (s.freed ? `Grub ate ${s.freed}.` : 'All clean. *burp*') },
  'optimize-dry': { eyebrow: 'Optimize', title: 'Checking the burrow…', done: () => 'Here is what Grub would freshen.' },
  optimize: { eyebrow: 'Optimize', title: 'Fluffing the burrow…', done: () => 'Burrow refreshed.' },
  purge: { eyebrow: 'Purge projects', title: 'Digging through your projects…', done: (s) => (s.freed ? `Buried ${s.freed} of build junk.` : 'Nothing buried.') },
  installer: { eyebrow: 'Installers', title: 'Sniffing out old installers…', done: (s) => (s.freed ? `Shredded ${s.freed} of boxes.` : 'No boxes shredded.') },
  uninstall: { eyebrow: 'Uninstall', title: (o) => `Evicting ${o.label || 'the app'}…`, done: (s, o) => (s.ok ? `${o.label || 'The app'} is gone.` : 'Nothing was removed.') },
  tidy: { eyebrow: 'Tidy up', title: 'Tidying up…', done: (s) => (s.freed ? `Tidy! Grub ate ${s.freed}.` : 'Tidy!') },
  brew: { eyebrow: 'Updates', title: (o) => (o.names?.length === 1 ? `Freshening ${o.names[0]}…` : 'Freshening everything…'), done: (s) => (s.ok ? 'All fresh.' : 'Some updates did not finish.') },
};

function taskKey(opts) {
  if (opts.tool === 'tidy') return 'tidy';
  if (opts.tool === 'brew') return 'brew';
  return opts.command + (opts.dryRun ? '-dry' : '');
}

const text = (v, opts) => (typeof v === 'function' ? v(opts) : v);

/* ---------- running ---------- */

let run = null; // { opts, key, handled: {}, busy, exited, code }
let quietResolve = null;

// Where a task's progress screen lives, so the user can leave and come back to it.
function originOf(opts) {
  if (opts.tool === 'tidy') return { view: 'burrow' };
  if (opts.tool === 'brew') return { view: 'updates' };
  if (opts.command === 'uninstall') return { view: 'evict' };
  return { view: 'chores', chore: opts.command };
}

function isRunHome(view, chore) {
  if (!run || run.quiet || run.dismissed) return false;
  return run.origin.view === view && (view !== 'chores' || run.origin.chore === chore);
}

async function runTask(opts) {
  if (run && !run.exited) {
    const v = await ask({
      title: "Grub's mouth is full",
      body: `Grub is still busy with ${text(TASKS[run.key]?.eyebrow, run.opts) || 'another chore'}. Let it finish, or stop it first.`,
      buttons: [
        { label: 'OK', value: 'ok' },
        { label: 'Show progress', value: 'show', primary: true },
      ],
    });
    if (v === 'show') goToRun();
    return;
  }
  ensureTerm();
  term.reset();
  const key = taskKey(opts);
  run = { opts, key, handled: {}, busy: false, exited: false, picker: null, model: null, origin: originOf(opts) };
  const t = TASKS[key] || TASKS.clean;
  $('#run-eyebrow').textContent = t.eyebrow;
  $('#run-title').textContent = text(t.title, opts);
  $('#run-activity').textContent = 'Warming up…';
  $('#run-body').replaceChildren();
  resetProgress();
  setRunActions([{ label: 'Stop', onclick: stopTask }]);
  setMood(workMood());
  document.body.classList.add('is-running');
  if (opts.command === 'uninstall') appsLoaded = false;
  goToRun();
  await window.mole.session.start({ ...opts, cols: term.cols, rows: term.rows });
}

// For background chores like installing the engine: no run screen, just the exit code.
function runQuiet(opts) {
  ensureTerm();
  term.reset();
  run = { opts, key: 'quiet', handled: {}, quiet: true, exited: false };
  return new Promise((resolve) => {
    quietResolve = resolve;
    window.mole.session.start({ ...opts, cols: term.cols, rows: term.rows });
  });
}

function stopTask() {
  // freeze Grub straight away; the summary follows when the process exits
  run.stopping = true;
  setMood('sad');
  setRunActions([{ label: 'Stopping…', onclick: () => {} }]);
  $('#run-actions button').disabled = true;
  window.mole.session.kill();
}

function setRunActions(actions) {
  $('#run-actions').replaceChildren(
    ...actions.map((a) => el('button', { class: 'btn ' + (a.primary ? 'btn-primary' : 'btn-quiet'), onclick: a.onclick }, a.label))
  );
}

function goToRun() {
  if (run?.origin) show(run.origin.view, run.origin.chore);
}

// Shows the run screen on its home page, and the sidebar chip everywhere else.
function syncRunner() {
  const live = run && !run.quiet && !run.dismissed;
  const home = live && isRunHome(current.view, current.chore);
  $('#runner').hidden = !home;
  $$('.nav-item').forEach((b) => b.classList.remove('is-busy'));
  if (live && !run.exited) {
    const { view, chore } = run.origin;
    $$('.nav-item').find((b) => b.dataset.view === view && (view !== 'chores' || b.dataset.chore === chore))?.classList.add('is-busy');
  }
  const chip = $('#run-chip');
  chip.hidden = !live || home;
  if (chip.hidden) return;
  const state = run.exited ? 'done' : run.picker ? 'waiting' : 'running';
  chip.dataset.state = state;
  const name = (TASKS[run.key] || TASKS.clean).eyebrow;
  $('#run-chip-text').textContent = state === 'waiting' ? 'Grub needs you' : `${name} · ${state === 'done' ? 'done' : 'running'}`;
}

$('#run-chip').addEventListener('click', goToRun);

function dismissRun() {
  if (run) run.dismissed = true;
  $('#runner').hidden = true;
  document.body.classList.remove('drawer-open');
}

function closeRunner() {
  dismissRun();
  syncRunner();
  document.body.classList.remove('is-running', 'drawer-open');
  if ($('#view-evict').classList.contains('is-active') && !appsLoaded) loadApps();
  if ($('#view-updates').classList.contains('is-active') && !updatesLoaded) loadUpdates();
  if ($('#view-history').classList.contains('is-active')) loadHistory();
}

function onExit(code) {
  if (!run) return;
  run.exited = true;
  run.code = code;
  digState.cache.clear();
  updatesLoaded = false;
  if (run.quiet) {
    quietResolve?.(code);
    quietResolve = null;
    return;
  }
  if (document.body.classList.contains('ask-open')) closeAsk('cancel');
  if ($('#run-body .pick-list')) $('#run-body').replaceChildren();
  run.picker = false;
  parseNow();
  if (run.model) renderProgress(run.model);
  const s = summarize();
  const t = TASKS[run.key] || TASKS.clean;
  const ok = !run.stopping && (code === 0 || s.freed || s.found);
  $('#run-title').textContent = run.stopping ? 'Stopped. Grub put its fork down.' : ok ? t.done(s, run.opts) : 'Grub stopped early.';
  const dry = run.key.endsWith('-dry');
  $('#run-activity').textContent =
    (run.stopping && 'Anything already cleaned stays cleaned; nothing else was touched.') ||
    s.lines.join(' · ') ||
    (dry ? 'Nothing was touched. That was just a sniff.' : code === 0 ? 'Done.' : 'Open "Watch Grub work" to see what happened.');
  document.body.classList.remove('is-running');
  setMood(ok ? 'done' : 'sad');
  const next =
    !run.stopping && run.key === 'clean-dry' && s.found
      ? { label: 'Chomp it', onclick: () => runTask({ command: 'clean' }) }
      : !run.stopping && run.key === 'optimize-dry'
        ? { label: 'Freshen up', onclick: () => runTask({ command: 'optimize' }) }
        : null;
  const actions = next ? [{ label: 'Not now', onclick: closeRunner }, { ...next, primary: true }] : [{ label: 'Done', primary: true, onclick: closeRunner }];
  setRunActions(actions);
  syncRunner();
}

/* ---------- reading the screen ---------- */

let parseTimer;

function scheduleParse() {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(parseNow, 60);
}

const SPINNER = /^[⠖⠲⠴⠦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*(.*)$/;
const ITEM = /^\s+([✓→◎⊙•↳\-])\s+(.+)$/;
const SIZE = /(\d+(?:\.\d+)?)\s?(GB|MB|KB|B)\b/g;

function sizeOf(s) {
  let last = null;
  for (const m of s.matchAll(SIZE)) last = m;
  return last ? parseSize(last[1] + last[2]) : 0;
}

function parseProgress(lines) {
  const sections = [];
  const summaries = [];
  let cur = null;
  let dividers = 0;
  let activity = '';
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^={12,}$/.test(t)) {
      dividers++;
      if (dividers % 2 === 1) summaries.push({ heading: '', details: [] });
      continue;
    }
    if (dividers % 2 === 1) {
      const s = summaries.at(-1);
      if (!s.heading) s.heading = t;
      else s.details.push(t);
      continue;
    }
    const spin = SPINNER.exec(t);
    if (spin) {
      activity = spin[1];
      continue;
    }
    if (PROMPTS.some((p) => p.re.test(t))) continue;
    const head = /^➤\s+(.+)$/.exec(t);
    if (head) {
      cur = { name: head[1], items: [] };
      sections.push(cur);
      continue;
    }
    if (run.key === 'brew' && /^==>\s+/.test(t)) {
      cur = { name: t.replace(/^==>\s+/, ''), items: [] };
      sections.push(cur);
      continue;
    }
    const item = ITEM.exec(raw);
    if (item && cur) {
      const [name, ...rest] = item[2].split(' · ');
      cur.items.push({ mark: item[1], name, detail: rest.join(' · '), size: sizeOf(item[2]) });
    }
  }
  const lastLine = lines.filter((l) => l.trim()).at(-1)?.trim() || '';
  if (!SPINNER.test(lastLine)) activity = run.key === 'brew' ? lastLine : '';
  return { sections: sections.filter((s) => s.items.length || s === cur), summaries, activity };
}

function summarize() {
  const m = run.model || { sections: [], summaries: [] };
  const found = m.sections.flatMap((s) => s.items).filter((i) => i.mark === '→').reduce((n, i) => n + i.size, 0);
  let freed = '';
  const lines = [];
  for (const s of m.summaries) {
    for (const d of s.details) {
      const f = /(?:Tracked cleanup|Estimated space freed|freed)[:\s]+(?:At least\s+)?(\d+(?:\.\d+)?\s?(?:GB|MB|KB|B))/i.exec(d);
      if (f && !freed) freed = f[1];
      if (/Free space|Applied|Removed|No additional/i.test(d)) lines.push(d.replace(/\s+\|\s+/g, ' · '));
    }
  }
  const ok = run.code === 0 && !m.summaries.some((s) => /incomplete|cancel/i.test(s.heading));
  return { found, freed, lines: lines.slice(0, 3), ok };
}

// Cards are kept and patched in place; only a brand-new section is added (and fades in once).
const sectionEls = new Map();

function itemList(items) {
  return [
    ...items.slice(-6).map((it) =>
      el('li', { class: it.mark === '◎' ? 'is-warn' : '' }, el('span', {}, it.name), it.detail ? el('small', {}, it.detail.replace(/\s*dry$/, '')) : null)
    ),
    items.length > 6 ? el('li', { class: 'run-more' }, `+${items.length - 6} more`) : null,
  ].filter(Boolean);
}

function renderProgress(model) {
  const body = $('#run-body');
  if (run.picker) return;
  if (!model.sections.length) {
    if (!body.querySelector('.digging')) body.replaceChildren(digging('Getting the shovel out…'));
    return;
  }
  body.querySelector('.digging')?.remove();
  const keep = new Set();
  let added = false;
  model.sections.forEach((s, i) => {
    const key = `${i}:${s.name}`;
    keep.add(key);
    let node = sectionEls.get(key);
    if (!node) {
      const size = el('span', { class: 'run-size' });
      const list = el('ul', { class: 'run-items' });
      const root = el('div', { class: 'run-section' }, el('div', { class: 'run-section-head' }, el('span', { class: 'run-tick' }), el('b', {}, s.name), size), list);
      node = { root, size, list, sig: '' };
      sectionEls.set(key, node);
      body.append(root);
      added = true;
    }
    node.root.classList.toggle('is-live', i === model.sections.length - 1 && !run.exited);
    // only things Grub will actually eat count toward the total, not review-only finds
    const total = s.items.filter((it) => it.mark === '→' || it.mark === '✓').reduce((n, it) => n + it.size, 0);
    const sizeText = total ? bytes(total) : '';
    if (node.size.textContent !== sizeText) node.size.textContent = sizeText;
    const sig = s.items.map((it) => it.mark + it.name + it.detail).join('|');
    if (sig !== node.sig) {
      node.sig = sig;
      node.list.replaceChildren(...itemList(s.items));
      node.list.hidden = !s.items.length;
    }
  });
  for (const [key, node] of sectionEls) if (!keep.has(key)) {
    node.root.remove();
    sectionEls.delete(key);
  }
  if (added) body.scrollTop = body.scrollHeight;
}

function resetProgress() {
  sectionEls.clear();
}

function parseNow() {
  if (!run || !term) return;
  if (run.busy) return;
  const active = bufferLines();
  if (!run.quiet) {
    const normal = term.buffer.active.type === 'normal' ? active : bufferLines(term.buffer.normal);
    run.model = parseProgress(normal);
    if (!run.exited) {
      renderProgress(run.model);
      if (run.model.activity) $('#run-activity').textContent = run.model.activity + (run.model.activity.endsWith('…') || run.model.activity.endsWith('...') ? '' : '…');
    }
  }
  if (!run.exited) handlePrompts(active);
}

/* ---------- prompts ---------- */

const PROMPTS = [
  { id: 'sys', re: /System caches need sudo\./ },
  { id: 'firstrun', re: /Press Enter to continue:/ },
  { id: 'password', re: /^Password:\s*$/ },
  { id: 'detach', re: /Detach now\?/ },
  { id: 'purge-pick', re: /Select Artifacts to Purge/ },
  { id: 'inst-pick', re: /Select Installers to Remove/ },
  { id: 'purge-ok', re: /Remove \d+ artifacts?.*confirm/ },
  { id: 'inst-ok', re: /Delete \d+ installers?.*confirm/ },
  { id: 'proceed', re: /Proceed with uninstallation\? \[y\/N\]/ },
  { id: 'app-ok', re: /Remove \d+ app\(s\).*confirm/ },
  // any other yes/no question, e.g. Homebrew's "Do you want to proceed with the upgrade? [y/n]"
  { id: 'yn', re: /^(?!.*Proceed with uninstallation).*[[(](?:[yY](?:es)?)\/(?:[nN]o?)[\])]:?\s*$/ },
  { id: 'creds', re: /Enter your credentials:/ },
];

function countMatches(lines, re) {
  return lines.reduce((n, l) => n + (re.test(l.trim()) ? 1 : 0), 0);
}

function handlePrompts(lines) {
  for (const p of PROMPTS) {
    if (p.id === 'creds') continue;
    const n = p.id.endsWith('-pick') ? (lines.some((l) => p.re.test(l)) ? 1 : 0) : countMatches(lines, p.re);
    if (n > (run.handled[p.id] || 0)) {
      run.handled[p.id] = n;
      respond(p.id, lines);
      return;
    }
  }
}

async function respond(id, lines) {
  run.busy = true;
  try {
    if (id === 'firstrun') send('\r');
    else if (id === 'sys') {
      const pw = await askPassword('To clean system caches too, Grub needs your Mac password. It goes straight to macOS and is never stored.', 'Skip system caches');
      // typing the password at this prompt both chooses "continue" and authenticates
      send(pw && !pw.startsWith(' ') ? pw + '\r' : ' ');
    } else if (id === 'password') {
      const retry = lines.slice(-6).some((l) => /Sorry, try again/.test(l));
      const reason = lines
        .map((l) => l.trim())
        .filter((l) => /^➤ .*(requires|required|Admin)/i.test(l))
        .at(-1)
        ?.replace(/^➤\s*/, '')
        .replace(/,\s*Touch ID or password$/, '');
      const pw = await askPassword(
        (reason ? reason + '. ' : '') + 'Enter your Mac password to let Grub do the admin bits.',
        'Skip these steps',
        retry ? "That didn't work. Try again." : ''
      );
      send(pw ? pw + '\r' : '\x03');
    } else if (id === 'detach') {
      const v = await ask({
        title: 'Eject idle disk images?',
        body: 'Some mounted disk images are keeping your Mac busy. Grub can eject them.',
        buttons: [
          { label: 'Keep them', value: 'keep' },
          { label: 'Eject', value: 'ok', primary: true },
        ],
      });
      send(v === 'ok' ? '\r' : ' ');
    } else if (id === 'yn') {
      const line = lines.map((l) => l.trim()).filter((l) => PROMPTS.find((p) => p.id === 'yn').re.test(l)).at(-1) || '';
      const question = line.replace(/^==>\s*/, '').replace(/\s*[[(][^\])]*[\])]:?\s*$/, '');
      const wordy = /[[(]yes\/no[\])]/i.test(line); // [yes/no] wants the whole word
      const v = await ask({
        title: question.endsWith('?') ? question : question + '?',
        body: run.key === 'brew' ? 'Homebrew is asking before it changes anything.' : 'The engine is asking before it continues.',
        buttons: [
          { label: 'No', value: 'no' },
          { label: 'Yes', value: 'yes', primary: true },
        ],
      });
      send(v === 'yes' ? (wordy ? 'yes\r' : 'y\r') : wordy ? 'no\r' : 'n\r');
    } else if (id === 'purge-ok' || id === 'inst-ok') send('\r');
    else if (id === 'proceed') send('y\r');
    else if (id === 'app-ok') {
      const start = lines.findIndex((l) => /Files to be removed:/.test(l));
      const files = (start >= 0 ? lines.slice(start + 1) : [])
        .map((l) => l.trim())
        .filter((l) => /^[✓◎]\s/.test(l))
        .map((l) => l.replace(/^[✓◎]\s+/, ''))
        .filter((l) => !PROMPTS.some((p) => p.re.test(l)));
      const v = await ask({
        title: `Remove ${run.opts.label || 'this app'}?`,
        body: 'These go to the Trash, so you can still get them back.',
        list: files.slice(0, 40).concat(files.length > 40 ? [`…and ${files.length - 40} more`] : []),
        buttons: [
          { label: 'Keep it', value: 'cancel' },
          { label: 'Move to Trash', value: 'ok', primary: true },
        ],
      });
      send(v === 'ok' ? '\r' : '\x1b');
    } else if (id === 'purge-pick' || id === 'inst-pick') await drivePicker(id);
  } finally {
    run.busy = false;
    scheduleParse();
  }
}

async function askPassword(body, skipLabel, error) {
  const v = await ask({
    title: 'Grub needs a hand',
    body,
    password: true,
    error,
    buttons: [
      { label: skipLabel, value: 'skip' },
      { label: 'Continue', value: 'ok-password', primary: true },
    ],
  });
  return v && v.password ? v.password : null;
}

/* ---------- pickers ---------- */

const ROW = /^\s*(➤)?\s*([●○])\s+(.+?)\s*$/;

function readPicker() {
  const lines = bufferLines();
  const titleIdx = lines.findIndex((l) => /Select (Artifacts|Installers)/.test(l));
  const title = lines[titleIdx] || '';
  const pos = /\[(\d+)\/(\d+)\]/.exec(title);
  const rows = [];
  for (const l of lines.slice(titleIdx + 1)) {
    const m = ROW.exec(l);
    if (m) rows.push({ cursor: !!m[1], selected: m[2] === '●', text: m[3] });
  }
  const selected = /(\d+)\s+selected/.exec(lines.slice(titleIdx, titleIdx + 2).join(' '));
  return { rows, pos: pos ? +pos[1] : null, total: pos ? +pos[2] : rows.length, selectedCount: selected ? +selected[1] : null };
}

async function drivePicker(id) {
  const isPurge = id === 'purge-pick';
  run.picker = true;
  setMood('wait');
  $('#run-activity').textContent = 'Laying it all out…';
  await settle(150);
  // walk the list once to collect every row (long lists scroll)
  const items = [];
  const seen = new Set();
  let snap = readPicker();
  for (let guard = 0; guard < 600; guard++) {
    for (const r of snap.rows) if (!seen.has(r.text)) {
      seen.add(r.text);
      items.push(r);
    }
    if (snap.pos == null || snap.pos >= snap.total) break;
    send('\x1b[B');
    await settle();
    snap = readPicker();
  }
  // back to the top
  if (items.length > 1) {
    send('\x1b[A'.repeat(items.length));
    await settle(120);
  }
  syncRunner();
  const choice = await showPicker(items, isPurge);
  if (!choice) {
    run.picker = false;
    syncRunner();
    send('q');
    return;
  }
  $('#run-activity').textContent = 'Picking them out…';
  for (let i = 0; i < items.length; i++) {
    if (choice[i] !== items[i].selected) {
      send(' ');
      await settle(40);
    }
    if (i < items.length - 1) {
      send('\x1b[B');
      await settle(40);
    }
  }
  const check = readPicker();
  const want = choice.filter(Boolean).length;
  if (check.selectedCount != null && check.selectedCount !== want) {
    send('q');
    await ask({ title: 'Grub fumbled that', body: "The selection didn't line up, so nothing was removed. Try again?", buttons: [{ label: 'OK', value: 'ok', primary: true }] });
    return;
  }
  run.picker = false;
  run.removing = true;
  setMood(workMood());
  syncRunner();
  $('#run-activity').textContent = isPurge ? 'Burying…' : 'Shredding…';
  send('\r');
}

function pickerRow(text) {
  // installer: "name   3.20GB | Downloads"   purge: "─ ~/code/app   312.4MB | node_modules | 2 weeks"
  const clean = text.replace(/^[─┌├└]\s*/, '');
  const [main, ...tags] = clean.split(' | ');
  const sizeMatch = /\s+(\d+(?:\.\d+)?(?:GB|MB|KB|B))$/.exec(main);
  const name = sizeMatch ? main.slice(0, sizeMatch.index).trim() : main.trim();
  return { name, size: sizeMatch ? sizeMatch[1] : '', bytes: sizeMatch ? parseSize(sizeMatch[1]) : 0, tags: tags.map((t) => t.trim()).filter(Boolean) };
}

function showPicker(items, isPurge) {
  const rows = items.map((it) => ({ ...pickerRow(it.text), on: it.selected }));
  $('#run-title').textContent = isPurge ? 'Pick the build junk to bury.' : 'Pick the boxes to shred.';
  $('#run-activity').textContent = isPurge
    ? 'Old, untouched projects are ticked. Recent ones are left alone.'
    : 'Installers Grub found lying around. Tick the ones you no longer need.';
  return new Promise((resolve) => {
    const list = el('div', { class: 'list pick-list' });
    const go = el('button', { class: 'btn btn-primary' });
    const allBox = el('span', { class: 'pick-box', 'aria-hidden': 'true' });
    const allCount = el('span', { class: 'pick-all-count' });
    const allRow = el(
      'button',
      { class: 'pick-all', role: 'checkbox', onclick: () => setAll(!rows.every((r) => r.on)) },
      allBox,
      el('b', {}, 'Select all'),
      allCount
    );
    const boxes = [];
    const update = () => {
      const on = rows.filter((r) => r.on);
      const size = bytes(on.reduce((n, r) => n + r.bytes, 0));
      go.textContent = on.length ? `${isPurge ? 'Bury' : 'Shred'} ${on.length} · ${size}` : 'Pick something';
      go.disabled = !on.length;
      // tri-state: all, none, or some
      const state = on.length === rows.length ? 'true' : on.length ? 'mixed' : 'false';
      allRow.setAttribute('aria-checked', state);
      allBox.setAttribute('aria-checked', state);
      allCount.textContent = `${on.length} of ${rows.length} selected${on.length ? ` · ${size}` : ''}`;
    };
    const setAll = (target) => {
      rows.forEach((r, i) => {
        r.on = target;
        boxes[i].setAttribute('aria-checked', String(target));
      });
      update();
    };
    list.append(
      ...rows.map((r, i) => {
        const box = el('span', { class: 'pick-box', 'aria-hidden': 'true', 'aria-checked': String(r.on) });
        boxes.push(box);
        return el(
          'button',
          {
            class: 'row pick-row',
            role: 'checkbox',
            'aria-checked': String(r.on),
            style: `--i:${Math.min(i, 20)}`,
            onclick: (ev) => {
              r.on = !r.on;
              box.setAttribute('aria-checked', String(r.on));
              ev.currentTarget.setAttribute('aria-checked', String(r.on));
              update();
            },
          },
          box,
          el('div', { class: 'row-name' }, r.name, r.tags.length ? el('span', { class: 'row-sub' }, r.tags.join(' · ')) : null),
          el('div', { class: 'row-size' }, r.size)
        );
      })
    );
    go.addEventListener('click', () => resolve(rows.map((r) => r.on)));
    update();
    resetProgress();
    $('#run-body').replaceChildren(allRow, list);
    $('#run-actions').replaceChildren(el('button', { class: 'btn btn-quiet', onclick: () => resolve(null) }, 'Cancel'), go);
  });
}

/* ---------- watch mode ---------- */

$('#run-watch').addEventListener('click', () => {
  ensureTerm();
  document.body.classList.add('drawer-open');
  document.fonts.ready.then(() =>
    setTimeout(() => {
      refit();
      term.scrollToBottom();
    }, 60)
  );
});

$('#drawer-close').addEventListener('click', () => document.body.classList.remove('drawer-open'));
