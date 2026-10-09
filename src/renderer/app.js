const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Chromium shows focus rings after mouse clicks in Electron; keep them for keyboard use only.
addEventListener('pointerdown', () => document.documentElement.classList.add('by-pointer'), true);
addEventListener('keydown', (e) => e.key === 'Tab' && document.documentElement.classList.remove('by-pointer'), true);

const CHORES = {
  clean: {
    eyebrow: 'Clean',
    title: 'Your Mac has crumbs. Grub is hungry.',
    lede: 'Clears out caches, logs and temp files, plus scraps from apps you already deleted.',
    points: [
      'User and system caches, logs and temporary files',
      'Leftovers from apps that are already gone',
      'Anything you protect stays protected',
      'Sniff first to see what Grub would eat',
    ],
    chomp: 'Chomp the junk',
    confirm: 'Grub will clean caches, logs and leftovers. Things you protect stay protected.',
  },
  optimize: {
    eyebrow: 'Optimize',
    title: 'Fluff up the burrow.',
    lede: 'Refreshes system caches and services and fixes safe maintenance issues.',
    points: [
      'Rebuilds caches that tend to go stale',
      'Refreshes services that act up',
      'Some steps need your Mac password; Grub asks when it gets there',
    ],
    chomp: 'Freshen up',
    confirm: 'Grub will refresh caches and services. It may ask for your Mac password.',
  },
  purge: {
    eyebrow: 'Purge projects',
    title: 'Bury your old build junk.',
    lede: 'Finds node_modules, build folders and other artifacts in projects you no longer touch.',
    points: [
      'Scans your usual code folders for build artifacts',
      'node_modules, target, dist, .next and friends',
      'Running a project again just rebuilds them',
    ],
    chomp: 'Find build junk',
    picker: true,
  },
  installer: {
    eyebrow: 'Installers',
    title: 'Eat the boxes the apps came in.',
    lede: 'Finds .dmg and .pkg files you downloaded, installed and forgot about.',
    points: ['Looks in Downloads, Desktop and other usual spots', 'You choose which installers to remove'],
    chomp: 'Find installers',
    picker: true,
  },
};

/* ---------- helpers ---------- */

function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), units.length - 1);
  const v = n / 1000 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function parseSize(s) {
  const m = /([\d.]+)\s*([KMGT]?B)/i.exec(s || '');
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()];
  return parseFloat(m[1]) * mult;
}

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

const ICON_DIR = '<svg class="row-icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_FILE = '<svg class="row-icon" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
const ICON_APP = '<svg class="row-icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 9h18"/><circle cx="6.5" cy="7" r=".6"/></svg>';

function icon(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstChild;
}

// Shows the generic glyph first, then swaps in the real app icon once it scrolls into view.
const iconObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      iconObserver.unobserve(e.target);
      window.mole.appIcon(e.target.dataset.app).then((url) => {
        if (!url) return;
        const img = el('img', { class: 'row-app-icon', src: url, alt: '', width: 28, height: 28 });
        e.target.replaceChildren(img);
      });
    }
  },
  { rootMargin: '200px' }
);

function appIcon(path) {
  const slot = el('span', { class: 'row-icon-slot', 'data-app': path }, icon(ICON_APP));
  if (path?.endsWith('.app')) iconObserver.observe(slot);
  return slot;
}

function digging(text) {
  return el(
    'div',
    { class: 'digging' },
    el('img', { src: '../../brand/mark.svg', width: 56, height: 56, alt: '' }),
    el('div', { class: 'dirt' }, el('i'), el('i'), el('i')),
    el('div', {}, text)
  );
}

/* ---------- remembered scans ---------- */

// Scans are cached across launches; pages show how old theirs is and quietly rescan past these ages.
const HOUR = 3600e3;
const TTL = { apps: 24 * HOUR, disk: 24 * HOUR, updates: 6 * HOUR, startup: 12 * HOUR };
const isStale = (at, ttl) => !!at && Date.now() - at > ttl;

function ago(at) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

// One quiet "↻ 3 h ago" button: the time is the label, the icon says what a click does.
function setFreshness(id, at, busy) {
  const slot = $('#' + id);
  const label = busy ? 'Digging…' : at ? ago(at) : '';
  slot.querySelector('.fresh-text').textContent = label;
  slot.querySelector('button').setAttribute('aria-label', busy ? 'Digging…' : at ? `Dig again. Last dig ${label}` : 'Dig again');
  slot.querySelector('button').title = at && !busy ? `Last dig ${label}. Click to dig again.` : 'Dig again';
  slot.querySelector('button').disabled = !!busy;
  slot.classList.toggle('is-busy', !!busy);
}

/* ---------- Grub's face ---------- */

{
  const big = $('#grub-face').cloneNode(true);
  big.id = 'run-face';
  big.setAttribute('width', '84');
  big.setAttribute('height', '84');
  big.querySelector('clipPath').id = 'grub-hole-run';
  big.querySelector('[clip-path]').setAttribute('clip-path', 'url(#grub-hole-run)');
  $('#run-face-slot').append(big);

  const about = $('#grub-face').cloneNode(true);
  about.id = 'about-face';
  about.setAttribute('width', '64');
  about.setAttribute('height', '64');
  about.querySelector('clipPath').id = 'grub-hole-about';
  about.querySelector('[clip-path]').setAttribute('clip-path', 'url(#grub-hole-about)');
  $('#about-face-slot').append(about);
}

// Blinks at random intervals (sometimes twice) so the idle face never feels like a loop.
(function blinkLoop() {
  const faces = () => $$('.grub-face');
  const blink = (then) => {
    faces().forEach((f) => f.classList.add('is-blinking'));
    setTimeout(() => {
      faces().forEach((f) => f.classList.remove('is-blinking'));
      then?.();
    }, 140);
  };
  const schedule = () =>
    setTimeout(() => {
      if (!REDUCED_MOTION.matches && !document.hidden) Math.random() < 0.25 ? blink(() => setTimeout(blink, 120)) : blink();
      schedule();
    }, 3500 + Math.random() * 4500);
  schedule();
})();

/* ---------- navigation ---------- */

let currentChore = 'clean';

let current = { view: 'burrow', chore: null };

function show(view, chore) {
  // leaving a finished run's summary dismisses it; a running one keeps going in the background
  if (!$('#runner').hidden && run?.exited && !isRunHome(view, chore)) dismissRun();
  current = { view, chore: view === 'chores' ? chore : null };
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  $$('.nav-item').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.view === view && (view !== 'chores' || b.dataset.chore === chore))
  );
  if (view === 'chores') renderChore(chore);
  if (view === 'dig') {
    const known = digState.cache.get(digState.path);
    if (!digState.loaded) dig(digState.home);
    // a run since the last visit forgot this folder, or it's just old: rescan behind the current view
    else if (!known || isStale(known.at, TTL.disk)) dig(digState.path, null, true);
    else setFreshness('dig-fresh', known.at);
  }
  if (view === 'evict') {
    if (!appsLoaded || isStale(appsAt, TTL.apps)) loadApps(appsLoaded);
    else setFreshness('evict-fresh', appsAt);
  }
  if (view === 'history') loadHistory();
  if (view === 'sweep') sweepRender();
  if (view === 'schedule') showSchedule();
  if (view === 'startup') {
    if (!startupAt || isStale(startupAt, TTL.startup)) loadStartup(!!startupAt);
    else setFreshness('startup-fresh', startupAt);
  }
  if (view === 'updates') {
    if (!updatesLoaded || isStale(updatesAt, TTL.updates)) loadUpdates(updatesLoaded);
    else setFreshness('updates-fresh', updatesAt);
  }
  syncRunner();
}

$$('[data-view], [data-goto]').forEach((b) =>
  b.addEventListener('click', () => show(b.dataset.view || b.dataset.goto, b.dataset.chore))
);

/* ---------- status ---------- */

const headline = Vitals.headliner();

function diskNote(pct) {
  if (pct >= 90) return "That's not a Mac, that's a landfill.";
  if (pct >= 75) return 'Getting crowded down here.';
  return 'Roomy. Grub is bored.';
}

function renderStatus(s) {
  const score = s.health_score ?? 0;
  const ring = $('#health-ring');
  ring.style.setProperty('--p', score);
  ring.classList.toggle('is-meh', score < 70 && score >= 50);
  ring.classList.toggle('is-bad', score < 50);
  $('#health-score').textContent = score;
  $('#health-msg').textContent = Vitals.sentence(s.health_score_msg);
  $('#burrow-title').textContent = headline(s);
  $('#burrow-lede').textContent = `${s.hardware?.model || 'Mac'} · up ${s.uptime || '?'} · ${s.procs ?? '?'} processes`;

  const disk = (s.disks || []).find((d) => d.mount === '/') || s.disks?.[0];
  if (disk) {
    const pct = disk.used_percent;
    $('#disk-free').textContent = bytes(disk.total - disk.used);
    const bar = $('#disk-bar');
    bar.style.setProperty('--v', pct / 100);
    bar.classList.toggle('is-hot', pct >= 90);
    $('#disk-note').textContent = `${pct.toFixed(0)}% of ${bytes(disk.total)} used. ${diskNote(pct)}`;
  }

  const cpu = s.cpu || {};
  $('#cpu-use').textContent = (cpu.usage ?? 0).toFixed(0);
  const cores = $('#cpu-cores');
  const per = cpu.per_core || [];
  if (cores.children.length !== per.length) cores.replaceChildren(...per.map(() => el('i')));
  per.forEach((v, i) => cores.children[i].style.setProperty('--v', `${Math.max(4, v)}%`));
  $('#cpu-note').textContent = `${cpu.core_count ?? '?'} cores. ${Vitals.cpuWord(cpu.usage ?? 0)}`;

  const heat = Vitals.heat(s);
  chip('#cpu-chip', heat.cpuTemp != null && `${heat.cpuTemp}°C`);

  const mem = s.memory || {};
  $('#mem-use').textContent = (mem.used_percent ?? 0).toFixed(0);
  $('#mem-bar').style.setProperty('--v', (mem.used_percent ?? 0) / 100);
  $('#mem-note').textContent = `${bytes(mem.used)} of ${bytes(mem.total)} used. ${Vitals.memWord(mem.used_percent ?? 0)}`;
  chip('#mem-chip', mem.swap_used >= 1e9 && `${bytes(mem.swap_used)} swap`);

  if (disk) chip('#disk-chip', bytes(disk.total));

  const bat = Vitals.battery(s);
  $('#bat-pct').textContent = bat ? bat.pct : '--';
  $('#bat-state').textContent = bat ? `% · ${bat.state}` : '';
  chip('#bat-chip', bat?.health && `Health ${bat.health.toLowerCase()}`);
  facts(
    '#bat-facts',
    bat
      ? [
          bat.detail && ['Now', bat.detail],
          ['Holds', `${bat.capacity}% of when new`],
          ['Charged', `${bat.cycles} times`],
          bat.charger && ['Charger', `${bat.charger} W`],
        ]
      : []
  );
  $('#bat-note').textContent = !bat ? 'No battery. Plugged into the earth.' : bat.worn ? 'Getting tired. Running on crumbs.' : 'Healthy. Plenty of juice left in it.';

  const net = Vitals.network(s);
  const down = Vitals.speed(net.down);
  const up = Vitals.speed(net.up);
  $('#net-down').textContent = down.value;
  $('#net-unit').textContent = `${down.unit} down`;
  netHistory.push(net.down + net.up);
  if (netHistory.length > 30) netHistory.shift();
  spark($('#net-spark'), netHistory);
  chip('#net-chip', net.vpn && 'VPN on');
  $('#net-note').textContent = net.online ? `${up.value} ${up.unit} up. ${net.down + net.up < 0.05 ? 'Quiet line.' : 'Busy line.'}` : 'Offline. Grub is underground.';

  const big = heat.cpuTemp ?? heat.fan ?? heat.power;
  $('#heat-big').textContent = big ?? '--';
  $('#heat-unit').textContent = heat.cpuTemp != null ? '°C' : heat.fan != null ? 'RPM' : heat.power != null ? 'W used' : '';
  chip('#heat-chip', heat.gpuTemp != null && `Graphics ${heat.gpuTemp}°C`);
  facts('#heat-facts', [['Fan', heat.fanLabel], heat.power != null && ['Power use', `${heat.power} W`]]);
  $('#heat-note').textContent = heat.note;

  const g = Vitals.gpu(s);
  $('#gpu-big').textContent = g ? (g.usage ?? g.cores) : '--';
  $('#gpu-unit').textContent = g ? (g.usage != null ? '%' : 'cores') : '';
  chip('#gpu-chip', g?.usage != null && `${g.cores} cores`);
  $('#gpu-note').textContent = !g ? 'No graphics chip found.' : g.usage == null ? `${g.name}. It won’t say how busy it is.` : g.usage < 20 ? 'Idle. Nothing to draw.' : 'Drawing hard.';

  renderProcs(s);
  renderGadgets(s);
  chip('#procs-chip', s.procs && `${s.procs} things running`);

  facts('#machine-facts', [
    ['Chip', s.hardware?.cpu_model],
    ['RAM', s.hardware?.total_ram],
    ['macOS', s.hardware?.os_version?.replace('macOS ', '')],
    ['Screen', s.hardware?.refresh_rate],
    ['Trash', bytes(s.trash_size)],
  ]);
}

const netHistory = [];

function chip(sel, text) {
  const node = $(sel);
  node.hidden = !text;
  if (text) node.textContent = text;
}

function facts(sel, rows) {
  $(sel).replaceChildren(...rows.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')]));
}

// Bars scaled to the busiest moment in view.
function spark(node, values) {
  const max = Math.max(...values, 0.001);
  if (node.children.length !== 30) node.replaceChildren(...Array.from({ length: 30 }, () => el('i')));
  const pad = 30 - values.length;
  [...node.children].forEach((bar, i) => bar.style.setProperty('--v', i < pad ? 0 : Math.max(0.04, values[i - pad] / max)));
}

// Rows are reused across updates; only an icon whose app changed is swapped, so nothing blinks.
function renderProcs(s) {
  const list = Vitals.apps(s);
  const maxMem = Math.max(...list.map((p) => p.mem), 1);
  const box = $('#procs');
  if (!box.children.length)
    box.append(el('div', { class: 'proc proc-head' }, el('span'), el('span', {}, 'App'), el('span', {}, 'Memory'), el('span', {}, 'CPU'), el('span')));
  while (box.children.length > list.length + 1) box.lastChild.remove();
  while (box.children.length < list.length + 1) {
    const row = el('div', { class: 'proc' }, el('span'), el('span', { class: 'proc-name' }), el('span', { class: 'proc-mem' }, el('i'), el('span')), el('span', { class: 'proc-cpu' }));
    row.append(ProcMenu.button(() => row.proc));
    box.append(row);
  }
  list.forEach((p, i) => {
    const row = box.children[i + 1];
    row.proc = p;
    if (row.dataset.app !== String(p.app)) {
      row.dataset.app = String(p.app);
      row.firstChild.replaceWith(procIcon(p.app));
    }
    row.children[1].textContent = p.label;
    row.children[2].firstChild.style.setProperty('--v', p.mem / maxMem);
    row.children[2].lastChild.textContent = bytes(p.mem);
    row.children[3].textContent = `${p.cpu.toFixed(0)}%`;
    row.children[3].classList.toggle('is-hot', p.cpu >= 50);
  });
}

const procIcons = new Map();

function procIcon(path) {
  if (!path) return icon(ICON_APP);
  const img = el('img', { class: 'row-app-icon', alt: '', width: 22, height: 22 });
  if (!procIcons.has(path)) procIcons.set(path, window.mole.appIcon(path));
  procIcons.get(path).then((url) => url && (img.src = url));
  return img;
}

function renderGadgets(s) {
  const { connected, paired } = Vitals.gadgets(s);
  chip('#bt-chip', paired && `${paired} paired`);
  if (!connected.length)
    return $('#gadgets').replaceChildren(el('p', { class: 'note' }, paired ? 'Nothing connected right now.' : 'No Bluetooth gadgets yet.'));
  $('#gadgets').replaceChildren(
    ...connected.map((d) =>
      el('div', { class: 'gadget' }, el('span', { class: 'gadget-name' }, d.name), el('span', { class: 'gadget-bat' }, d.battery != null ? `${d.battery}%` : ''))
    )
  );
}

/* ---------- disk ---------- */

let savedLayout = 'map';
try {
  savedLayout = localStorage.getItem('dig-layout') || 'map';
} catch {}
const digState = { home: '', path: '', loaded: false, cache: new Map(), entries: [], layout: savedLayout };

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';

// fresh rescans the folder while the old answer stays on screen
async function dig(target, fromTile, fresh) {
  digState.loaded = true;
  digState.path = target;
  renderCrumbs();
  const list = $('#dig-list');
  // a new dig (say, back via the breadcrumb) abandons any zoom still waiting on its folder
  digState.zoom?.cancel();
  const zoom = fromTile && digState.layout === 'map' ? zoomInto(fromTile, target) : null;
  digState.zoom = zoom;
  let res = fresh ? null : digState.cache.get(target);
  if (!res) {
    if (fresh) setFreshness('dig-fresh', 0, true);
    else {
      $('#dig-total').textContent = '';
      setFreshness('dig-fresh', 0);
      if (!zoom) {
        $('#dig-map').replaceChildren();
        list.replaceChildren(digging('Tunnelling through ' + target.replace(digState.home, '~') + '…'));
      }
    }
    res = await window.mole.analyze(target, fresh);
    if (res.ok) digState.cache.set(target, res);
  }
  if (zoom) await zoom.grown;
  if (digState.zoom !== zoom) return; // superseded; the newer dig already cleaned up
  digState.zoom = null;
  if (digState.path !== target) return;
  const shown = digState.cache.get(target);
  if (!res.ok) {
    zoom?.cancel();
    setFreshness('dig-fresh', shown?.at);
    // a failed rescan keeps the last good answer on screen
    if (fresh && shown) return;
    return list.replaceChildren(el('div', { class: 'empty' }, 'Grub hit a rock: ' + res.error));
  }
  digState.entries = (res.data.entries || []).filter((e) => e.size > 0).slice(0, 80);
  renderDig();
  zoom?.reveal();
  setFreshness('dig-fresh', res.at);
  if (!fresh && isStale(res.at, TTL.disk)) dig(target, null, true);
}

$('#dig-refresh').addEventListener('click', () => dig(digState.path, null, true));

// The clicked tile grows to fill the map (clip-path only), then dissolves to show what's inside.
function zoomInto(tile, target) {
  const map = $('#dig-map');
  const m = map.getBoundingClientRect();
  const t = tile.getBoundingClientRect();
  const from = `inset(${t.top - m.top}px ${m.right - t.right}px ${m.bottom - t.bottom}px ${t.left - m.left}px round 12px)`;
  const to = 'inset(3px 3px 3px 3px round 12px)';
  const layer = el(
    'div',
    { class: `dig-zoom ${[...tile.classList].find((c) => c.startsWith('t-')) || ''}`, 'aria-hidden': 'true' },
    el('div', { class: 'dig-zoom-label' }, el('span', { class: 'dig-zoom-dot' }), 'Tunnelling into ', el('b', {}, target.split('/').pop()), '…')
  );
  map.append(layer);
  map.classList.add('is-zooming');
  // read the parent's colours now, while the layer is attached (re-rendering detaches it)
  const cs = getComputedStyle(layer);
  const tone = Object.fromEntries(['a', 'b', 'dot'].map((v) => [v, cs.getPropertyValue(`--tile-${v}`).trim()]));
  const reduce = REDUCED_MOTION.matches;
  for (const other of map.querySelectorAll('.tile')) other.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
  const grow = reduce
    ? layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out', fill: 'forwards' })
    : layer.animate([{ clipPath: from }, { clipPath: to }], { duration: 420, easing: EASE_IN_OUT, fill: 'forwards' });
  return {
    layer,
    cancel() {
      layer.remove();
      map.classList.remove('is-zooming');
    },
    // never wait on the animation forever (a hidden window can pause it)
    grown: Promise.race([grow.finished.catch(() => {}), new Promise((r) => setTimeout(r, 700))]),
    reveal() {
      map.classList.remove('is-zooming');
      if (reduce) {
        map.append(layer);
        layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished.then(() => layer.remove());
        return;
      }
      // The new tiles start in the parent's colour, so the big tile seems to crack apart,
      // then each one settles into its own colour, biggest first.
      for (const v of ['a', 'b', 'dot']) map.style.setProperty(`--born-${v}`, tone[v]);
      const tiles = [...map.querySelectorAll('.tile')];
      // no entrance keyframes for these tiles: they're already on screen, and the keyframes
      // would restart from opacity 0 when is-born comes off (the dark flash)
      tiles.forEach((t) => {
        t.style.animation = 'none';
        t.classList.add('is-born');
      });
      layer.remove();
      tiles.forEach((t, i) => setTimeout(() => t.classList.remove('is-born'), 90 + Math.min(i, 12) * 45));
    },
  };
}

function renderDig() {
  const entries = digState.entries || [];
  const total = entries.reduce((n, e) => n + e.size, 0);
  $('#dig-total').textContent = entries.length ? `${bytes(total)} · ${entries.length} items` : '';
  const list = $('#dig-list');
  const map = $('#dig-map');
  const asMap = digState.layout === 'map';
  $$('.seg [data-layout]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.layout === digState.layout)));
  map.hidden = !asMap;
  if (!entries.length) {
    map.replaceChildren();
    return list.replaceChildren(el('div', { class: 'empty' }, 'Nothing here but dirt.'));
  }
  if (asMap) {
    list.replaceChildren();
    return renderMap(map, entries.slice(0, 40));
  }
  map.replaceChildren();
  const max = entries[0].size;
  list.replaceChildren(
    ...entries.map((e, i) =>
      el(
        'div',
        {
          class: 'row' + (e.is_dir ? ' is-dir' : ''),
          style: `--i:${Math.min(i, 20)}`,
          role: e.is_dir ? 'button' : null,
          tabindex: e.is_dir ? '0' : null,
          onclick: () => e.is_dir && dig(e.path),
          onkeydown: (ev) => e.is_dir && ev.key === 'Enter' && dig(e.path),
        },
        icon(e.is_dir ? ICON_DIR : ICON_FILE),
        el('div', { class: 'row-name' }, e.name),
        el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `--v:${e.size / max}` })),
        el('div', { class: 'row-size' }, bytes(e.size)),
        el(
          'button',
          {
            class: 'row-act',
            onclick: (ev) => {
              ev.stopPropagation();
              window.mole.reveal(e.path);
            },
          },
          'Show in Finder'
        )
      )
    )
  );
}

// Squarified treemap: lay out rows along the short side so tiles stay close to square.
function squarify(items, x, y, w, h, out = []) {
  if (!items.length) return out;
  const total = items.reduce((n, i) => n + i.value, 0);
  const short = Math.min(w, h);
  let row = [];
  let rowSum = 0;
  const worst = (r, sum) => {
    const side = (sum / total) * (w * h) / short;
    return Math.max(...r.map((i) => {
      const len = ((i.value / total) * (w * h)) / side;
      return Math.max(side / len, len / side);
    }));
  };
  let i = 0;
  for (; i < items.length; i++) {
    const next = [...row, items[i]];
    if (row.length && worst(next, rowSum + items[i].value) > worst(row, rowSum)) break;
    row = next;
    rowSum += items[i].value;
  }
  const side = ((rowSum / total) * (w * h)) / short;
  let offset = 0;
  for (const item of row) {
    const len = ((item.value / rowSum) * short);
    if (w >= h) out.push({ item, x, y: y + offset, w: side, h: len });
    else out.push({ item, x: x + offset, y, w: len, h: side });
    offset += len;
  }
  const rest = items.slice(i);
  if (w >= h) squarify(rest, x + side, y, w - side, h, out);
  else squarify(rest, x, y + side, w, h - side, out);
  return out;
}

const ICON_TILE_DIR = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_TILE_FILE = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
const ICON_TILE_CRUMBS = '<svg viewBox="0 0 24 24"><circle cx="7" cy="15" r="2"/><circle cx="13" cy="9" r="2"/><circle cx="17" cy="16" r="2"/></svg>';

// Size decides the colour: big hogs are moldy green, small stuff fades back into the soil.
function tileTone(e, share) {
  if (e.crumbs) return 't-crumbs';
  if (!e.is_dir) return 't-snout';
  if (share >= 0.2) return 't-mold';
  if (share >= 0.08) return 't-moss';
  if (share >= 0.03) return 't-sprout';
  return 't-soil';
}

function renderMap(map, entries) {
  const { width, height } = map.getBoundingClientRect();
  const total = entries.reduce((n, e) => n + e.size, 0);
  // the long tail becomes one "crumbs" tile instead of a pile of unreadable slivers
  const keep = [];
  let rest = [];
  entries.forEach((e, i) => (i < 8 || (i < 28 && e.size / total >= 0.006) ? keep : rest).push(e));
  if (rest.length === 1) keep.push(...rest.splice(0));
  if (rest.length) keep.push({ name: `${rest.length} crumbs`, size: rest.reduce((n, e) => n + e.size, 0), crumbs: true });
  const tiles = squarify(keep.map((e) => ({ value: e.size, e })), 0, 0, width, height);
  const GAP = 3;
  map.replaceChildren(
    ...tiles.map(({ item: { e }, x, y, w, h }, i) => {
      const share = e.size / total;
      const tw = w - GAP * 2;
      const th = h - GAP * 2;
      const tiny = tw < 84 || th < 52;
      const small = !tiny && (tw < 160 || th < 100);
      const sizeFont = Math.round(Math.max(15, Math.min(34, Math.min(tw, th) / 5)));
      const hint = e.crumbs ? 'See all' : e.is_dir ? 'Dig in' : 'Show in Finder';
      return el(
        'button',
        {
          class: `tile ${tileTone(e, share)}${tiny ? ' is-tiny' : ''}${small ? ' is-small' : ''}`,
          style: `left:${x + GAP}px;top:${y + GAP}px;width:${tw}px;height:${th}px;--i:${Math.min(i, 24)};--size-font:${sizeFont}px`,
          title: `${e.name} · ${bytes(e.size)} · ${(share * 100).toFixed(1)}%`,
          'aria-label': `${e.name}, ${bytes(e.size)}. ${hint}`,
          onclick: (ev) => {
            if (map.classList.contains('is-zooming')) return;
            e.crumbs ? setLayout('list') : e.is_dir ? dig(e.path, ev.currentTarget) : window.mole.reveal(e.path);
          },
        },
        el('span', { class: 'tile-top' }, icon(e.crumbs ? ICON_TILE_CRUMBS : e.is_dir ? ICON_TILE_DIR : ICON_TILE_FILE), el('b', {}, e.name)),
        el(
          'span',
          { class: 'tile-bottom' },
          el('span', { class: 'tile-size' }, bytes(e.size)),
          el('span', { class: 'tile-share' }, share >= 0.01 ? `${Math.round(share * 100)}%` : '<1%')
        ),
        el('span', { class: 'tile-hint' }, hint, ' →')
      );
    })
  );
}

function setLayout(layout) {
  digState.layout = layout;
  try {
    localStorage.setItem('dig-layout', layout);
  } catch {}
  renderDig();
}

$$('.seg [data-layout]').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));
new ResizeObserver(() => digState.layout === 'map' && $('#view-dig').classList.contains('is-active') && renderDig()).observe(
  $('#dig-map')
);

function renderCrumbs() {
  const rel = digState.path.startsWith(digState.home) ? digState.path.slice(digState.home.length) : digState.path;
  const parts = rel.split('/').filter(Boolean);
  const crumbs = [['~', digState.home]];
  parts.forEach((p, i) => crumbs.push([p, digState.home + '/' + parts.slice(0, i + 1).join('/')]));
  $('#dig-crumbs').replaceChildren(...crumbs.map(([label, p]) => el('button', { onclick: () => dig(p) }, label)));
}

/* ---------- chores ---------- */

function renderChore(key) {
  currentChore = key;
  const c = CHORES[key];
  $('#chore-eyebrow').textContent = c.eyebrow;
  $('#chore-title').textContent = c.title;
  $('#chore-lede').textContent = c.lede;
  $('#chore-points').replaceChildren(...c.points.map((p) => el('li', {}, p)));
  $('#chore-chomp-label').textContent = c.chomp;
  $('#chore-chomp-sub').textContent = c.picker ? 'you pick what goes' : 'for real';
  $('#chore-sniff').hidden = !!c.picker;
}

$('#chore-sniff').addEventListener('click', () => runTask({ command: currentChore, dryRun: true }));
$('#chore-chomp').addEventListener('click', () => {
  const c = CHORES[currentChore];
  if (c.picker) return runTask({ command: currentChore });
  confirmRun(c.confirm, c.chomp, () => runTask({ command: currentChore }));
});

/* ---------- uninstall ---------- */

let appsLoaded = false;
let appsAt = 0;
let apps = [];

// Shows the remembered list straight away; fresh (or a stale cache) rescans with the old list still up.
async function loadApps(fresh) {
  appsLoaded = true;
  const list = $('#evict-list');
  if (!apps.length) list.replaceChildren(digging('Counting your apps…'));
  setFreshness('evict-fresh', appsAt, true);
  const res = await window.mole.apps(fresh);
  if (!res.ok) {
    setFreshness('evict-fresh', appsAt);
    if (!apps.length) list.replaceChildren(el('div', { class: 'empty' }, 'Could not list apps: ' + res.error));
    return;
  }
  apps = res.data.map((a) => ({ ...a, bytes: parseSize(a.size) })).sort((a, b) => b.bytes - a.bytes);
  appsAt = res.at;
  renderApps();
  setFreshness('evict-fresh', appsAt);
  if (!fresh && isStale(appsAt, TTL.apps)) loadApps(true);
}

$('#evict-refresh').addEventListener('click', () => loadApps(true));

// A just-uninstalled app leaves the list straight away; the rescan that follows confirms it.
function forgetApp(path) {
  apps = apps.filter((a) => a.path !== path);
  renderApps();
}

function renderApps() {
  const q = $('#evict-search').value.trim().toLowerCase();
  const shown = apps.filter((a) => a.name.toLowerCase().includes(q));
  const max = apps[0]?.bytes || 1;
  const list = $('#evict-list');
  if (!shown.length) return list.replaceChildren(el('div', { class: 'empty' }, 'No app by that name.'));
  list.replaceChildren(
    ...shown.map((a, i) =>
      el(
        'div',
        { class: 'row', style: `--i:${Math.min(i, 20)}` },
        appIcon(a.path),
        el('div', { class: 'row-name' }, a.name, el('span', { class: 'row-sub' }, a.path)),
        el('div', { class: 'bar' }, el('div', { class: 'bar-fill bar-pink', style: `--v:${a.bytes / max}` })),
        el('div', { class: 'row-size' }, bytes(a.bytes)),
        el(
          'div',
          { style: 'display:flex;gap:6px' },
          el(
            'button',
            { class: 'row-act', onclick: () => runTask({ command: 'uninstall', appName: a.uninstall_name, label: a.name, path: a.path }) },
            'Evict'
          )
        )
      )
    )
  );
}

$('#evict-search').addEventListener('input', renderApps);

/* ---------- history ---------- */

async function loadHistory() {
  const list = $('#history-list');
  list.replaceChildren(digging('Flipping through the diary…'));
  const res = await window.mole.history();
  if (!res.ok) return list.replaceChildren(el('div', { class: 'empty' }, 'No diary found: ' + res.error));
  const sessions = res.data.sessions || [];
  const total = sessions.reduce((n, s) => n + parseSize(s.size), 0);
  $('#history-title').textContent = total ? `Grub has eaten ${bytes(total)} so far.` : "Grub's food diary.";
  if (!sessions.length) return list.replaceChildren(el('div', { class: 'empty' }, 'Empty. Grub is starving.'));
  list.replaceChildren(
    ...sessions.map((s, i) => {
      const nav = navFor(s.command);
      const skipped = s.actions?.skipped ?? 0;
      return el(
        'div',
        { class: 'row', style: `--i:${Math.min(i, 20)}` },
        nav.icon,
        el(
          'div',
          { class: 'row-name' },
          nav.label,
          el(
            'span',
            { class: 'row-sub' },
            [when(s.started_at), plural(s.items, 'item'), skipped && `${skipped} skipped`].filter(Boolean).join(' · ')
          )
        ),
        el('div'),
        el('div', { class: 'row-size' }, bytes(parseSize(s.size))),
        el('div', { class: 'row-sub' }, s.failed_tasks ? `${s.failed_tasks} failed` : '')
      );
    })
  );
}

// History speaks in the sidebar's names and icons, not Mole's command names.
const NAV_OF = { uninstall: '[data-view="evict"]', update: '[data-view="updates"]', ai: '[data-view="ai"]' };
function navFor(command) {
  const item = $(`.nav-item${NAV_OF[command] || `[data-chore="${command}"]`}`);
  const svg = item?.querySelector('svg')?.cloneNode(true);
  if (svg) svg.setAttribute('class', 'row-icon');
  return {
    label: item?.querySelector('span')?.textContent || command.charAt(0).toUpperCase() + command.slice(1),
    icon: svg || icon(ICON_FILE),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "Today, 18:06", "Yesterday, 09:12", "3 Oct, 14:20"
function when(stamp) {
  const d = new Date(String(stamp).replace(' ', 'T'));
  if (isNaN(d)) return stamp;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/* ---------- tidy up (one click) ---------- */

function tidy() {
  confirmRun('Grub will clean caches and leftovers, then refresh system services. It may ask for your Mac password.', 'Tidy up', () =>
    runTask({ tool: 'tidy' })
  );
}

$('#tidy-btn').addEventListener('click', tidy);

/* ---------- startup items ---------- */

const SCOPE_LABEL = { user: 'Yours', system: 'All users', daemon: 'System daemon' };

let startupAt = 0;

// Same pattern as the app list: remembered answer first, rescan on request or once it's old.
async function loadStartup(fresh) {
  const logins = $('#login-list');
  const agents = $('#agent-list');
  if (!startupAt) {
    logins.replaceChildren(digging('Checking who gets in at boot…'));
    agents.replaceChildren();
  }
  setFreshness('startup-fresh', startupAt, true);
  const res = await window.mole.startup.list(fresh);
  const { loginItems, agents: list, loginError, loginDenied } = res.data;
  // a permission prompt isn't remembered, so the next visit asks macOS again
  startupAt = loginDenied || loginError ? 0 : res.at;
  setFreshness('startup-fresh', res.at);
  if (!fresh && isStale(startupAt, TTL.startup)) loadStartup(true);

  if (loginDenied)
    logins.replaceChildren(
      el(
        'div',
        { class: 'permission' },
        el('img', { src: '../../brand/mark.svg', width: 44, height: 44, alt: '' }),
        el(
          'div',
          { class: 'permission-text' },
          el('strong', {}, "Grub can't see your login items."),
          el('span', {}, 'macOS needs your OK first. In Automation, turn on System Events for Grub, then come back and check again.')
        ),
        el('button', { class: 'btn btn-primary', onclick: () => window.mole.startup.openAutomationSettings() }, 'Allow access'),
        el('button', { class: 'btn btn-quiet', onclick: () => loadStartup(true) }, 'Check again')
      )
    );
  else if (loginError) logins.replaceChildren(el('div', { class: 'empty' }, 'Could not read login items: ' + loginError));
  else if (!loginItems.length) logins.replaceChildren(el('div', { class: 'empty' }, 'Nothing opens at login. Very disciplined.'));
  else
    logins.replaceChildren(
      ...loginItems.map((item, i) =>
        el(
          'div',
          { class: 'row row-wide', style: `--i:${i}` },
          appIcon(item.path),
          el('div', { class: 'row-name' }, item.name, el('span', { class: 'row-sub' }, item.path)),
          el('span'), // tag column, so Remove lines up with the agents' switches below
          el(
            'button',
            {
              class: 'row-act',
              onclick: () =>
                confirmRun(`${item.name} will stop opening when you log in. The app itself stays installed.`, 'Remove', async () => {
                  const r = await window.mole.startup.removeLogin(item.name);
                  if (!r.ok) alert(r.error);
                  loadStartup(true);
                }),
            },
            'Remove'
          )
        )
      )
    );

  const sorted = [...list].sort((a, b) => (a.scope === b.scope ? a.label.localeCompare(b.label) : a.scope === 'user' ? -1 : 1));
  if (!sorted.length) return agents.replaceChildren(el('div', { class: 'empty' }, 'No background agents. Spotless.'));
  agents.replaceChildren(
    ...sorted.map((a, i) => {
      const on = !a.disabled;
      const ctrl =
        a.scope === 'user'
          ? el('button', {
              class: 'switch',
              role: 'switch',
              'aria-checked': String(on),
              'aria-label': `${on ? 'Disable' : 'Enable'} ${a.label}`,
              onclick: async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                const r = await window.mole.startup.toggle({ label: a.label, file: a.file, enable: !on });
                if (!r.ok) alert(r.error);
                loadStartup(true);
              },
            })
          : el('button', { class: 'row-act', onclick: () => window.mole.reveal(a.file) }, 'Show in Finder');
      return el(
        'div',
        { class: 'row row-wide', style: `--i:${Math.min(i, 20)}` },
        icon(ICON_FILE),
        el('div', { class: 'row-name' }, a.label, el('span', { class: 'row-sub' }, a.program || a.file)),
        el(
          'div',
          { style: 'display:flex;gap:6px' },
          el('span', { class: 'tag' }, SCOPE_LABEL[a.scope]),
          a.loaded ? el('span', { class: 'tag is-on' }, 'Running') : null,
          a.disabled && a.scope !== 'user' ? el('span', { class: 'tag' }, 'Off') : null
        ),
        ctrl
      );
    })
  );
}

$('#startup-refresh').addEventListener('click', () => loadStartup(true));

/* ---------- updates ---------- */

let updatesLoaded = false;
let updatesAt = 0;
let outdated = { formulae: [], casks: [] };

async function loadUpdates(fresh) {
  updatesLoaded = true;
  const list = $('#updates-list');
  if (!updatesAt) {
    $('#update-all').disabled = true;
    list.replaceChildren(digging('Sniffing for stale versions…'));
  }
  setFreshness('updates-fresh', updatesAt, true);
  const res = await window.mole.updates(fresh);
  if (!res.ok) {
    setFreshness('updates-fresh', updatesAt);
    if (!updatesAt) list.replaceChildren(el('div', { class: 'empty' }, 'Homebrew did not answer: ' + res.error));
    return;
  }
  updatesAt = res.at;
  setFreshness('updates-fresh', updatesAt);
  if (!fresh && isStale(updatesAt, TTL.updates)) loadUpdates(true);
  outdated = { formulae: res.data.formulae || [], casks: res.data.casks || [] };
  const all = [
    ...outdated.casks.map((c) => ({ ...c, cask: true })),
    ...outdated.formulae.map((f) => ({ ...f, cask: false })),
  ];
  $('#updates-title').textContent = all.length ? `${all.length} things have gone stale.` : 'Everything is fresh.';
  $('#update-all').disabled = !all.length;
  if (!all.length) return list.replaceChildren(el('div', { class: 'empty' }, 'Nothing to update. Grub is impressed.'));
  list.replaceChildren(
    ...all.map((u, i) =>
      el(
        'div',
        { class: 'row row-wide', style: `--i:${Math.min(i, 20)}` },
        icon(u.cask ? ICON_APP : ICON_FILE),
        el(
          'div',
          { class: 'row-name' },
          u.name,
          el('span', { class: 'row-sub' }, `${(u.installed_versions || []).join(', ')} → ${u.current_version}`)
        ),
        el('span', { class: 'tag' }, u.cask ? 'App' : 'Tool'),
        el('button', { class: 'row-act', onclick: () => runTask({ tool: 'brew', names: [u.name], cask: u.cask }) }, 'Update')
      )
    )
  );
}

$('#update-recheck').addEventListener('click', () => loadUpdates(true));
$('#update-all').addEventListener('click', () =>
  confirmRun('Homebrew will upgrade every outdated app and tool on the list.', 'Update everything', () => runTask({ tool: 'brew', names: [] }))
);

/* ---------- menu bar requests ---------- */

window.mole.app.onNavigate((view) => show(view));
window.mole.app.onRun((opts) => (opts.tool === 'tidy' ? tidy() : runTask(opts)));

/* ---------- settings + about ---------- */

let settings = {};

function setSwitch(node, on) {
  node.setAttribute('aria-checked', String(!!on));
}

async function saveSetting(patch) {
  settings = await window.mole.settings.set(patch);
  setSwitch($('#pref-login'), settings.openAtLogin);
  setSwitch($('#about-login'), settings.openAtLogin);
  setSwitch($('#pref-update'), settings.autoUpdateMole);
  setSwitch($('#about-auto'), settings.autoUpdateMole);
  setSwitch($('#about-alerts'), settings.alerts !== false);
}

for (const [id, key] of [
  ['#pref-login', 'openAtLogin'],
  ['#about-login', 'openAtLogin'],
  ['#pref-update', 'autoUpdateMole'],
  ['#about-auto', 'autoUpdateMole'],
])
  $(id).addEventListener('click', () => saveSetting({ [key]: !settings[key] }));
$('#about-alerts').addEventListener('click', () => saveSetting({ alerts: settings.alerts === false }));

let grubUpdate = {};

async function refreshVersion() {
  const v = await window.mole.version();
  const num = (v.match(/\d+\.\d+\.\d+/) || [''])[0];
  const grub = grubUpdate.version ? `Grub ${grubUpdate.version} · ` : '';
  $('#mole-version').textContent = grub + (num ? `Mole ${num}` : 'Mole');
  $('#about-mole').textContent = num ? `Mole ${num}` : 'Mole';
  $('#mole-dot').classList.toggle('is-on', !!num);
}

function openAbout() {
  document.body.classList.add('about-open');
  // a fresh look at Mole when About opens, at most every 10 minutes
  if (['idle', 'latest', 'error'].includes(moleUpdate.status) && Date.now() - moleUpdate.checkedAt > 10 * 60 * 1000) checkMole();
  $('#about-close').focus();
}

function closeAbout() {
  document.body.classList.remove('about-open');
}

$('#about-open').addEventListener('click', openAbout);
$('#about-close').addEventListener('click', closeAbout);
$('#about-onboard').addEventListener('click', () => {
  closeAbout();
  startOnboarding();
});
$$('[data-link]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.mole.openLink(a.dataset.link);
  })
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('about-open')) closeAbout();
});

// "Checked 15:33" today, "Checked 8 Oct" before that; both rows in About use it.
function checked(at) {
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  return `Checked ${today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' })}.`;
}

/* Mole's updates: Check now asks Homebrew if a newer one is out; installing it is a second, deliberate click
   (or happens once a day when "Update Mole automatically" is on). */

let moleUpdate = { status: 'idle', next: null, checkedAt: 0 };

function renderMoleUpdate(patch) {
  moleUpdate = { ...moleUpdate, ...patch };
  const { status, next, checkedAt } = moleUpdate;
  const text = {
    idle: checkedAt ? `Up to date. ${checked(checkedAt)}` : 'Checks once a day with Homebrew.',
    checking: 'Checking for a newer Mole…',
    available: `Mole ${next} is out.`,
    updating: `Updating to ${next || 'the newest Mole'}…`,
    latest: `Up to date. ${checked(checkedAt)}`,
    updated: `Updated to ${next}. ${checked(checkedAt)}`,
    error: "Couldn't check right now. Grub will try again tomorrow.",
    nobrew: 'Checking needs Homebrew.',
  }[status];
  $('#about-mole-status').textContent = text;
  const btn = $('#about-update');
  if (status === 'available') setUpdateButton(btn, `Update to ${next}`, { icon: 'download', primary: true });
  else if (status === 'updating') setUpdateButton(btn, 'Updating…', { icon: 'download', enabled: false });
  else setUpdateButton(btn, status === 'checking' ? 'Checking…' : 'Check now', { enabled: status !== 'checking' && status !== 'nobrew' });
  // an <svg> has no .hidden property, so set the attribute itself
  $('#mole-update-glyph').toggleAttribute('hidden', status !== 'available');
}

async function checkMole() {
  renderMoleUpdate({ status: 'checking' });
  const r = await window.mole.moleOutdated();
  if (!r.ok) return renderMoleUpdate({ status: r.reason === 'nobrew' ? 'nobrew' : 'error' });
  renderMoleUpdate(r.next ? { status: 'available', next: r.next } : { status: 'latest', next: null, checkedAt: r.checkedAt });
}

$('#about-update').addEventListener('click', async () => {
  if (moleUpdate.status !== 'available') return checkMole();
  renderMoleUpdate({ status: 'updating' });
  if (!(await window.mole.updateMole())) renderMoleUpdate({ status: 'nobrew' });
});

/* Grub's own updates: the updater in main checks every few hours; About shows where it's at. */


// Both rows in About share one button shape: a label, an optional icon, and lime when there's something to do.
function setUpdateButton(btn, label, { icon = null, enabled = true, primary = false } = {}) {
  btn.querySelector('[id$="-label"]').textContent = label;
  if (icon) btn.dataset.icon = icon;
  else delete btn.dataset.icon;
  btn.disabled = !enabled;
  btn.classList.toggle('btn-primary', primary);
  btn.classList.toggle('btn-quiet', !primary);
  btn.closest('.about-version').classList.toggle('is-ready', primary);
}

// status: [text, button label, icon, clickable]
const GRUB_UPDATE = {
  dev: ['Updates come with the released app.', 'Check now', null, false],
  idle: ['Checks for updates on its own.', 'Check now', null, true],
  checking: ['Checking for a newer Grub…', 'Checking…', null, false],
  downloading: ['A newer Grub is downloading.', 'Downloading…', 'download', false],
  latest: ['Up to date. Checked just now.', 'Check now', null, true],
  error: ["Couldn't check right now. Grub will try again later.", 'Check now', null, true],
  ready: [null, 'Restart to update', 'restart', true],
};

function renderGrubUpdate(s) {
  grubUpdate = s;
  const [text, label, icon, enabled] = GRUB_UPDATE[s.status] || GRUB_UPDATE.idle;
  const ready = s.status === 'ready';
  $('#about-grub').textContent = `Grub ${s.version}`;
  $('#about-grub-status').textContent = ready
    ? `Grub ${s.next || 'update'} is ready. It installs when Grub restarts.`
    : s.status === 'latest' && s.checkedAt
      ? `Up to date. ${checked(s.checkedAt)}`
      : text;
  const btn = $('#about-grub-update');
  // .btn sets display, which beats the hidden attribute
  btn.style.display = s.status === 'dev' ? 'none' : '';
  setUpdateButton(btn, label, { icon, enabled, primary: ready });
  $('#update-card').hidden = !ready;
  $('#update-card-note').textContent = s.next ? `Restart for ${s.next}` : 'Restart to install it';
  refreshVersion();
}

async function installGrubUpdate() {
  const ok = await window.mole.grubUpdate.install();
  if (ok) return;
  openAbout();
  $('#about-grub-status').textContent = 'Finish the chore that’s running first, then restart.';
}

$('#about-grub-update').addEventListener('click', async () => {
  if (grubUpdate.status === 'ready') return installGrubUpdate();
  renderGrubUpdate(await window.mole.grubUpdate.check());
});
$('#update-card').addEventListener('click', installGrubUpdate);

window.mole.grubUpdate.onChange(renderGrubUpdate);
window.mole.grubUpdate.state().then(renderGrubUpdate);

// fires after Update to…, and after the daily automatic update
window.mole.onMoleUpdated((r) => {
  const before = $('#about-mole').textContent;
  const now = (r.version?.match(/\d+\.\d+\.\d+/) || [''])[0];
  if (!r.ok) renderMoleUpdate({ status: 'error' });
  else if (now && before !== 'Mole' && before !== `Mole ${now}`) renderMoleUpdate({ status: 'updated', next: now, checkedAt: Date.now() });
  else renderMoleUpdate({ status: 'latest', checkedAt: Date.now() });
  refreshVersion();
});

/* ---------- onboarding ---------- */

const STEPS = ['welcome', 'engine', 'disk', 'automation', 'prefs'];
let step = 0;
let diskPoll;

function setCheck(id, state, text) {
  const node = $(id);
  node.className = 'check' + (state ? ` is-${state}` : '');
  node.querySelector('.check-text').textContent = text;
}

function goStep(i) {
  step = i;
  $$('.step').forEach((s) => s.classList.toggle('is-active', s.dataset.step === STEPS[i]));
  $('#onboard-dots').replaceChildren(...STEPS.map((_, j) => el('li', { class: j <= i ? 'is-done' : '' })));
  clearInterval(diskPoll);
  const name = STEPS[i];
  if (name === 'engine') checkEngine();
  if (name === 'disk') {
    checkDisk();
    diskPoll = setInterval(checkDisk, 2000);
  }
  if (name === 'prefs') saveSetting({});
}

async function checkEngine() {
  const p = await window.mole.perms.check();
  $('#engine-install').hidden = true;
  $('#engine-next').hidden = true;
  if (p.mole) {
    setCheck('#engine-check', 'ok', 'Engine ready. Teeth sharpened.');
    $('#engine-next').hidden = false;
  } else if (p.brew) {
    setCheck('#engine-check', 'bad', 'Not installed yet.');
    $('#engine-install').hidden = false;
  } else {
    setCheck('#engine-check', 'bad', 'Grub needs Homebrew to fetch its engine. Install it from brew.sh, then reopen Grub.');
  }
}

$('#engine-install').addEventListener('click', async () => {
  $('#engine-install').hidden = true;
  setCheck('#engine-check', 'busy', 'Fetching the engine… this can take a minute.');
  const code = await runQuiet({ tool: 'brew', action: 'install', names: ['mole'] });
  if (code === 0) {
    window.mole.watchStatus();
    refreshVersion();
  }
  checkEngine();
});

async function checkDisk() {
  const p = await window.mole.perms.check();
  if (p.fullDisk) {
    setCheck('#disk-check', 'ok', 'Full Disk Access is on.');
    $('#disk-open').textContent = 'Continue';
    $('#disk-open').dataset.done = '1';
    $('[data-step=disk] [data-next]').hidden = true;
  } else setCheck('#disk-check', '', 'Not allowed yet');
}

$('#disk-open').addEventListener('click', () =>
  $('#disk-open').dataset.done ? goStep(step + 1) : window.mole.perms.open('fullDisk')
);

$('#auto-allow').addEventListener('click', async () => {
  const btn = $('#auto-allow');
  if (btn.dataset.done) return goStep(step + 1);
  if (btn.dataset.denied) return window.mole.perms.open('automation');
  setCheck('#auto-check', 'busy', 'Waiting for your answer in the macOS dialog…');
  const state = await window.mole.perms.automation();
  if (state === 'granted') {
    setCheck('#auto-check', 'ok', 'Allowed. Grub can see your login items.');
    btn.textContent = 'Continue';
    btn.dataset.done = '1';
    $('[data-step=automation] [data-next]').hidden = true;
  } else {
    setCheck('#auto-check', 'bad', 'macOS said no. Turn on System Events for Grub in Settings, then come back.');
    btn.textContent = 'Open Settings';
    btn.dataset.denied = '1';
  }
});

$$('[data-next]').forEach((b) => b.addEventListener('click', () => goStep(step + 1)));

$('#onboard-done').addEventListener('click', async () => {
  await saveSetting({ onboarded: true });
  $('#onboard').hidden = true;
  clearInterval(diskPoll);
});

function startOnboarding() {
  $('#onboard').hidden = false;
  goStep(0);
}

/* ---------- boot ---------- */

(async () => {
  settings = await window.mole.settings.get();
  await saveSetting({});
  renderMoleUpdate({ checkedAt: settings.lastMoleUpdate || 0 });
  // let the sidebar show when a newer Mole is out, without opening About
  if (await window.mole.available()) setTimeout(checkMole, 20000);
  digState.home = await window.mole.home();
  window.mole.onStatus(renderStatus);
  renderChore('clean');
  if (!settings.onboarded || !(await window.mole.available())) startOnboarding();
  if (await window.mole.available()) {
    refreshVersion();
    window.mole.watchStatus();
  }
})();
