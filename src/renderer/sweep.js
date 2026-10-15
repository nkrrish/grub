/* ---------- the big clean: every scan at once, one review, one run nobody has to watch ---------- */

// Each kind of thing Grub can clear, in one place. `tone` colours its slice of the bar and its dot.
const SWEEP_GROUPS = [
  { key: 'clean', title: 'Caches and logs', note: 'Apps rebuild these when they need them.', tone: 'var(--rot)' },
  { key: 'removed', title: 'Removed apps', note: 'Apps that are gone but left data behind.', tone: '#f2c46d' },
  { key: 'purge', title: 'Old build junk', note: 'From projects you haven’t touched lately. A build brings it back.', tone: '#8fb8ff' },
  { key: 'installers', title: 'Installers', note: 'Disk images and packages for apps you already installed.', tone: '#7fd6c2' },
  { key: 'ai', title: 'AI tools', note: 'Caches, old versions and sessions. Sessions don’t come back, so they start unticked.', tone: 'var(--nose)' },
];

const SWEEP_STEPS = [
  ['clean', 'Caches, logs and the Trash'],
  ['purge', 'Old build junk'],
  ['installers', 'Installers'],
  ['ai', 'AI tools and removed apps'],
];

// `touched` turns true once the person changes a tick, so Grub's own defaults never undo their choices
const sweep = { state: null, picked: new Set(), open: new Set(), more: new Set(), touched: false };

const sweepItems = (found) => ({
  clean: found.clean.flatMap((s) => s.items.map((i) => ({ ...i, sub: i.sub || s.name }))),
  removed: found.ai.filter((i) => i.group === 'gone'),
  purge: found.purge,
  installers: found.installers,
  ai: found.ai.filter((i) => i.group !== 'gone'),
});

const sweepAll = (found) => Object.values(sweepItems(found)).flat();
const sweepUsable = (i) => !i.blocked;
const sweepSum = (items) => items.reduce((n, i) => n + (i.size || 0), 0);

function sweepDefaults(found) {
  return new Set(sweepAll(found).filter((i) => i.on && sweepUsable(i)).map((i) => i.id));
}

function sweepApply(s) {
  const fresh = s.found && s.at !== sweep.state?.at;
  sweep.state = s;
  // a new scan, or one the person hasn't changed yet, starts from Grub's defaults
  if (s.found && (fresh || !sweep.touched)) {
    sweep.picked = sweepDefaults(s.found);
    if (fresh) {
      sweep.touched = false;
      unsettle('view-sweep'); // a new scan's list slides in once
    }
  }
  sweepCard();
  if ($('#view-sweep').classList.contains('is-active')) sweepRender();
}

// One stacked bar: each kind's share of what's picked, in its own colour. Given everything found (`of`),
// the part left unticked shows as a faint remainder, so "1.6 GB of 7.7 GB" reads at a glance.
function sweepBarChart(parts, total, of = total) {
  const rest = Math.max(0, of - total);
  return el(
    'div',
    { class: 'sweep-stack', role: 'img', 'aria-label': `${parts.map((p) => `${p.title} ${bytes(p.bytes)}`).join(', ')}${rest ? `, ${bytes(rest)} left unticked` : ''}` },
    ...parts.map((p) => el('i', { style: `--w:${(p.bytes / of) * 100}%;--tone:${p.tone}`, title: `${p.title} · ${bytes(p.bytes)}` })),
    rest ? el('i', { class: 'is-rest', style: `--w:${(rest / of) * 100}%`, title: `${bytes(rest)} left unticked` }) : null
  );
}

function sweepLegend(parts) {
  return el(
    'div',
    { class: 'sweep-legend' },
    ...parts.map((p) => el('span', {}, el('i', { style: `--tone:${p.tone}` }), `${p.title} `, el('b', {}, bytes(p.bytes))))
  );
}

function sweepParts(found, picked) {
  const all = sweepItems(found);
  return SWEEP_GROUPS.map((g) => ({ ...g, bytes: sweepSum(all[g.key].filter((i) => picked.has(i.id) && sweepUsable(i))) })).filter((p) => p.bytes > 0);
}

/* ----- the dashboard card ----- */

function sweepCard() {
  const s = sweep.state;
  const card = $('#sweep-card');
  if (!s) return;
  const step = s.step;
  let title;
  let note;
  let action = null;
  let progress = null;
  let parts = [];
  if (s.phase === 'scanning') {
    title = 'Looking around your Mac…';
    note = `${step.label} · ${step.index + 1} of ${step.of}`;
    progress = (step.index + 0.5) / step.of;
  } else if (s.phase === 'running') {
    title = 'Cleaning on its own…';
    note = `${step.label} · ${step.index + 1} of ${step.of}. You can close the window; Grub will tell you when it’s done.`;
    progress = (step.index + 0.5) / step.of;
  } else if (s.phase === 'done' && s.result) {
    title = s.result.stopped ? 'Stopped partway.' : s.result.freed > 0 ? `Cleared ${bytes(s.result.freed)}.` : 'All done.';
    note = 'Grub looks again whenever you like.';
    action = { label: 'Look again', run: sweepScan };
  } else if (s.found) {
    parts = sweepParts(s.found, sweepDefaults(s.found));
    const total = parts.reduce((n, p) => n + p.bytes, 0);
    title = total > 0 ? `Grub found ${bytes(total)} to clear.` : 'Nothing worth clearing right now.';
    note = `Checked ${ago(s.at)}.`;
    action = total > 0 ? { label: 'Review and clean', run: sweepOpen, primary: true } : { label: 'Look again', run: sweepScan };
  } else {
    title = 'See what Grub can clear.';
    note = 'One look through caches, removed apps, build junk, installers and AI tools. Nothing goes until you say so.';
    action = { label: 'Look around', run: sweepScan, primary: true };
  }
  const total = parts.reduce((n, p) => n + p.bytes, 0);
  card.replaceChildren(
    el(
      'div',
      { class: 'sweep-card-text' },
      el('span', { class: 'card-title' }, 'Space to win back'),
      el('h2', { class: 'sweep-card-title' }, title),
      el('p', { class: 'note' }, note),
      ...(parts.length ? [sweepBarChart(parts, total), sweepLegend(parts)] : []),
      progress != null ? el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `--v:${progress}` })) : null
    ),
    // replaceChildren would write a missing button out as the word "null"
    ...(action ? [el('button', { class: `btn ${action.primary ? 'btn-primary' : 'btn-quiet'}`, onclick: action.run }, action.label)] : [])
  );
}

async function sweepScan() {
  const s = await window.mole.sweep.scan();
  if (s.busy) ask({ title: 'Grub is busy', body: 'Another chore is running. Try again when it’s finished.', buttons: [{ label: 'OK', value: 'ok', primary: true }] });
}

function sweepOpen() {
  // older than an hour is worth a fresh look before anything goes
  if (!sweep.state?.found || isStale(sweep.state.at, HOUR)) sweepScan();
  show('sweep');
}

/* ----- the review ----- */

// While Grub looks, each place shows as done, going, or still to come. While it cleans, the step it's on.
function sweepSteps(s) {
  const at = s.step?.index ?? 0;
  if (s.phase === 'running') return el('p', { class: 'sweep-step-now' }, `${s.step.label} · step ${at + 1} of ${s.step.of}`);
  return el(
    'ol',
    { class: 'sweep-steps' },
    ...SWEEP_STEPS.map(([, label], i) =>
      el('li', { class: i < at ? 'is-done' : i === at ? 'is-now' : '' }, el('span', { class: 'sweep-step-dot', 'aria-hidden': 'true' }), el('span', {}, label))
    )
  );
}

function sweepRender() {
  const s = sweep.state;
  const body = $('#sweep-body');
  if (!s) return;
  if (s.phase !== 'done') delete body.dataset.result;
  if (s.phase === 'scanning' || s.phase === 'running') {
    $('#sweep-title').textContent = s.phase === 'scanning' ? 'Looking around your Mac…' : 'Cleaning on its own…';
    body.replaceChildren(el('div', { class: 'sweep-working' }, digging(s.phase === 'scanning' ? 'Sniffing every corner…' : 'Chomping through the list…'), sweepSteps(s)));
    return sweepBar();
  }
  if (s.phase === 'done' && s.result) {
    $('#sweep-title').textContent = s.result.freed > 0 ? `Cleared ${bytes(s.result.freed)}.` : 'All done.';
    const names = { clean: 'Caches and logs', purge: 'Old build junk', installers: 'Installers', ai: 'AI tools and removed apps' };
    // drawn once per result, so coming back to the page doesn't replay the count
    if (body.dataset.result === String(s.result.at)) return sweepBar();
    body.dataset.result = String(s.result.at);
    const steps = s.result.steps;
    const trashed = steps.some((st) => (st.key === 'installers' || st.key === 'ai') && st.bytes);
    const card = {
      amount: s.result.freed || steps.reduce((n, st) => n + (st.bytes || 0), 0),
      verb: 'cleared',
      disk: s.result.disk,
      rows: steps.map((st) => ({ name: names[st.key], sub: st.ok ? 'Done' : st.error || (st.failed ? `${st.failed} left alone` : 'Didn’t finish'), size: st.bytes })),
      note: trashed ? 'Installers and AI tool files are in the Trash, so you can put them back. Their space comes back once you empty the Trash.' : '',
      empty: 'Nothing to clear. Your Mac was already tidy.',
    };
    body.replaceChildren(payoff(card));
    // only a run that just finished pops; opening the page later just shows the result
    if (!s.result.stopped && card.amount > 0 && Date.now() - s.result.at < 60000) celebrate({ title: $('#sweep-title').textContent, ...card });
    return sweepBar();
  }
  if (!s.found) {
    $('#sweep-title').textContent = 'See what Grub can clear.';
    body.replaceChildren(el('div', { class: 'empty' }, 'Nothing looked at yet.'));
    return sweepBar();
  }

  const all = sweepItems(s.found);
  const parts = sweepParts(s.found, sweep.picked);
  const total = parts.reduce((n, p) => n + p.bytes, 0);
  const found = sweepSum(sweepAll(s.found));
  $('#sweep-title').textContent = found > 0 ? `Grub found ${bytes(found)} to clear.` : 'Nothing worth clearing right now.';
  const groups = SWEEP_GROUPS.filter((g) => all[g.key].length);
  body.replaceChildren(
    el(
      'section',
      { class: 'sweep-summary', 'aria-live': 'polite' },
      el('div', { class: 'sweep-summary-head' }, el('span', { class: 'sweep-summary-amount' }, bytes(total)), el('span', { class: 'sweep-summary-verb' }, total ? `picked to clear, of ${bytes(found)} found` : 'nothing picked yet')),
      found ? sweepBarChart(parts, total, found) : el('div', { class: 'sweep-stack is-empty' }),
      parts.length ? sweepLegend(parts) : null,
      el('p', { class: 'sweep-summary-note' }, `Checked ${ago(s.at)}. Everything is ticked except what doesn’t come back. Untick anything you want to keep.`)
    ),
    ...groups.map((g) => sweepGroup(g, all[g.key])),
    ...(s.found.errors && Object.keys(s.found.errors).length
      ? [el('p', { class: 'note' }, `Grub couldn’t finish looking at: ${Object.keys(s.found.errors).map((k) => SWEEP_STEPS.find(([x]) => x === k)?.[1] || k).join(', ')}.`)]
      : [])
  );
  sweepBar();
}

function sweepToggle(ids, on) {
  sweep.touched = true;
  ids.forEach((id) => (on ? sweep.picked.add(id) : sweep.picked.delete(id)));
  sweepRender();
}

// One card per kind: colour dot, tick for the lot, size and count, opened in place to pick one by one.
function sweepGroup(g, rows) {
  const open = sweep.open.has(g.key);
  const usable = rows.filter(sweepUsable);
  const on = usable.filter((r) => sweep.picked.has(r.id));
  const state = usable.length && on.length === usable.length ? 'true' : on.length ? 'mixed' : 'false';
  const head = el(
    'button',
    {
      class: 'sweep-group-tick',
      role: 'checkbox',
      'aria-checked': state,
      ...(usable.length ? {} : { disabled: '' }), // el() would turn a null into disabled="null"
      onclick: () => sweepToggle(usable.map((r) => r.id), state !== 'true'),
    },
    el('span', { class: 'pick-box', 'aria-hidden': 'true', 'aria-checked': state }),
    el('span', { class: 'sweep-dot', style: `--tone:${g.tone}`, 'aria-hidden': 'true' }),
    el(
      'span',
      { class: 'sweep-group-text' },
      el('b', {}, g.title),
      el('small', {}, `${on.length === rows.length ? rows.length : `${on.length} of ${rows.length}`} ${rows.length === 1 ? 'item' : 'items'} · ${g.note}`)
    ),
    el('span', { class: 'sweep-group-size' }, bytes(sweepSum(rows)))
  );
  const toggle = el(
    'button',
    {
      class: 'ai-fold-toggle',
      'aria-expanded': String(open),
      'aria-label': open ? `Hide ${g.title}` : `Show each of ${g.title}`,
      title: open ? 'Hide' : 'Show each one',
      onclick: () => {
        sweep.open.has(g.key) ? sweep.open.delete(g.key) : sweep.open.add(g.key);
        sweepRender();
      },
    },
    icon('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>')
  );
  return el('div', { class: 'ai-fold sweep-group' + (open ? ' is-open' : '') }, el('div', { class: 'ai-fold-head' }, head, toggle), open ? sweepList(g.key, rows) : null);
}

const SWEEP_PAGE = 40;

function sweepList(key, rows) {
  const sorted = rows.slice().sort((a, b) => (b.size || 0) - (a.size || 0));
  const all = sweep.more.has(key);
  const shown = all ? sorted : sorted.slice(0, SWEEP_PAGE);
  return el(
    'div',
    { class: 'list pick-list ai-list' },
    ...shown.map((r) => {
      const on = sweep.picked.has(r.id);
      const sub = [r.sub, r.blocked].filter(Boolean).join(' · ');
      const attrs = {
        class: `row pick-row${r.blocked ? ' is-blocked' : ''}`,
        role: 'checkbox',
        'aria-checked': String(on),
        title: r.path || r.name,
        onclick: () => !r.blocked && sweepToggle([r.id], !on),
      };
      if (r.blocked) attrs['aria-disabled'] = 'true';
      return el(
        'button',
        attrs,
        el('span', { class: 'pick-box', 'aria-hidden': 'true', 'aria-checked': String(on) }),
        el('div', { class: 'row-name' }, r.name, sub ? el('span', { class: 'row-sub' }, sub) : null),
        el('div', { class: 'row-size' }, r.size ? bytes(r.size) : '')
      );
    }),
    ...(sorted.length > shown.length
      ? [
          el(
            'button',
            {
              class: 'sweep-more',
              onclick: () => {
                sweep.more.add(key);
                sweepRender();
              },
            },
            `Show ${sorted.length - shown.length} more`
          ),
        ]
      : [])
  );
}

function sweepPicked() {
  if (!sweep.state?.found) return [];
  return sweepAll(sweep.state.found).filter((i) => sweep.picked.has(i.id) && sweepUsable(i));
}

function sweepBar() {
  const s = sweep.state;
  const go = $('#sweep-go');
  const busy = s?.phase === 'scanning' || s?.phase === 'running';
  if (busy) {
    go.textContent = 'Stop';
    go.disabled = false;
    go.classList.replace('btn-primary', 'btn-quiet');
    $('#sweep-bar-note').textContent = s.phase === 'running' ? 'Running on its own. You can close the window.' : 'Nothing is removed until you say so.';
    return;
  }
  go.classList.replace('btn-quiet', 'btn-primary');
  if (s?.phase === 'done' || !s?.found) {
    go.textContent = 'Look again';
    go.disabled = false;
    $('#sweep-bar-note').textContent = '';
    return;
  }
  const picked = sweepPicked();
  go.disabled = !picked.length;
  go.textContent = picked.length ? `Clean ${bytes(sweepSum(picked))}` : 'Pick something';
  $('#sweep-bar-note').textContent = picked.length ? `${picked.length} ${picked.length === 1 ? 'thing' : 'things'}, one go, start to finish. No passwords, nothing to watch.` : '';
}

$('#sweep-go').addEventListener('click', () => {
  const s = sweep.state;
  if (s?.phase === 'scanning' || s?.phase === 'running') return window.mole.sweep.cancel();
  if (s?.phase === 'done' || !s?.found) return sweepScan();
  const picked = sweepPicked();
  if (!picked.length) return;
  const ids = new Set(picked.map((i) => i.id));
  const all = sweepItems(s.found);
  const groups = SWEEP_GROUPS.filter((g) => all[g.key].some((i) => ids.has(i.id))).map((g) => g.title.toLowerCase());
  confirmRun(
    `Grub will clear about ${bytes(sweepSum(picked))} from ${groups.join(', ').replace(/, ([^,]*)$/, ' and $1')}, then let you know. Installers, removed apps and AI tool files go to the Trash.`,
    'Clean it all',
    async () => {
      const r = await window.mole.sweep.run(picked.map((i) => i.id));
      if (r.busy) ask({ title: 'Grub is busy', body: 'Another chore is running. Try again when it’s finished.', buttons: [{ label: 'OK', value: 'ok', primary: true }] });
    }
  );
});

window.mole.sweep.onChange(sweepApply);
window.mole.sweep.get().then(sweepApply);
