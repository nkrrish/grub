const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SECTIONS = [
  ['cpu', 'CPU', 'How hard your Mac is thinking'],
  ['memory', 'Memory', 'How full the short-term memory is'],
  ['disk', 'Disk', 'Free space left'],
  ['network', 'Network', 'Download and upload speed'],
  ['gpu', 'Graphics', 'The graphics chip'],
  ['heat', 'Heat & fan', 'Temperature, fan and power use'],
  ['battery', 'Battery', 'Charge, health and charger'],
  ['gadgets', 'Gadgets', 'Bluetooth devices and their batteries'],
  ['actions', 'Quick chores', 'Tidy up, sniff for junk, disk map'],
  ['apps', 'Hungriest apps', 'What’s using your Mac the most'],
];

// What can sit next to the icon, in menu bar order.
const BAR_ITEMS = [
  ['disk', 'Free disk', 'Space left, like 14G'],
  ['cpu', 'CPU', 'How busy it is, like 32%'],
  ['memory', 'Memory', 'How full it is, like 71%'],
];

let settings = { menuSections: SECTIONS.map(([k]) => k), menuBarItems: ['disk'], menuBarIcon: true };
const cpuHistory = [];
const netHistory = [];
const icons = new Map();

function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), units.length - 1);
  const v = n / 1000 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids.filter((k) => k != null));
  return node;
}

const headline = Vitals.headliner(); // same line as the window's Status page

function text(id, value) {
  $(id).textContent = value;
}

function bar(id, v, hot) {
  const node = $(id);
  node.style.setProperty('--v', Math.max(0, Math.min(1, v)));
  if (hot !== undefined) node.classList.toggle('is-hot', hot);
}

function push(list, v) {
  list.push(v);
  if (list.length > 16) list.shift();
}

// Bars scaled to `max`, or to the busiest moment in view.
function spark(id, values, max) {
  const node = $(id);
  const top = max || Math.max(...values, 0.001);
  if (node.children.length !== 16) node.replaceChildren(...Array.from({ length: 16 }, () => el('i')));
  const pad = 16 - values.length;
  [...node.children].forEach((b, i) => b.style.setProperty('--v', i < pad ? 0 : Math.max(0.06, values[i - pad] / top)));
}

function render(s) {
  const score = s.health_score ?? 0;
  const badge = $('#t-score');
  badge.textContent = score;
  badge.classList.toggle('is-meh', score < 70 && score >= 50);
  badge.classList.toggle('is-bad', score < 50);
  text('#t-title', headline(s));
  text('#t-sub', Vitals.sentence(s.health_score_msg) || s.hardware?.model || '');

  const cpu = s.cpu?.usage ?? 0;
  const heat = Vitals.heat(s);
  text('#t-cpu', cpu.toFixed(0));
  text('#t-cpu-chip', heat.cpuTemp != null ? `${heat.cpuTemp}°C` : '');
  push(cpuHistory, cpu);
  spark('#t-cpu-spark', cpuHistory, 100);
  text('#t-cpu-note', Vitals.cpuWord(cpu));

  const mem = s.memory || {};
  text('#t-mem', (mem.used_percent ?? 0).toFixed(0));
  text('#t-mem-chip', mem.total ? bytes(mem.total) : '');
  bar('#t-mem-bar', (mem.used_percent ?? 0) / 100);
  text('#t-mem-note', `${bytes(mem.used)} used`);

  const disk = (s.disks || []).find((d) => d.mount === '/');
  if (disk) {
    const [num, unit] = bytes(disk.total - disk.used).split(' ');
    text('#t-disk', num);
    text('#t-disk-unit', `${unit} free`);
    text('#t-disk-chip', bytes(disk.total));
    bar('#t-disk-bar', disk.used_percent / 100, disk.used_percent >= 90);
    text('#t-disk-note', `${Math.round(disk.used_percent)}% full`);
  }

  const net = Vitals.network(s);
  const down = Vitals.speed(net.down);
  const up = Vitals.speed(net.up);
  text('#t-net', down.value);
  text('#t-net-unit', down.unit);
  text('#t-net-chip', net.vpn ? 'VPN on' : '');
  push(netHistory, net.down + net.up);
  spark('#t-net-spark', netHistory);
  text('#t-net-note', net.online ? `↑ ${up.value} ${up.unit} up` : 'Offline');

  const g = Vitals.gpu(s);
  text('#t-gpu', g ? (g.usage ?? g.cores) : '--');
  text('#t-gpu-unit', g ? (g.usage != null ? '%' : 'cores') : '');
  text('#t-gpu-chip', g?.usage != null ? `${g.cores} cores` : '');
  text('#t-gpu-note', !g ? 'None found' : g.usage == null ? 'Won’t say how busy' : g.usage < 20 ? 'Idle' : 'Drawing hard');

  text('#t-heat', heat.cpuTemp ?? heat.fan ?? heat.power ?? '--');
  text('#t-heat-unit', heat.cpuTemp != null ? '°C' : heat.fan != null ? 'RPM' : heat.power != null ? 'W used' : '');
  text('#t-heat-chip', heat.cpuTemp != null && heat.power != null ? `${heat.power} W` : '');
  text('#t-heat-note', `Fan: ${heat.fanLabel}`);

  const bat = Vitals.battery(s);
  text('#t-bat', bat ? bat.pct : '--');
  text('#t-bat-state', bat ? `% · ${bat.state}` : '');
  text('#t-bat-chip', bat?.health ? `Health ${bat.health.toLowerCase()}` : '');
  text(
    '#t-bat-note',
    bat
      ? [bat.detail, `holds ${bat.capacity}% of when new`, bat.charger && `${bat.charger} W charger`].filter(Boolean).join(' · ')
      : 'No battery. Plugged into the earth.'
  );

  renderProcs(s);
  renderGadgets(s);
  fit();
}

const GENERIC = '<svg class="proc-icon is-system" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 9h18"/></svg>';

function procIcon(app) {
  if (!app) return document.createRange().createContextualFragment(GENERIC).firstChild;
  const img = el('img', { class: 'proc-icon', alt: '', width: 18, height: 18 });
  if (!icons.has(app)) icons.set(app, window.mole.appIcon(app));
  icons.get(app).then((url) => url && (img.src = url));
  return img;
}

// Rows are reused across updates; only an icon whose app changed is swapped, so nothing blinks.
function renderProcs(s) {
  const list = Vitals.apps(s);
  const box = $('#t-procs');
  while (box.children.length > list.length) box.lastChild.remove();
  while (box.children.length < list.length) {
    const row = el('div', { class: 'proc' }, el('i'), el('span', { class: 'proc-name' }), el('span', { class: 'proc-num' }), el('span', { class: 'proc-num' }));
    row.append(ProcMenu.button(() => row.proc));
    box.append(row);
  }
  list.forEach((p, i) => {
    const row = box.children[i];
    row.proc = p;
    if (row.dataset.app !== String(p.app)) {
      row.dataset.app = String(p.app);
      row.firstChild.replaceWith(procIcon(p.app));
    }
    row.children[1].textContent = p.label;
    row.children[2].textContent = bytes(p.mem);
    row.children[3].textContent = `${p.cpu.toFixed(0)}%`;
    row.children[3].classList.toggle('is-hot', p.cpu >= 50);
  });
}

function renderGadgets(s) {
  const { connected, paired } = Vitals.gadgets(s);
  text('#t-bt-chip', paired ? `${paired} paired` : '');
  $('#t-gadgets').replaceChildren(
    ...(connected.length
      ? connected.map((d) => el('div', { class: 'gadget' }, el('span', {}, d.name), el('em', {}, d.battery != null ? `${d.battery}%` : '')))
      : [el('p', {}, 'Nothing connected right now.')])
  );
}

/* ---------- which sections show ---------- */

function applySections() {
  const on = new Set(settings.menuSections);
  $$('[data-section]').forEach((node) => (node.hidden = !on.has(node.dataset.section)));
  // an odd tile out stretches across, so the grid never has a hole
  const tiles = $$('.tile:not([hidden])');
  tiles.forEach((t, i) => t.classList.toggle('is-wide', tiles.length % 2 === 1 && i === tiles.length - 1));
  $('.tiles').hidden = !tiles.length;
  const bar = new Set(settings.menuBarItems || []);
  $$('#cust-bar [data-bar]').forEach((b) => b.setAttribute('aria-checked', String(bar.has(b.dataset.bar))));
  // the icon can't go while nothing else is in the menu bar, or Grub would have nowhere to click
  const iconLocked = !bar.size;
  const icon = $('#cust-icon');
  icon.setAttribute('aria-checked', String(settings.menuBarIcon !== false || iconLocked));
  icon.setAttribute('aria-disabled', String(iconLocked));
  icon.querySelector('small').textContent = iconLocked ? 'Turn on a number below to hide it' : 'The little grub';
  $$('#cust-list [data-key]').forEach((b) => b.setAttribute('aria-checked', String(on.has(b.dataset.key))));
  fit();
}

$('#cust-list').replaceChildren(
  ...SECTIONS.map(([key, label, hint]) =>
    el('button', { class: 'cust-row', role: 'switch', 'aria-checked': 'true', 'data-key': key }, el('span', {}, el('b', {}, label), el('small', {}, hint)), el('i', { class: 'switch', 'aria-hidden': 'true' }))
  )
);

$('#cust-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-key]');
  if (!row) return;
  const on = new Set(settings.menuSections);
  on.has(row.dataset.key) ? on.delete(row.dataset.key) : on.add(row.dataset.key);
  // keep the fixed order, whatever order things were ticked in
  settings = await window.mole.settings.set({ menuSections: SECTIONS.map(([k]) => k).filter((k) => on.has(k)) });
  applySections();
});

$('#cust-bar').replaceChildren(
  el('button', { class: 'cust-row', role: 'switch', 'aria-checked': 'true', id: 'cust-icon' }, el('span', {}, el('b', {}, 'Grub icon'), el('small', {}, 'The little grub')), el('i', { class: 'switch', 'aria-hidden': 'true' })),
  ...BAR_ITEMS.map(([key, label, hint]) =>
    el('button', { class: 'cust-row', role: 'switch', 'aria-checked': 'false', 'data-bar': key }, el('span', {}, el('b', {}, label), el('small', {}, hint)), el('i', { class: 'switch', 'aria-hidden': 'true' }))
  )
);

$('#cust-bar').addEventListener('click', async (e) => {
  if (e.target.closest('#cust-icon')) {
    if ($('#cust-icon').getAttribute('aria-disabled') === 'true') return;
    settings = await window.mole.settings.set({ menuBarIcon: settings.menuBarIcon === false });
    return applySections();
  }
  const row = e.target.closest('[data-bar]');
  if (!row) return;
  const on = new Set(settings.menuBarItems || []);
  on.has(row.dataset.bar) ? on.delete(row.dataset.bar) : on.add(row.dataset.bar);
  settings = await window.mole.settings.set({ menuBarItems: BAR_ITEMS.map(([k]) => k).filter((k) => on.has(k)) });
  applySections();
});

function customize(open) {
  $('#customize').hidden = !open;
  $('#vitals').hidden = open;
  $('#t-customize').setAttribute('aria-pressed', String(open));
  applySections();
}

$('#t-customize').addEventListener('click', () => customize($('#customize').hidden));
$('#cust-done').addEventListener('click', () => customize(false));

// The window is as tall as what's shown; main caps it at the screen height.
let lastHeight = 0;
function fit() {
  const h = $('.pop').offsetHeight;
  if (h === lastHeight) return;
  lastHeight = h;
  window.mole.popoverHeight(h);
}

window.mole.settings.get().then((s) => {
  settings = { ...settings, ...s };
  applySections();
});
window.mole.settings.onChange((s) => {
  settings = { ...settings, ...s };
  applySections();
});

window.mole.onStatus(render);
window.mole.lastStatus().then((s) => s && render(s));

document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => window.mole.app.open(b.dataset.open)));
document.querySelectorAll('[data-run]').forEach((b) =>
  b.addEventListener('click', () => {
    const run = b.dataset.run;
    window.mole.app.run(run === 'tidy' ? { tool: 'tidy', confirm: true } : { command: 'clean', dryRun: true });
  })
);
$('#t-quit').addEventListener('click', () => window.mole.app.quit());
