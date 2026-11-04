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

const st = { loaded: false, at: 0, data: null, busy: new Set() };

function storageOpen() {
  if (!othersLoaded) loadOthers(false);
  if (!st.loaded || isStale(st.at, TTL.disk)) storageLoad(st.loaded);
  else setFreshness('storage-fresh', st.at);
}

async function storageLoad(fresh) {
  st.loaded = true;
  setFreshness('storage-fresh', st.at, true);
  if (!st.data) $('#storage-body').replaceChildren(digging('Adding up your whole disk. This takes a minute or two…'));
  const res = await window.mole.storage.get(!!fresh);
  if (!res.ok) {
    setFreshness('storage-fresh', st.at);
    if (!st.data) $('#storage-body').replaceChildren(el('div', { class: 'empty' }, 'Grub couldn’t add it up: ' + (res.error || 'unknown problem')));
    else toast('Grub couldn’t measure again: ' + (res.error || 'unknown problem'));
    return;
  }
  st.data = res.data;
  st.at = res.at;
  setFreshness('storage-fresh', st.at);
  storageRender();
}

$('#storage-refresh').addEventListener('click', () => storageLoad(true));

async function storageDeeper(btn) {
  btn.disabled = true;
  btn.textContent = 'Measuring…';
  await loadOthers(true);
  btn.disabled = false;
  btn.textContent = 'Look deeper';
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

function storageRow(s) {
  return el(
    'div',
    { class: 'other ledger-row' },
    el(
      'div',
      { class: 'other-top' },
      el('span', { class: `ledger-dot ledger-${s.key}`, 'aria-hidden': 'true' }),
      el('div', { class: 'other-name' }, el('b', {}, s.name), el('span', { class: 'row-sub' }, s.sub)),
      s.key === 'unseen' ? el('button', { class: 'row-act', onclick: (e) => storageDeeper(e.currentTarget) }, 'Look deeper') : null,
      el('div', { class: 'other-size' }, bytes(s.size))
    ),
    s.parts?.length ? el('div', { class: 'other-folders ledger-parts' }, ...s.parts.map((p) => el('span', { class: 'chip' }, `${p.name} · ${bytes(p.size)}`))) : null
  );
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
  $('#storage-body').replaceChildren(
    el(
      'div',
      { class: 'ledger-bar', role: 'img', 'aria-label': slices.map((s) => `${s.name} ${bytes(s.size)}`).join(', ') },
      ...slices.map((s) => el('span', { class: `ledger-${s.key}`, style: `flex-grow:${s.size}`, title: `${s.name} · ${bytes(s.size)}` }))
    ),
    el('div', { class: 'others-list' }, ...slices.map(storageRow)),
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
