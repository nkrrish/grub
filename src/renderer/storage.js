/* ---------- Storage: every byte in use added up, with what macOS calls System Data given names ---------- */

const ST_GROUPS = [
  { key: 'clear', title: 'Safe to clear', note: 'Apple doesn’t publish what System Data holds, so which row these land in is Grub’s best match. The sizes are real.' },
  { key: 'review', title: 'Check before clearing', note: 'These hold things you may want. Grub shows you where they are and leaves the choice to you.' },
  { key: 'keep', title: 'Leave these alone', note: 'They take up space, but your Mac needs them. Grub won’t offer to remove them.' },
];
const ST_CONFIRM = {
  runtime: (i) => `${i.name} goes for good. Projects that need it can’t run there until Xcode downloads it again.`,
  'sim-cache': () => 'Your next simulator start will be slower while macOS rebuilds these. macOS will ask for your password.',
  snapshots: () => 'You lose these restore points. Backups on your backup disk stay. macOS will ask for your password.',
  temp: (i) => `${i.name} goes to the Trash. The space comes back when you empty it.`,
};

const st = { loaded: false, at: 0, data: null, busy: new Set(), deep: { busy: false, error: '' }, pick: null, fullDisk: true };

function storageOpen() {
  if (!othersLoaded) loadOthers(false);
  if (!st.loaded || isStale(st.at, TTL.disk)) storageLoad(st.loaded);
  else setFreshness('storage-fresh', st.at);
}

async function storageLoad(fresh) {
  st.loaded = true;
  setFreshness('storage-fresh', st.at, true);
  // a quiet line, not a full-page wait: the folder map below doesn't depend on this and shows straight away
  // the empty bar holds its place, so the map doesn't jump when the real one arrives
  if (!st.data)
    $('#storage-top').replaceChildren(el('div', { class: 'ledger-bar ledger-free' }), el('div', { class: 'ledger-peek' }, 'Adding up your whole disk. This takes a minute or two…'));
  const res = await window.mole.storage.get(!!fresh);
  if (!res.ok) {
    setFreshness('storage-fresh', st.at);
    if (!st.data) $('#storage-top').replaceChildren(el('div', { class: 'ledger-peek storage-blocked' }, 'Grub couldn’t add it up: ' + (res.error || 'unknown problem')));
    else toast('Grub couldn’t measure again: ' + (res.error || 'unknown problem'));
    return;
  }
  st.data = res.data;
  st.at = res.at;
  st.fullDisk = (await window.mole.perms.check()).fullDisk;
  setFreshness('storage-fresh', st.at);
  storageRender();
}

$('#storage-refresh').addEventListener('click', () => storageLoad(true));

// One run at a time, and whatever happens is said right beside the button that started it.
async function storageDeeper() {
  if (st.deep.busy) return;
  st.deep = { busy: true, error: '' };
  if (st.data) storageRender();
  const res = await loadOthers(true);
  st.deep = { busy: false, error: res.error ? String(res.error).slice(0, 220) : '' };
  if (res.error && !st.data) toast('Grub couldn’t measure: ' + st.deep.error);
  if (st.data) storageRender();
}

// Biggest first, so a large unseen share is near the top with its button; free space always ends the bar.
function storageSlices(d) {
  const used = [
    ...d.groups.map((g) => ({ key: g.key, name: g.name, sub: g.sub, size: g.size, parts: g.parts })),
    { key: 'macos', name: 'macOS', sub: 'The system itself, recovery and swap.', size: d.system },
    { key: 'unseen', name: 'Grub can’t see this yet', sub: storageUnseenNote(d), size: d.unseen },
  ].sort((a, b) => b.size - a.size);
  return [...used, { key: 'free', name: 'Free', sub: 'Ready to use.', size: d.free }].filter((s) => s.size > 0);
}

function storageUnseenNote(d) {
  const who = d.closedAccounts.join(', ');
  if (who) return `Includes ${who}’s account and folders macOS keeps closed. In Settings, accounts show as Other Users & Shared and the rest as System Data.`;
  if (!d.looked) return 'Folders macOS keeps closed to your account. In Settings, these show as System Data.';
  return `Still closed after the admin look ${ago(d.lookedAt)}. macOS guards some folders even from admins, and Grub needs Full Disk Access to enter the rest.`;
}

function storageRowExtras(s) {
  if (s.key !== 'unseen') return null;
  const btn = el('button', { class: 'row-act', onclick: storageDeeper }, st.deep.busy ? 'Measuring…' : 'Look deeper');
  btn.disabled = st.deep.busy;
  return btn;
}

function storageRowNotes(s) {
  if (s.key !== 'unseen') return [];
  return [
    st.deep.busy ? el('span', { class: 'row-sub' }, 'This can take a few minutes. You can keep using Grub while it works.') : null,
    st.deep.error ? el('span', { class: 'row-sub storage-blocked', role: 'alert' }, `Grub couldn’t finish: ${st.deep.error}`) : null,
    !st.fullDisk
      ? el('span', { class: 'row-sub storage-blocked' }, 'Grub doesn’t have Full Disk Access, so it can’t see everything. ', el('button', { class: 'link-btn', onclick: () => window.mole.perms.open('fullDisk') }, 'Turn it on'))
      : null,
  ];
}

function storageRow(s) {
  return el(
    'div',
    {
      class: `other ledger-row${st.pick === s.key ? ' is-picked' : ''}`,
      'data-ledger': s.key,
      onmouseenter: () => storageLight(s.key),
      onmouseleave: () => storageLight(null),
    },
    el(
      'div',
      { class: 'other-top' },
      el('span', { class: `ledger-dot ledger-${s.key}`, 'aria-hidden': 'true' }),
      el('div', { class: 'other-name' }, el('b', {}, s.name), el('span', { class: 'row-sub' }, s.sub), ...storageRowNotes(s)),
      storageRowExtras(s),
      el('div', { class: 'other-size' }, bytes(s.size))
    ),
    s.parts?.length ? el('div', { class: 'other-folders ledger-parts' }, ...s.parts.map((p) => el('span', { class: 'chip' }, `${p.name} · ${bytes(p.size)}`))) : null
  );
}

/* The bar answers straight away: pointing says what a piece is, clicking jumps to its row. */

const ST_PEEK_HINT = 'Point at the bar to see what each part is. Click to jump to it.';

function storagePeek(s) {
  const peek = $('#ledger-peek');
  if (!peek) return;
  if (!s) return peek.replaceChildren(el('span', { class: 'ledger-peek-hint' }, ST_PEEK_HINT));
  const share = Math.max(1, Math.round((s.size / st.data.total) * 100));
  peek.replaceChildren(el('span', { class: `ledger-dot ledger-${s.key}`, 'aria-hidden': 'true' }), el('b', {}, s.name), ` ${bytes(s.size)} · ${share}% of your disk`);
}

function storageLight(key) {
  $$('.ledger-seg').forEach((b) => b.classList.toggle('is-lit', b.dataset.ledger === key));
}

function storagePick(key) {
  st.pick = key;
  $$('.ledger-row').forEach((r) => r.classList.toggle('is-picked', r.dataset.ledger === key));
  // your files have a whole map of their own, which says more than their row
  const target = key === 'home' ? $('#disk-folders') : $(`.ledger-row[data-ledger="${key}"]`);
  target?.scrollIntoView({ block: key === 'home' ? 'start' : 'center', behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' });
}

function storageSeg(s) {
  const peek = () => storagePeek(s);
  const clear = () => storagePeek(null);
  return el('button', {
    class: `ledger-seg ledger-${s.key}`,
    'data-ledger': s.key,
    style: `flex-grow:${s.size}`,
    'aria-label': `${s.name}, ${bytes(s.size)}`,
    onmouseenter: peek,
    onfocus: peek,
    onmouseleave: clear,
    onblur: clear,
    onclick: () => storagePick(s.key),
  });
}

async function storageClear(item) {
  const v = await ask({
    title: `Clear ${item.name}?`,
    body: ST_CONFIRM[item.kind](item),
    buttons: [
      { label: 'Keep it', value: 'cancel' },
      { label: 'Clear it', value: 'ok', primary: true },
    ],
  });
  if (v !== 'ok') return;
  st.busy.add(item.id);
  storageRender();
  const res = await window.mole.storage.clear(item.id);
  st.busy.delete(item.id);
  if (!res.ok) {
    storageRender();
    if (res.cancelled) return;
    return ask({ title: `Grub couldn’t clear ${item.name}`, body: res.error, buttons: [{ label: 'OK', value: 'ok', primary: true }] });
  }
  st.data.items = st.data.items.filter((i) => i.id !== item.id);
  toast(item.kind === 'temp' ? `${item.name} is in the Trash.` : `${item.name} cleared.`);
  storageRender();
  storageLoad(true);
}

function storageAction(item) {
  if (item.group === 'keep') return null;
  if (item.group === 'review') return el('button', { class: 'row-act', onclick: () => window.mole.reveal(item.path) }, 'Show');
  if (item.blocked) return null;
  const busy = st.busy.has(item.id);
  const btn = el('button', { class: 'row-act', onclick: () => storageClear(item) }, busy ? 'Clearing…' : 'Clear');
  btn.disabled = busy;
  return btn;
}

function storageItem(item) {
  const used = item.lastUsed ? `Last used ${ago(new Date(item.lastUsed).getTime())}. ` : '';
  return el(
    'div',
    { class: 'other' },
    el(
      'div',
      { class: 'other-top' },
      el(
        'div',
        { class: 'other-name' },
        el('b', {}, item.name),
        el('span', { class: 'row-sub' }, used + item.sub),
        item.blocked ? el('span', { class: 'row-sub storage-blocked' }, `Can’t clear now: ${item.blocked}.`) : null
      ),
      storageAction(item),
      item.bytes != null ? el('div', { class: 'other-size' }, bytes(item.bytes)) : null
    )
  );
}

function storageRender() {
  const d = st.data;
  const slices = storageSlices(d);
  const known = d.used - d.unseen;
  $('#storage-title').textContent = d.unseen >= 1e9 ? `Grub can name ${bytes(known)} of the ${bytes(d.used)} in use.` : `All ${bytes(d.used)} in use, accounted for.`;
  $('#storage-top').replaceChildren(
    el('div', { class: 'ledger-bar' }, ...slices.map(storageSeg)),
    el('div', { class: 'ledger-peek', id: 'ledger-peek', 'aria-live': 'polite' }, el('span', { class: 'ledger-peek-hint' }, ST_PEEK_HINT))
  );
  $('#storage-body').replaceChildren(
    el('section', { class: 'others' }, el('div', { class: 'others-head' }, el('h2', {}, 'The whole disk')), el('div', { class: 'others-list' }, ...slices.map(storageRow))),
    ...ST_GROUPS.map((g) => {
      const rows = d.items.filter((i) => i.group === g.key).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
      if (!rows.length) return null;
      return el(
        'section',
        { class: 'others' },
        el('div', { class: 'others-head' }, el('h2', {}, g.title), el('p', { class: 'others-lede' }, g.note)),
        el('div', { class: 'others-list' }, ...rows.map(storageItem))
      );
    }).filter(Boolean)
  );
}
