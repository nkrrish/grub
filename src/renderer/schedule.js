// Schedule: what Grub checks on by itself, how often, and what it found.

const ROUTINES = [
  {
    key: 'clean',
    name: 'Clean',
    about: 'Caches, logs and leftovers from deleted apps',
    report: 'Sniffs for junk and tells you. Deletes nothing.',
    auto: 'Eats the junk. System caches that need your password are left for you.',
    icon: '<path d="M5 8h14l-1.2 11a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" /><path d="M9 8V5h6v3" />',
  },
  {
    key: 'optimize',
    name: 'Optimize',
    about: 'Refreshes caches and services that go stale',
    report: 'Checks what could be freshened. Changes nothing.',
    auto: 'Freshens what it can. Steps that need your password are skipped.',
    icon: '<path d="M13 3L5 13h6l-1 8 8-10h-6z" />',
  },
  {
    key: 'purge',
    name: 'Purge projects',
    about: 'Build folders in code you no longer touch',
    report: 'Measures old build junk. Removes nothing.',
    auto: 'Buries build junk from projects untouched for a while. Recent work is left alone.',
    icon: '<path d="M4 7h16M4 12h16M4 17h10" />',
  },
  {
    key: 'installer',
    name: 'Installers',
    about: 'Old .dmg and .pkg files from Downloads and Desktop',
    report: 'Counts the installers lying around. Removes nothing.',
    auto: 'Moves installers older than a month to the Trash, so you can still get them back.',
    icon: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z" /><path d="M4 8l8 4 8-4M12 12v8" />',
  },
  {
    key: 'updates',
    name: 'Updates',
    about: 'Apps and tools installed with Homebrew',
    report: 'Checks for newer versions and lists them.',
    auto: 'Updates command-line tools. Apps wait for you, so nothing quits mid-use.',
    icon: '<path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" />',
  },
];

const MODES = [
  { id: 'off', label: 'Off' },
  { id: 'report', label: 'Report' },
  { id: 'auto', label: 'Auto' },
];

const ROUTINE = Object.fromEntries(ROUTINES.map((r) => [r.key, r]));
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let sched = null;
let schedFresh = new Set(); // reports that were unread when this visit started
let openReport = null;

const svg = (paths, cls = '') => icon(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`);

/* ---------- words for times ---------- */

function clock(time) {
  const [h, m] = time.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function cadenceLabel(c) {
  if (c.freq === 'daily') return `Every day · ${clock(c.time)}`;
  if (c.freq === 'weekly') return `${WEEKDAYS[c.weekday]}s · ${clock(c.time)}`;
  return `Monthly on the ${ordinal(c.monthday)} · ${clock(c.time)}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(d) - start(today)) / 864e5);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  if (days === -1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]}, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

function untilLabel(ts) {
  const mins = Math.round((ts - Date.now()) / 60000);
  if (mins < 1) return 'any moment now';
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/* ---------- page ---------- */

async function showSchedule() {
  if (!sched) sched = await window.mole.schedule.get();
  // unread reports keep a "New" tag for this visit; the sidebar badge clears right away
  schedFresh = new Set(sched.reports.filter((r) => !r.read).map((r) => r.id));
  if (schedFresh.size) openReport = sched.reports[0]?.id;
  renderSchedule();
  if (schedFresh.size) sched = await window.mole.schedule.read();
}

function renderSchedule() {
  if (!sched) return;
  renderBadge();
  if (!$('#view-schedule').classList.contains('is-active')) return;
  const on = ROUTINES.filter((r) => sched.routines[r.key].mode !== 'off');
  $('#sched-title').textContent = sched.running
    ? 'Grub is out foraging.'
    : !on.length
      ? "Grub's feeding schedule."
      : on.every((r) => sched.routines[r.key].mode === 'auto')
        ? 'Grub feeds itself.'
        : 'Grub checks in on its own.';
  renderNext(on);
  renderRoutines();
  renderReports();
}

function renderBadge() {
  const unread = sched.reports.filter((r) => !r.read).length;
  const badge = $('#schedule-badge');
  badge.hidden = !unread;
  badge.textContent = unread > 9 ? '9+' : unread;
  $('#nav-schedule').setAttribute('aria-label', unread ? `Schedule, ${unread} new report${unread === 1 ? '' : 's'}` : 'Schedule');
}

/* ----- the strip at the top: next run, running now, or a way to start ----- */

function renderNext(on) {
  const box = $('#sched-next');
  if (sched.running) {
    const { keys, current } = sched.running;
    const at = keys.indexOf(current);
    box.className = 'sched-next is-running';
    box.replaceChildren(
      el('img', { class: 'sched-next-mark', src: '../../brand/mark.svg', alt: '', width: 40, height: 40 }),
      el(
        'div',
        { class: 'sched-next-main' },
        el('span', { class: 'sched-next-label' }, 'Checking now'),
        el('strong', {}, `${ROUTINE[current]?.name || 'Getting ready'}…`),
        el(
          'ol',
          { class: 'sched-steps', 'aria-label': 'Progress' },
          ...keys.map((k, i) => el('li', { class: i < at ? 'is-done' : i === at ? 'is-now' : '' }, ROUTINE[k].name))
        )
      ),
      el('button', { class: 'btn btn-quiet', onclick: () => window.mole.schedule.cancel() }, 'Stop')
    );
    return;
  }
  if (!on.length) {
    box.className = 'sched-next is-empty';
    box.replaceChildren(
      el('img', { class: 'sched-next-mark', src: '../../brand/mark.svg', alt: '', width: 48, height: 48 }),
      el(
        'div',
        { class: 'sched-next-main' },
        el('strong', {}, 'Nothing on the menu yet.'),
        el('span', {}, 'Start with a weekly checkup: every Monday morning Grub sniffs around and reports back. It won’t delete a thing until you say so.')
      ),
      el('button', { class: 'btn btn-primary', onclick: startCheckup }, 'Start weekly checkup')
    );
    return;
  }
  box.className = 'sched-next';
  const included = sched.nextKeys.map((k) => ROUTINE[k].name);
  const kids = [
    el(
      'div',
      { class: 'sched-next-main' },
      el('span', { class: 'sched-next-label' }, 'Next checkup'),
      el('strong', {}, dayLabel(sched.next), el('span', { class: 'sched-next-until' }, untilLabel(sched.next))),
      el('span', { class: 'sched-next-what' }, included.join(' · '))
    ),
    el('button', { class: 'btn btn-quiet', onclick: runNow }, 'Run now'),
  ];
  box.replaceChildren(...kids);
  // schedules only fire while Grub is open, so nudge towards opening at login
  if (!settings.openAtLogin) {
    const sw = el('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': 'false',
      'aria-label': 'Open Grub at login',
      onclick: async () => {
        await saveSetting({ openAtLogin: true });
        renderSchedule();
      },
    });
    box.append(
      el(
        'div',
        { class: 'sched-next-warn' },
        svg('<circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16v.5" />'),
        el('span', {}, 'Grub keeps its schedule while it’s open in the menu bar. Open it at login so it never misses one.'),
        sw
      )
    );
  }
}

async function startCheckup() {
  sched = await window.mole.schedule.setAll({
    cadence: { freq: 'weekly', weekday: 1, time: '09:00' },
    modes: { clean: 'report', purge: 'report', installer: 'report', updates: 'report' },
  });
  renderSchedule();
}

async function runNow() {
  if (run && !run.exited) {
    return ask({
      title: "Grub's mouth is full",
      body: 'Grub is busy with something you started. The checkup can run once that’s done.',
      buttons: [{ label: 'OK', value: 'ok', primary: true }],
    });
  }
  sched = await window.mole.schedule.runNow();
  renderSchedule();
}

/* ----- routine rows ----- */

const rowEls = new Map();

function renderRoutines() {
  const list = $('#sched-list');
  for (const r of ROUTINES) {
    let row = rowEls.get(r.key);
    if (!row) {
      row = buildRow(r);
      rowEls.set(r.key, row);
      list.append(row.root);
    }
    const state = sched.routines[r.key];
    const idx = MODES.findIndex((m) => m.id === state.mode);
    row.root.dataset.mode = state.mode;
    row.seg.style.setProperty('--idx', idx);
    row.seg.dataset.mode = state.mode;
    row.radios.forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === idx));
      b.tabIndex = i === idx ? 0 : -1;
    });
    row.sub.textContent = state.mode === 'off' ? r.about : state.mode === 'auto' ? r.auto : r.report;
    row.when.textContent = cadenceLabel(state.cadence);
    row.cadence.setAttribute('aria-label', `${r.name} runs ${cadenceLabel(state.cadence)}. Change`);
  }
}

function buildRow(r) {
  const sub = el('span', { class: 'row-sub sched-sub' });
  const when = el('span', {});
  const cadence = el(
    'button',
    { class: 'sched-cadence', 'aria-haspopup': 'dialog', onclick: (e) => openCadence(r.key, e.currentTarget) },
    svg('<circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 1.5" />'),
    when,
    svg('<path d="M7 10l5 5 5-5" />', 'sched-caret')
  );
  const seg = el('div', { class: 'mode-seg', role: 'radiogroup', 'aria-label': `${r.name}: what Grub does` });
  const radios = MODES.map((m, i) =>
    el(
      'button',
      {
        role: 'radio',
        'data-mode': m.id,
        onclick: () => setMode(r.key, m.id),
        onkeydown: (e) => {
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          if (!step) return;
          e.preventDefault();
          const next = (i + step + MODES.length) % MODES.length;
          setMode(r.key, MODES[next].id).then(() => rowEls.get(r.key).radios[next].focus());
        },
      },
      m.label
    )
  );
  seg.append(el('span', { class: 'mode-seg-pill', 'aria-hidden': 'true' }), ...radios);
  const root = el(
    'div',
    { class: 'sched-row', role: 'listitem' },
    el('span', { class: 'sched-icon' }, svg(r.icon)),
    el('div', { class: 'sched-name' }, el('b', {}, r.name), sub),
    cadence,
    seg
  );
  return { root, sub, when, cadence, seg, radios };
}

async function setMode(key, mode) {
  if (sched.routines[key].mode === mode) return;
  // show the choice straight away; the saved copy follows
  sched.routines[key].mode = mode;
  renderRoutines();
  sched = await window.mole.schedule.set(key, { mode });
  renderSchedule();
}

/* ----- cadence popover ----- */

const pop = el('div', { class: 'sched-pop', role: 'dialog', 'aria-label': 'When Grub runs this', hidden: '' });
document.body.append(pop);
let popFor = null;

function openCadence(key, trigger) {
  if (popFor?.key === key) return closeCadence();
  popFor = { key, trigger };
  renderPop();
  pop.hidden = false;
  placePop();
  requestAnimationFrame(() => pop.classList.add('is-open'));
  pop.querySelector('[aria-checked="true"]')?.focus();
}

// Re-run whenever the button or the popover changes size, so it stays pinned to its trigger.
function placePop() {
  if (!popFor) return;
  const r = popFor.trigger.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const below = r.bottom + 8 + h < innerHeight - 12;
  const left = Math.max(12, Math.min(r.right - w, innerWidth - w - 12));
  pop.style.left = `${left}px`;
  pop.style.top = `${below ? r.bottom + 8 : r.top - h - 8}px`;
  // grow out of the button that opened it
  pop.style.transformOrigin = `${r.left + r.width / 2 - left}px ${below ? 'top' : 'bottom'}`;
}

function closeCadence() {
  if (!popFor) return;
  const { trigger } = popFor;
  popFor = null;
  pop.classList.remove('is-open');
  setTimeout(() => !popFor && (pop.hidden = true), 140);
  trigger.focus();
}

async function setCadence(patch) {
  const { key } = popFor;
  sched.routines[key].cadence = { ...sched.routines[key].cadence, ...patch };
  renderPop();
  renderRoutines();
  placePop();
  sched = await window.mole.schedule.set(key, { cadence: patch });
  renderSchedule();
  placePop();
}

function radioRow(label, options, current, onPick, cls) {
  return el(
    'div',
    { class: `pop-radios ${cls || ''}`, role: 'radiogroup', 'aria-label': label },
    ...options.map(([value, text, full], i) =>
      el(
        'button',
        {
          role: 'radio',
          'aria-checked': String(value === current),
          'aria-label': full || text,
          tabindex: value === current ? '0' : '-1',
          onclick: () => onPick(value),
          onkeydown: (e) => {
            const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
            if (!step) return;
            e.preventDefault();
            const next = options[(i + step + options.length) % options.length][0];
            onPick(next);
            requestAnimationFrame(() => pop.querySelector(`[aria-label="${label}"] [aria-checked="true"]`)?.focus());
          },
        },
        text
      )
    )
  );
}

function renderPop() {
  const { key } = popFor;
  const c = sched.routines[key].cadence;
  const time = el('input', {
    class: 'pop-time',
    type: 'time',
    value: c.time,
    'aria-label': 'Time',
    onchange: (e) => e.target.value && setCadence({ time: e.target.value }),
  });
  const day = el(
    'select',
    { class: 'pop-select', 'aria-label': 'Day of the month', onchange: (e) => setCadence({ monthday: +e.target.value }) },
    ...Array.from({ length: 28 }, (_, i) => el('option', { value: i + 1, ...(c.monthday === i + 1 ? { selected: '' } : {}) }, ordinal(i + 1)))
  );
  const parts = [
    el('div', { class: 'pop-label' }, 'How often'),
    radioRow('How often', [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']], c.freq, (freq) => setCadence({ freq }), 'pop-freq'),
    c.freq === 'weekly'
      ? el(
          'div',
          {},
          el('div', { class: 'pop-label' }, 'On'),
          // Monday first, like a calendar
          radioRow('Day of the week', [1, 2, 3, 4, 5, 6, 0].map((d) => [d, WEEKDAYS[d][0], WEEKDAYS[d]]), c.weekday, (weekday) => setCadence({ weekday }), 'pop-days')
        )
      : null,
    c.freq === 'monthly' ? el('div', { class: 'pop-line' }, el('span', { class: 'pop-label' }, 'On the'), day) : null,
    el('div', { class: 'pop-line' }, el('span', { class: 'pop-label' }, 'At'), time),
    el(
      'div',
      { class: 'pop-foot' },
      el(
        'button',
        {
          class: 'btn-link pop-all',
          onclick: async () => {
            sched = await window.mole.schedule.setAll({ cadence: sched.routines[key].cadence });
            renderSchedule();
            closeCadence();
          },
        },
        'Use for every chore'
      ),
      el('button', { class: 'btn btn-primary pop-done', onclick: closeCadence }, 'Done')
    ),
  ].filter(Boolean);
  pop.replaceChildren(...parts);
}

document.addEventListener('pointerdown', (e) => {
  if (popFor && !pop.contains(e.target) && !popFor.trigger.contains(e.target)) closeCadence();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popFor) closeCadence();
});
$('#view-schedule').addEventListener('scroll', () => popFor && closeCadence(), { passive: true });

/* ----- reports ----- */

const sizeOrNothing = (n) => (n ? bytes(n) : '');

// One line per chore: what happened, how big, and the next step if there is one.
function taskLine(t) {
  const auto = t.mode === 'auto';
  if (t.skipped) return { text: 'Skipped. You started something yourself.', tone: 'muted' };
  if (t.ok === false) return { text: `Couldn’t finish${t.error ? `: ${t.error}` : '.'}`, tone: 'bad' };
  switch (t.key) {
    case 'clean':
      return auto
        ? { text: t.bytes ? `Ate ${t.count || 'some'} bits of junk` : 'Nothing worth eating', size: t.bytes, tone: t.bytes ? 'good' : 'muted' }
        : {
            text: t.bytes ? `Found junk in ${t.count} spots` : 'Hardly a crumb',
            size: t.bytes,
            tone: t.bytes ? 'todo' : 'muted',
            act: t.bytes && { label: 'Chomp it', run: () => confirmRun(CHORES.clean.confirm, CHORES.clean.chomp, () => runTask({ command: 'clean' })) },
          };
    case 'optimize':
      return auto
        ? { text: t.count ? `Freshened ${t.count} thing${t.count === 1 ? '' : 's'}` : 'Already fresh', tone: t.count ? 'good' : 'muted', note: 'Admin steps skipped' }
        : {
            text: t.count ? `${t.count} thing${t.count === 1 ? '' : 's'} could be freshened` : 'Already fresh',
            tone: t.count ? 'todo' : 'muted',
            act: t.count && { label: 'Freshen up', run: () => confirmRun(CHORES.optimize.confirm, CHORES.optimize.chomp, () => runTask({ command: 'optimize' })) },
          };
    case 'purge':
      return auto
        ? { text: t.bytes ? 'Buried old build junk' : 'No stale build junk', size: t.bytes, tone: t.bytes ? 'good' : 'muted' }
        : {
            text: t.bytes ? `Build junk in ${t.count} folder${t.count === 1 ? '' : 's'}` : 'No stale build junk',
            size: t.bytes,
            tone: t.bytes ? 'todo' : 'muted',
            act: t.bytes && { label: 'Review', run: () => runTask({ command: 'purge' }) },
          };
    case 'installer':
      return auto
        ? {
            text: t.count ? `Moved ${t.count} old installer${t.count === 1 ? '' : 's'} to the Trash` : 'No old installers',
            size: t.bytes,
            tone: t.count ? 'good' : 'muted',
            note: t.left ? `${t.left} newer left alone` : '',
          }
        : {
            text: t.count ? `${t.count} installer${t.count === 1 ? '' : 's'} lying around` : 'No installers lying around',
            size: t.bytes,
            tone: t.count ? 'todo' : 'muted',
            note: t.old ? `${t.old} older than a month` : '',
            act: t.count && { label: 'Review', run: () => runTask({ command: 'installer' }) },
          };
    case 'updates':
      return auto
        ? {
            text: t.count ? `Updated ${t.count} tool${t.count === 1 ? '' : 's'}` : 'Tools already fresh',
            tone: t.count ? 'good' : 'muted',
            note: t.apps ? `${t.apps} app${t.apps === 1 ? '' : 's'} waiting for you` : '',
            act: t.apps && { label: 'See updates', run: () => show('updates') },
          }
        : {
            text: t.count ? `${t.count} update${t.count === 1 ? '' : 's'} waiting` : 'Everything is fresh',
            tone: t.count ? 'todo' : 'muted',
            act: t.count && { label: 'See updates', run: () => show('updates') },
          };
  }
  return { text: '' };
}

function headline(r) {
  const sum = (mode) => r.tasks.filter((t) => t.mode === mode && !t.skipped && t.key !== 'updates').reduce((n, t) => n + (t.bytes || 0), 0);
  const ate = sum('auto');
  const found = sum('report');
  if (r.stopped && !ate && !found) return 'Checkup stopped early.';
  if (ate && found) return `Ate ${bytes(ate)}, found ${bytes(found)} more.`;
  if (ate) return `Grub ate ${bytes(ate)}.`;
  if (found) return `${bytes(found)} of junk to eat.`;
  const todo = r.tasks.some((t) => taskLine(t).tone === 'todo');
  return todo ? 'A few things want your eye.' : 'Spotless. Nothing to eat.';
}

function renderReports() {
  const box = $('#sched-reports');
  const reports = sched.reports;
  $('#sched-reports-count').textContent = reports.length ? `${reports.length} kept` : '';
  if (!reports.length) {
    box.replaceChildren(el('div', { class: 'empty sched-empty' }, 'No reports yet. The first one lands here after Grub’s next checkup.'));
    return;
  }
  if (!reports.some((r) => r.id === openReport)) openReport = reports[0].id;
  box.replaceChildren(...reports.map(reportCard));
}

function reportCard(r) {
  const open = r.id === openReport;
  const delta = r.freeAfter != null && r.freeBefore != null ? r.freeAfter - r.freeBefore : null;
  const facts = [
    r.freeAfter != null && ['Free space', bytes(r.freeAfter) + (delta > 5e7 ? ` (+${bytes(delta)})` : '')],
    r.health != null && ['Health', String(r.health)],
    ['Took', duration(r.finishedAt - r.at)],
  ].filter(Boolean);
  const body = el(
    'div',
    { class: 'report-body', id: `report-${r.id}` },
    el(
      'div',
      { class: 'report-inner' },
      el('dl', { class: 'report-facts' }, ...facts.flatMap(([k, v]) => [el('div', {}, el('dt', {}, k), el('dd', {}, v))])),
      el('ul', { class: 'report-tasks' }, ...r.tasks.map(taskRow))
    )
  );
  return el(
    'article',
    { class: `report${open ? ' is-open' : ''}`, 'data-id': r.id },
    el(
      'button',
      {
        class: 'report-head',
        'aria-expanded': String(open),
        'aria-controls': `report-${r.id}`,
        onclick: () => toggleReport(r.id),
      },
      el(
        'div',
        { class: 'report-when' },
        dayLabel(r.at),
        el('span', { class: 'tag' }, r.trigger === 'schedule' ? 'Scheduled' : 'Run now'),
        schedFresh.has(r.id) ? el('span', { class: 'tag is-on' }, 'New') : null
      ),
      el('div', { class: 'report-title' }, headline(r)),
      svg('<path d="M7 10l5 5 5-5" />', 'report-caret')
    ),
    body
  );
}

// Flip classes on the cards already on screen so opening and closing can animate.
function toggleReport(id) {
  openReport = openReport === id ? null : id;
  for (const card of $$('#sched-reports .report')) {
    const open = card.dataset.id === openReport;
    card.classList.toggle('is-open', open);
    card.querySelector('.report-head').setAttribute('aria-expanded', String(open));
  }
}

function taskRow(t) {
  const r = ROUTINE[t.key];
  const line = taskLine(t);
  // big things the engine won't touch on its own (say, Docker's data) always make the cut
  const all = (t.highlights || []).filter((h) => h.name);
  const review = all.filter((h) => h.review);
  const highlights = all.filter((h) => !h.review).slice(0, Math.max(1, 3 - review.length)).concat(review);
  return el(
    'li',
    { class: `report-task tone-${line.tone || 'muted'}` },
    el('span', { class: 'report-task-icon' }, svg(r.icon)),
    el(
      'div',
      { class: 'report-task-main' },
      el('div', { class: 'report-task-line' }, el('b', {}, r.name), el('span', { class: 'tag' }, t.mode === 'auto' ? 'Auto' : 'Report'), el('span', { class: 'report-task-text' }, line.text)),
      line.note ? el('span', { class: 'row-sub' }, line.note) : null,
      highlights.length
        ? el(
            'ul',
            { class: 'report-highlights' },
            ...highlights.map((h) =>
              el('li', { class: h.review ? 'is-review' : '' }, el('span', {}, h.name.replace(/^\/Users\/[^/]+/, '~')), el('small', {}, h.size ? bytes(h.size) : h.detail || ''))
            )
          )
        : null
    ),
    el('span', { class: 'report-task-size' }, sizeOrNothing(line.size)),
    line.act ? el('button', { class: 'row-act', onclick: line.act.run }, line.act.label) : el('span')
  );
}

function duration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/* ---------- live updates ---------- */

window.mole.schedule.onChange((snap) => {
  const wasRunning = !!sched?.running;
  sched = snap;
  // a checkup that finishes while you're looking opens its report
  if (wasRunning && !snap.running && $('#view-schedule').classList.contains('is-active') && snap.reports[0]) {
    openReport = snap.reports[0].id;
    schedFresh.add(snap.reports[0].id);
    window.mole.schedule.read([snap.reports[0].id]);
  }
  renderSchedule();
});

// keep "in 3 hours" honest without re-rendering every second
setInterval(() => sched && !popFor && $('#view-schedule').classList.contains('is-active') && renderSchedule(), 60_000);

window.mole.schedule.get().then((snap) => {
  sched = snap;
  renderBadge();
});
