/* ---------- Storage: the whole disk, added up, so what macOS calls System Data has names and sizes ---------- */

const fs = require('fs');
const path = require('path');

const DATA = '/System/Volumes/Data';
const SIM_CACHE = '/Library/Developer/CoreSimulator/Caches/dyld';
const GB = 1e9;
const TMP_MIN = 0.5 * GB; // temp folders smaller than this aren't worth a row
const REVIEW_MIN = 0.5 * GB;
const DEEP_MAX_AGE = 7 * 24 * 3600e3; // an admin look older than this no longer describes the disk

// `du -k` lines under /System/Volumes/Data, as { 'Users/you': bytes }. '' is the whole volume.
function parseUsage(text) {
  const usage = {};
  for (const l of text.split(/\r\n|\r|\n/)) {
    const m = /^(\d+)\t(.+)$/.exec(l);
    if (!m || (m[2] !== DATA && !m[2].startsWith(DATA + '/'))) continue;
    usage[m[2].slice(DATA.length + 1)] = +m[1] * 1024;
  }
  return usage;
}

const GROUPS = [
  { key: 'home', name: 'Your files', sub: 'Your home folder. Dig into it on the Disk page.' },
  { key: 'others', name: 'Other accounts', sub: 'Part of what macOS calls Other Users & Shared.' },
  { key: 'shared', name: 'Shared folder', sub: 'Part of what macOS calls Other Users & Shared.' },
  { key: 'apps', name: 'Applications', sub: 'Everything in your Applications folder.' },
  { key: 'assets', name: 'Apple downloads', sub: 'Simulators, voices, language models and more that macOS fetched. Usually counted as System Data.' },
  { key: 'library', name: 'App support for everyone', sub: 'The Library at the top of the disk. Usually counted as System Data.' },
  { key: 'work', name: 'macOS working files', sub: 'Temp files, logs, indexes and the sleep image. Usually counted as System Data.' },
  { key: 'tools', name: 'Command-line tools', sub: 'Homebrew and other tools outside your home folder.' },
];

function groupOf(rel, me) {
  const [top, second] = rel.split('/');
  if (top === 'Users') return second === me ? 'home' : second === 'Shared' ? 'shared' : 'others';
  if (top === 'Applications') return 'apps';
  if (top === 'System') return 'assets';
  if (top === 'Library') return 'library';
  if (top === 'opt' || top === 'usr') return 'tools';
  return 'work';
}

// Your own scan can't enter closed folders, so the admin look wins wherever it saw more.
function mergeUsage(mine, deep) {
  const merged = { ...mine };
  for (const [k, v] of Object.entries(deep || {})) merged[k] = Math.max(merged[k] || 0, v);
  return merged;
}

// Chips that tell someone something: no raw folder ids, and no lone chip repeating the row's own total.
function namedParts(list, total) {
  const named = list.filter((p) => p.size >= 0.05 * GB && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(p.name)).sort((a, b) => b.size - a.size);
  return named.length === 1 && named[0].size >= 0.9 * total ? [] : named.slice(0, 5);
}

// Adds the disk up from the top: what the volumes say is used, less everything Grub could measure.
// Whatever's left stays on screen as unseen, so the rows always add up to the real total.
function ledger({ container, usage, deep, me, accounts }) {
  const merged = mergeUsage(usage, deep);
  const sums = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  const parts = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  const keys = Object.keys(merged).filter((k) => k);
  const tops = keys.filter((k) => !k.includes('/'));
  const expanded = new Set(['Users', 'System']); // their children belong to different rows, or only some count
  for (const top of tops) {
    if (expanded.has(top)) continue;
    const key = groupOf(top, me);
    sums[key] += merged[top];
    parts[key].push(...keys.filter((k) => k.startsWith(top + '/')).map((k) => ({ name: path.basename(k), size: merged[k] })));
    if (key === 'work' && !keys.some((k) => k.startsWith(top + '/'))) parts[key].push({ name: top, size: merged[top] });
  }
  for (const k of keys.filter((x) => x.startsWith('Users/') && x.split('/').length === 2)) {
    const key = groupOf(k, me);
    // without the admin look this is only the open corners of a closed folder, and would read as a real size
    if (key === 'others' && !(deep && k in deep)) continue;
    sums[key] += merged[k];
    if (key === 'others') parts.others.push({ name: path.basename(k), size: merged[k] });
  }
  for (const k of keys.filter((x) => x.startsWith('System/'))) {
    sums.assets += merged[k];
    parts.assets.push({ name: path.basename(k), size: merged[k] });
  }
  const dataUsed = container.data;
  const seen = Object.values(sums).reduce((n, v) => n + v, 0);
  const closed = accounts.filter((a) => !(deep && `Users/${a}` in deep));
  return {
    total: container.total,
    free: container.free,
    used: container.total - container.free,
    system: container.total - container.free - dataUsed,
    groups: GROUPS.map((g) => ({ ...g, size: sums[g.key], parts: namedParts(parts[g.key], sums[g.key]) })).filter((g) => g.size > 0),
    unseen: Math.max(0, dataUsed - seen),
    closedAccounts: closed,
    looked: !!deep,
  };
}

function runtimeRows(runtimes, devices) {
  const booted = new Map();
  for (const [rt, list] of Object.entries(devices || {}))
    for (const d of list) if (d.state === 'Booted') booted.set(rt, [...(booted.get(rt) || []), d.name]);
  return Object.values(runtimes || {}).map((r) => {
    const platform = (/SimRuntime\.([A-Za-z]+)-/.exec(r.runtimeIdentifier || '') || [])[1] || 'Simulator';
    const running = booted.get(r.runtimeIdentifier);
    return {
      id: 'runtime:' + r.identifier,
      kind: 'runtime',
      identifier: r.identifier,
      runtime: r.runtimeIdentifier,
      group: 'clear',
      name: `${platform} ${r.version || ''} simulator`.replace(/\s+/g, ' '),
      sub: 'Xcode can download it again.',
      lastUsed: r.lastUsedAt || null,
      bytes: r.sizeBytes || 0,
      blocked: running ? `${running[0]} is running on it` : r.deletable === false ? 'macOS says this one has to stay' : null,
    };
  });
}

// Paths worth naming that hold real things: Grub shows them, and the person decides in the app that owns them.
const REVIEW = (home) => [
  { id: 'docker', name: 'Docker', sub: 'Images and containers. Clear them from Docker itself.', path: `${home}/Library/Containers/com.docker.docker/Data/vms` },
  { id: 'utm', name: 'UTM virtual machines', sub: 'Whole computers saved as files. Delete the ones you’re done with inside UTM.', path: `${home}/Library/Containers/com.utmapp.UTM` },
  { id: 'parallels', name: 'Parallels virtual machines', sub: 'Whole computers saved as files. Delete the ones you’re done with inside Parallels.', path: `${home}/Parallels` },
  { id: 'claude-vm', name: 'Claude’s virtual machine', sub: 'What Claude runs tasks in. Claude needs it for those tasks.', path: `${home}/Library/Application Support/Claude/vm_bundles` },
  { id: 'ollama', name: 'Ollama models', sub: 'Local AI models. Remove the ones you don’t use with Ollama.', path: `${home}/.ollama/models` },
  { id: 'lmstudio', name: 'LM Studio models', sub: 'Local AI models. Remove the ones you don’t use inside LM Studio.', path: `${home}/.lmstudio/models` },
  { id: 'huggingface', name: 'Hugging Face models', sub: 'Models your code downloaded. They come back the next time they’re needed.', path: `${home}/.cache/huggingface` },
  { id: 'chrome-ai', name: 'Chrome’s on-device AI', sub: 'Turn it off in Chrome’s settings, or Chrome fetches it again.', path: `${home}/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel` },
  { id: 'backups', name: 'iPhone and iPad backups', sub: 'They may be your only copy. Manage them in Finder, with the device plugged in.', path: `${home}/Library/Application Support/MobileSync/Backup` },
  { id: 'sim-devices', name: 'Simulator devices', sub: 'Apps and data inside each simulator. Erase them from Xcode’s Devices window.', path: `${home}/Library/Developer/CoreSimulator/Devices` },
  { id: 'device-support', name: 'Xcode device support', sub: 'Xcode rebuilds this when you plug in a device.', path: `${home}/Library/Developer/Xcode/iOS DeviceSupport` },
  { id: 'archives', name: 'Xcode archives', sub: 'Builds you shipped. You need them to read crash reports for those versions.', path: `${home}/Library/Developer/Xcode/Archives` },
];

function createStorage({ run, admin, trash, home, uid, accounts }) {
  const me = path.basename(home);
  let items = new Map(); // what was last offered; clearing only ever acts on these

  async function plist(cmd) {
    const r = await run('/bin/sh', ['-c', `${cmd} | /usr/bin/plutil -convert json -o - -`], { timeout: 60000 });
    return JSON.parse(r.stdout);
  }

  async function readContainer() {
    const info = await plist(`/usr/sbin/diskutil info -plist ${DATA}`);
    const { Containers } = await plist('/usr/sbin/diskutil apfs list -plist');
    const c = Containers.find((x) => x.Volumes.some((v) => v.DeviceIdentifier === info.DeviceIdentifier));
    const v = c.Volumes.find((x) => x.DeviceIdentifier === info.DeviceIdentifier);
    return { total: c.CapacityCeiling, free: c.CapacityFree, data: v.CapacityInUse, vm: c.Volumes.find((x) => x.Roles?.includes('VM'))?.CapacityInUse || 0 };
  }

  // xcrun with no developer tools opens Apple's install dialog, so ask xcode-select first.
  async function simctl(...args) {
    if ((await run('/usr/bin/xcode-select', ['-p'])).err) return null;
    const r = await run('/usr/bin/xcrun', ['simctl', ...args], { timeout: 60000 });
    if (r.err) return null;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  }

  const bootedDevices = async () => (await simctl('list', 'devices', '-j'))?.devices || {};
  const anyBooted = (devices) => Object.values(devices).flat().filter((d) => d.state === 'Booted').map((d) => d.name);

  async function sizeOf(p) {
    if (!fs.existsSync(p)) return 0;
    const r = await run('/usr/bin/du', ['-sk', '-x', p], { timeout: 120000 });
    return (parseInt(r.stdout, 10) || 0) * 1024;
  }

  // Anything written in the last day counts as in use, however old the folder itself looks.
  async function idle(p) {
    const r = await run('/usr/bin/find', [p, '-mmin', '-1440', '-print', '-quit'], { timeout: 60000 });
    return !r.stdout.trim();
  }

  function yours(p) {
    try {
      const s = fs.lstatSync(p);
      return !s.isSymbolicLink() && s.uid === uid;
    } catch {
      return false;
    }
  }

  // Big folders in /tmp, one level deep so a shared parent doesn't hide the idle folder inside it.
  async function tempRows() {
    const r = await run('/usr/bin/du', ['-k', '-d', '2', '-x', '/private/tmp'], { timeout: 120000 });
    const rows = [];
    const found = r.stdout.split('\n').map((l) => /^(\d+)\t(.+)$/.exec(l)).filter(Boolean).map((m) => ({ path: m[2], bytes: +m[1] * 1024 }));
    const big = found.filter((f) => f.path !== '/private/tmp' && f.bytes >= TMP_MIN);
    for (const f of big) {
      if (big.some((o) => o.path.startsWith(f.path + '/')) || !yours(f.path)) continue;
      rows.push({
        id: 'temp:' + f.path,
        kind: 'temp',
        group: 'clear',
        name: path.basename(f.path),
        sub: 'A temporary folder. Goes to the Trash, so empty it to get the space back.',
        path: f.path,
        bytes: f.bytes,
        blocked: (await idle(f.path)) ? null : 'something wrote to it in the last day',
      });
    }
    return rows;
  }

  async function snapshotRow() {
    const r = await run('/usr/bin/tmutil', ['listlocalsnapshots', '/'], { timeout: 30000 });
    const n = r.stdout.split('\n').filter((l) => /com\.apple\.TimeMachine\./.test(l)).length;
    if (!n) return [];
    return [{
      id: 'snapshots',
      kind: 'snapshots',
      group: 'clear',
      name: 'Time Machine snapshots',
      sub: `${n} ${n === 1 ? 'restore point' : 'restore points'} on this Mac. Backups on your backup disk stay. macOS doesn’t say how much these hold.`,
      bytes: null,
      admin: true,
    }];
  }

  async function findings(usage, container) {
    const list = await simctl('runtime', 'list', '-j');
    const devices = await bootedDevices();
    const rows = runtimeRows(list, devices);
    const running = anyBooted(devices);
    const cache = await sizeOf(SIM_CACHE);
    if (cache >= REVIEW_MIN)
      rows.push({
        id: 'sim-cache',
        kind: 'sim-cache',
        group: 'clear',
        name: 'Simulator caches',
        sub: 'Rebuilt the next time a simulator starts, which makes that start slower.',
        bytes: cache,
        admin: true,
        blocked: running.length ? `${running[0]} is running` : null,
      });
    rows.push(...(await snapshotRow()), ...(await tempRows()));
    for (const r of REVIEW(home)) {
      const bytes = await sizeOf(r.path);
      if (bytes >= REVIEW_MIN) rows.push({ ...r, kind: 'review', group: 'review', bytes });
    }
    const keep = [
      { id: 'swap', name: 'Swap files', sub: 'Memory macOS moved to disk. It shrinks by itself after a restart.', bytes: container.vm },
      { id: 'spotlight', name: 'Spotlight index', sub: 'What makes search work. Removing it only starts a long rebuild.', bytes: usage['.Spotlight-V100'] || 0 },
      { id: 'sleep', name: 'Sleep image', sub: 'What your Mac needs to wake up with your work intact.', bytes: sleepImage() },
    ];
    rows.push(...keep.filter((k) => k.bytes > 0).map((k) => ({ ...k, kind: 'keep', group: 'keep' })));
    return rows;
  }

  function sleepImage() {
    try {
      return fs.statSync('/private/var/vm/sleepimage').blocks * 512;
    } catch {
      return 0;
    }
  }

  async function scan(deep) {
    try {
      const container = await readContainer();
      const r = await run('/usr/bin/du', ['-k', '-d', '2', '-x', DATA], { timeout: 480000 });
      if (r.err?.killed) return { ok: false, error: 'Measuring took too long. Try again when your Mac is less busy.' };
      const usage = parseUsage(r.stdout);
      const fresh = deep && Date.now() - deep.at < DEEP_MAX_AGE ? deep : null;
      const merged = mergeUsage(usage, fresh?.usage);
      const rows = await findings(merged, container);
      items = new Map(rows.map((i) => [i.id, i]));
      return {
        ok: true,
        data: {
          ...ledger({ container, usage, deep: fresh?.usage, me, accounts: accounts() }),
          lookedAt: fresh?.at || null,
          items: rows,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Remembered scans still offer rows after a restart, so the page's list counts as what was offered.
  function remember(rows) {
    items = new Map((rows || []).map((i) => [i.id, i]));
  }

  // Every safety check runs again here: minutes can pass between the scan and the click.
  async function clear(id) {
    const item = items.get(id);
    if (!item || item.group !== 'clear') return { ok: false, error: 'Grub doesn’t know that one. Measure again and retry.' };
    if (item.kind === 'runtime') {
      const running = (await bootedDevices())[item.runtime]?.filter((d) => d.state === 'Booted') || [];
      if (running.length) return { ok: false, error: `${running[0].name} is running on this simulator. Shut it down first.` };
      const r = await run('/usr/bin/xcrun', ['simctl', 'runtime', 'delete', item.identifier], { timeout: 300000 });
      if (r.err) return { ok: false, error: r.stderr.trim() || r.err.message };
    } else if (item.kind === 'sim-cache') {
      const running = anyBooted(await bootedDevices());
      if (running.length) return { ok: false, error: `${running[0]} is running. Shut it down first.` };
      if (fs.lstatSync(SIM_CACHE).isSymbolicLink()) return { ok: false, error: 'This folder isn’t what Grub expected, so it left it alone.' };
      const r = await admin(`/bin/rm -rf ${SIM_CACHE}`, 'Grub wants to remove the simulator caches. They’re rebuilt when a simulator next starts.');
      if (!r.ok) return r;
    } else if (item.kind === 'snapshots') {
      const r = await admin('/usr/bin/tmutil deletelocalsnapshots /', 'Grub wants to remove the Time Machine restore points on this Mac. Backups on your backup disk stay.');
      if (!r.ok) return r;
    } else if (item.kind === 'temp') {
      if (!yours(item.path)) return { ok: false, error: 'This folder isn’t what Grub expected, so it left it alone.' };
      if (!(await idle(item.path))) return { ok: false, error: 'Something wrote to this folder in the last day, so Grub left it alone.' };
      try {
        await trash(item.path);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    } else return { ok: false, error: 'Grub doesn’t know how to clear that one.' };
    items.delete(id);
    return { ok: true };
  }

  return { scan, clear, remember };
}

module.exports = { createStorage, parseUsage, ledger, runtimeRows, mergeUsage };
