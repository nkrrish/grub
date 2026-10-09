/* ---------- the big clean: every scan at once, one review, one run nobody has to watch ---------- */

const SWEEP_GROUPS = [
  { key: 'clean', title: 'Caches, logs and the Trash', note: 'What Mole would clean. Apps rebuild these when they need them.' },
  { key: 'purge', title: 'Old build junk', note: 'Build folders from projects you haven’t touched lately. Running a project again rebuilds them.' },
  { key: 'installers', title: 'Installers', note: 'Disk images and packages from apps you already installed. Recent ones are left unticked.' },
  { key: 'ai', title: 'AI tools', note: 'Caches, old versions, update downloads and sessions. Sessions don’t come back, so they start unticked.' },
];

const sweep = { state: null, picked: new Set(), open: new Set() };

const sweepItems = (found) => ({
  clean: found.clean.flatMap((s) => s.items),
  purge: found.purge,
  installers: found.installers,
  ai: found.ai,
});

function sweepUsable(i) {
  return !i.blocked;
}

function sweepApply(s) {
  const fresh = s.found && s.at !== sweep.state?.at;
  sweep.state = s;
  // a new scan resets the ticks to Grub's defaults
  if (fresh) sweep.picked = new Set(Object.values(sweepItems(s.found)).flat().filter((i) => i.on && sweepUsable(i)).map((i) => i.id));
  sweepCard();
  if ($('#view-sweep').classList.contains('is-active')) sweepRender();
}

/* ----- the dashboard card ----- */

function sweepCard() {
  const s = sweep.state;
  const card = $('#sweep-card');
  if (!s) return;
  const t = s.totals;
  const step = s.step;
  let title;
  let note;
  let action = null;
  let progress = null;
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
  } else if (t && t.all > 0) {
    title = `Grub found ${bytes(t.all)} to clear.`;
    note = `Checked ${ago(s.at)}.`;
    action = { label: 'Review and clean', run: sweepOpen, primary: true };
  } else if (t) {
    title = 'Nothing worth clearing right now.';
    note = `Checked ${ago(s.at)}.`;
    action = { label: 'Look again', run: sweepScan };
  } else {
    title = 'See what Grub can clear.';
    note = 'One look through caches, build junk, installers and AI tools. Nothing is removed until you say so.';
    action = { label: 'Look around', run: sweepScan, primary: true };
  }

  const parts = t && s.phase === 'ready' ? SWEEP_GROUPS.filter((g) => t[g.key] > 0).map((g) => ({ ...g, bytes: t[g.key] })) : [];
  card.replaceChildren(
    el(
      'div',
      { class: 'sweep-card-text' },
      el('span', { class: 'card-title' }, 'Space to win back'),
      el('h2', { class: 'sweep-card-title' }, title),
      el('p', { class: 'note' }, note),
      parts.length
        ? el('div', { class: 'sweep-chips' }, ...parts.map((p) => el('span', { class: 'chip' }, `${p.title} · ${bytes(p.bytes)}`)))
        : null,
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

function sweepRender() {
  const s = sweep.state;
  const body = $('#sweep-body');
  if (!s) return;
  if (s.phase === 'scanning' || s.phase === 'running') {
    $('#sweep-title').textContent = s.phase === 'scanning' ? 'Looking around your Mac…' : 'Cleaning on its own…';
    body.replaceChildren(digging(`${s.step.label}…`));
    return sweepBar();
  }
  if (s.phase === 'done' && s.result) {
    $('#sweep-title').textContent = s.result.freed > 0 ? `Cleared ${bytes(s.result.freed)}.` : 'All done.';
    const names = Object.fromEntries(SWEEP_GROUPS.map((g) => [g.key, g.title]));
    body.replaceChildren(
      el(
        'div',
        { class: 'list sweep-result' },
        ...s.result.steps.map((st) =>
          el(
            'div',
            { class: 'row' },
            el('div', { class: 'row-name' }, names[st.key], el('span', { class: 'row-sub' }, st.ok ? 'Done' : st.error || (st.failed ? `${st.failed} left alone` : 'Didn’t finish'))),
            el('div', { class: 'row-size' }, st.bytes ? bytes(st.bytes) : '')
          )
        )
      ),
      el('p', { class: 'note' }, 'Installers and AI tool files are in the Trash if you want anything back.')
    );
    return sweepBar();
  }
  if (!s.found) {
    $('#sweep-title').textContent = 'See what Grub can clear.';
    body.replaceChildren(el('div', { class: 'empty' }, 'Nothing looked at yet.'));
    return sweepBar();
  }
  const all = sweepItems(s.found);
  $('#sweep-title').textContent = s.totals.all > 0 ? `Grub found ${bytes(s.totals.all)} to clear.` : 'Nothing worth clearing right now.';
  body.replaceChildren(
    ...SWEEP_GROUPS.map((g) => {
      if (!all[g.key].length) return null;
      // Mole's list comes in sections; each folds so a thousand paths don't bury the rest
      const parts = g.key === 'clean' ? s.found.clean.map((sec) => ({ key: `clean:${sec.name}`, label: sec.name, rows: sec.items })) : [{ key: g.key, label: g.title, rows: all[g.key] }];
      return el(
        'section',
        { class: 'ai-group' },
        el('h2', { class: 'section-title' }, g.title),
        el('p', { class: 'note ai-note' }, g.note),
        ...parts.map((p) => sweepFold(p))
      );
    }).filter(Boolean) // an empty group would print as "null"
  );
  sweepBar();
}

function sweepFold({ key, label, rows }) {
  const open = sweep.open.has(key);
  const usable = rows.filter(sweepUsable);
  const on = usable.filter((r) => sweep.picked.has(r.id));
  const state = usable.length && on.length === usable.length ? 'true' : on.length ? 'mixed' : 'false';
  const head = el(
    'button',
    {
      class: 'pick-all',
      role: 'checkbox',
      'aria-checked': state,
      onclick: () => {
        const target = state !== 'true';
        usable.forEach((r) => (target ? sweep.picked.add(r.id) : sweep.picked.delete(r.id)));
        sweepRender();
      },
    },
    el('span', { class: 'pick-box', 'aria-hidden': 'true', 'aria-checked': state }),
    el('b', {}, `${label} · ${rows.length} item${rows.length === 1 ? '' : 's'}`),
    el('span', { class: 'pick-all-count' }, bytes(rows.reduce((n, r) => n + (r.size || 0), 0)))
  );
  const toggle = el(
    'button',
    {
      class: 'btn-link ai-fold',
      'aria-expanded': String(open),
      onclick: () => {
        sweep.open.has(key) ? sweep.open.delete(key) : sweep.open.add(key);
        sweepRender();
      },
    },
    open ? 'Hide each one' : 'Show each one'
  );
  return el('div', { class: 'ai-part' }, head, toggle, open ? sweepList(rows) : null);
}

function sweepList(rows) {
  return el(
    'div',
    { class: 'list pick-list ai-list' },
    ...rows
      .slice()
      .sort((a, b) => (b.size || 0) - (a.size || 0))
      .map((r, i) => {
        const on = sweep.picked.has(r.id);
        const sub = [r.sub, r.blocked].filter(Boolean).join(' · ');
        const attrs = {
          class: `row pick-row${r.blocked ? ' is-blocked' : ''}`,
          role: 'checkbox',
          'aria-checked': String(on),
          style: `--i:${Math.min(i, 20)}`,
          title: r.path || r.name,
          onclick: () => {
            if (r.blocked) return;
            on ? sweep.picked.delete(r.id) : sweep.picked.add(r.id);
            sweepRender();
          },
        };
        if (r.blocked) attrs['aria-disabled'] = 'true';
        return el(
          'button',
          attrs,
          el('span', { class: 'pick-box', 'aria-hidden': 'true', 'aria-checked': String(on) }),
          el('div', { class: 'row-name' }, r.name, sub ? el('span', { class: 'row-sub' }, sub) : null),
          el('div', { class: 'row-size' }, r.size ? bytes(r.size) : '')
        );
      })
  );
}

function sweepPicked() {
  if (!sweep.state?.found) return [];
  return Object.values(sweepItems(sweep.state.found))
    .flat()
    .filter((i) => sweep.picked.has(i.id) && sweepUsable(i));
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
  go.textContent = picked.length ? `Clean ${bytes(picked.reduce((n, i) => n + (i.size || 0), 0))}` : 'Pick something';
  $('#sweep-bar-note').textContent = 'One go, start to finish. No passwords, nothing to watch.';
}

$('#sweep-go').addEventListener('click', () => {
  const s = sweep.state;
  if (s?.phase === 'scanning' || s?.phase === 'running') return window.mole.sweep.cancel();
  if (s?.phase === 'done' || !s?.found) return sweepScan();
  const picked = sweepPicked();
  if (!picked.length) return;
  const groups = SWEEP_GROUPS.filter((g) => picked.some((i) => i.id.startsWith(g.key === 'installers' ? 'installer:' : `${g.key}:`))).map((g) => g.title.toLowerCase());
  confirmRun(
    `Grub will clear about ${bytes(picked.reduce((n, i) => n + (i.size || 0), 0))} from ${groups.join(', ').replace(/, ([^,]*)$/, ' and $1')}, then let you know. Installers and AI tool files go to the Trash.`,
    'Clean it all',
    async () => {
      const r = await window.mole.sweep.run(picked.map((i) => i.id));
      if (r.busy) ask({ title: 'Grub is busy', body: 'Another chore is running. Try again when it’s finished.', buttons: [{ label: 'OK', value: 'ok', primary: true }] });
    }
  );
});

window.mole.sweep.onChange(sweepApply);
window.mole.sweep.get().then(sweepApply);
