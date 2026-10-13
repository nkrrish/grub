// Checks that the pinned Mole still says what Grub expects: the JSON fields Grub reads, the lines its parsers
// look for, and that this copy won't update or remove itself. Run it after `--bump`, before shipping a new Mole.
// Everything here is read-only: dry runs, listings and status. Uses Grub's own parsers from src/schedule.js.
//
//   npm run mole:check                          the vendor/ copy for this Mac
//   npm run mole:check -- x64                   the Intel copy (needs Rosetta)
//   npm run mole:check -- --app out/Grub-darwin-arm64/Grub.app    the signed copy inside a build
//   npm run mole:check -- --quick               skip the slow dry runs of clean, optimize and purge
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readMole, toLines, field } = require('../src/schedule');

const root = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'mole.lock.json'), 'utf8'));
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const appAt = args.includes('--app') ? args[args.indexOf('--app') + 1] : null;
const arch = args.find((a) => a === 'arm64' || a === 'x64') || process.arch;
const MOLE = appAt ? path.resolve(appAt, 'Contents/Resources/mole/mole') : path.join(root, 'vendor/mole', arch, 'mole/mole');
const HOME = os.homedir();
// the same environment Grub gives Mole
const ENV = { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };
const NO_AUTH = { NO_COLOR: '1', MOLE_TEST_NO_AUTH: '1' };

function run(argv, { env = {}, timeout = 120000, firstLine = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(MOLE, argv, { cwd: HOME, env: { ...ENV, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const stop = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    };
    const t = setTimeout(stop, timeout);
    child.stdout.on('data', (d) => {
      out += d;
      if (firstLine && out.includes('\n')) stop();
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

const json = (s) => JSON.parse(s.slice(s.search(/[[{]/)));
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}${note ? `: ${note}` : ''} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function has(obj, keys, where) {
  for (const k of keys) expect(obj && k in obj, `${where} has no "${k}"`);
}

(async () => {
  if (!fs.existsSync(MOLE)) {
    console.error(`No Mole at ${path.relative(root, MOLE)}. Run: node scripts/fetch-mole.js ${arch}`);
    process.exit(1);
  }
  console.log(`Checking Mole ${lock.version} at ${path.relative(root, MOLE) || MOLE}\n`);

  await check('version', async () => {
    const r = await run(['--version']);
    expect(r.code === 0, `exit ${r.code}`);
    expect(r.out.includes(lock.version), `says "${r.out.split('\n')[0]}", pinned ${lock.version}`);
    expect(/Install:\s*Grub/.test(r.out), 'doesn’t report itself as installed by Grub');
    return (r.out.match(/\d+\.\d+\.\d+/) || [])[0];
  });

  await check('refuses to update itself', async () => {
    const r = await run(['update'], { env: { NO_COLOR: '1' }, timeout: 20000 });
    expect(r.code !== 0 && /comes with Grub/.test(r.out + r.err), `exit ${r.code}: ${(r.out + r.err).trim().slice(0, 200)}`);
  });

  await check('refuses to remove itself', async () => {
    const r = await run(['remove', '--dry-run'], { env: { NO_COLOR: '1' }, timeout: 20000 });
    expect(r.code !== 0 && /comes with Grub/.test(r.out + r.err), `exit ${r.code}: ${(r.out + r.err).trim().slice(0, 200)}`);
  });

  await check('help lists the commands Grub runs', async () => {
    const r = await run(['--help'], { env: { NO_COLOR: '1' } });
    for (const c of ['clean', 'optimize', 'purge', 'installer', 'uninstall', 'analyze', 'status', 'history']) expect(new RegExp(`\\b${c}\\b`).test(r.out), `no "${c}"`);
  });

  // main.js: tray title, low-space and swap alerts; the window reads more, but these must never go missing
  await check('status --watch (JSON lines)', async () => {
    const r = await run(['status', '--watch', '--interval', '1s'], { firstLine: true, timeout: 30000 });
    const s = json(r.out.split('\n')[0]);
    has(s, ['cpu', 'memory', 'disks', 'hardware', 'health_score', 'uptime', 'network', 'trash_size'], 'status');
    has(s.cpu, ['usage'], 'status.cpu');
    has(s.memory, ['used_percent', 'swap_used', 'used', 'total'], 'status.memory');
    const disk = s.disks.find((d) => d.mount === '/');
    expect(disk, 'no disk mounted at /');
    has(disk, ['total', 'used', 'used_percent'], 'the / disk');
    return `CPU ${Math.round(s.cpu.usage)}%, ${((disk.total - disk.used) / 1e9).toFixed(1)} GB free`;
  });

  await check('analyze --json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grub-mole-check-'));
    fs.mkdirSync(path.join(dir, 'folder'));
    fs.writeFileSync(path.join(dir, 'folder/file.bin'), Buffer.alloc(2e6));
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x'.repeat(5000));
    try {
      const r = await run(['analyze', '--json', dir], { timeout: 60000 });
      const d = json(r.out);
      expect(Array.isArray(d.entries) && d.entries.length >= 2, 'no entries');
      for (const e of d.entries) has(e, ['name', 'path', 'size', 'is_dir'], 'an entry');
      expect(d.entries.find((e) => e.name === 'folder')?.is_dir === true, 'the folder isn’t marked is_dir');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('uninstall --list', async () => {
    const r = await run(['uninstall', '--list'], { timeout: 120000 });
    const apps = json(r.out);
    expect(Array.isArray(apps) && apps.length, 'no apps listed');
    for (const a of apps.slice(0, 20)) has(a, ['name', 'path', 'size', 'uninstall_name'], 'an app');
    return `${apps.length} apps`;
  });

  await check('history --json', async () => {
    const r = await run(['history', '--json']);
    const h = json(r.out);
    expect(Array.isArray(h.sessions), 'no sessions list');
    for (const s of h.sessions.slice(0, 5)) has(s, ['started_at', 'items'], 'a session');
    return `${h.sessions.length} sessions`;
  });

  if (!quick) {
    // schedule.js and sweep.js read these screens; clean also has to write the list the big clean reads
    await check('clean --dry-run', async () => {
      const list = path.join(HOME, '.config/mole/clean-list.txt');
      const before = fs.existsSync(list) ? fs.statSync(list).mtimeMs : 0;
      const r = await run(['clean', '--dry-run'], { env: NO_AUTH, timeout: 30 * 60e3 });
      expect(r.code === 0, `exit ${r.code}`);
      const { sections, summary } = readMole(toLines(r.out + r.err));
      expect(sections.length, 'no ➤ sections');
      const found = field(summary, /Potential space:\s*(?:At least\s+)?([\d.]+\s?[KMGT]?B)/i);
      expect(found, `no "Potential space:" in the summary: ${summary.join(' | ').slice(0, 200)}`);
      expect(field(summary, /Items:\s*(\d+)/i), 'no "Items:" in the summary');
      expect(fs.existsSync(list) && fs.statSync(list).mtimeMs > before, 'didn’t rewrite clean-list.txt');
      expect(/^===\s*.+?\s*===$/m.test(fs.readFileSync(list, 'utf8')), 'clean-list.txt has no === section === heads');
      return `${found[1]} found`;
    });

    await check('optimize --dry-run', async () => {
      const r = await run(['optimize', '--dry-run'], { env: NO_AUTH, timeout: 10 * 60e3 });
      const { summary } = readMole(toLines(r.out + r.err));
      const would = field(summary, /(?:Would apply|Applied)\s+(\d+)\s+optimi[sz]ations?/i);
      expect(would, `no "Would apply N optimizations" in the summary: ${summary.join(' | ').slice(0, 200)}`);
      return `${would[1]} optimizations`;
    });

    await check('purge --dry-run', async () => {
      const r = await run(['purge', '--dry-run'], { env: { NO_COLOR: '1' }, timeout: 10 * 60e3 });
      expect(r.code === 0, `exit ${r.code}`);
      const lines = toLines(r.out + r.err);
      const items = lines.filter((l) => /^\s*✓\s+\[DRY RUN\]\s+(.+),\s+([\d.]+\s?[KMGT]?B)\s*$/.test(l));
      // an empty result is fine; Mole saying something Grub doesn't recognise is not
      expect(items.length || /nothing|no .*found|clean/i.test(lines.join('\n')), `nothing Grub recognises: ${lines.slice(-3).join(' | ')}`);
      return `${items.length} build folders`;
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed. Don't ship this Mole until Grub handles it.` : `\nAll ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})();
