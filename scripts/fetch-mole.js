// Puts the pinned Mole into vendor/mole/<arch>/mole, which ships inside Grub.app as Contents/Resources/mole.
// mole.lock.json names the version and the SHA-256 of every file; anything that doesn't match is refused.
// Downloads are kept in vendor/cache, so after the first run this works offline and takes a moment.
//
//   node scripts/fetch-mole.js              this Mac's arch (what `npm start` needs)
//   node scripts/fetch-mole.js arm64 x64    both, for a release build
//   node scripts/fetch-mole.js --bump 1.60.0
//       pins a newer Mole in mole.lock.json. Then run `npm run mole:check` and read Mole's changes
//       before shipping it: Grub reads Mole's output, so a new Mole is only safe once Grub agrees with it.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const LOCK = path.join(root, 'mole.lock.json');
const VENDOR = path.join(root, 'vendor/mole');
const CACHE = path.join(root, 'vendor/cache');
const REPO = 'tw93/Mole';
const GO_ARCH = { arm64: 'arm64', x64: 'amd64' };

/* Grub's changes to Mole. This copy is replaced only by a Grub update, so Mole must never update itself,
   remove itself, or tell people to run `mo update`. Mole already does all of this for Nix installs, so each
   change sits next to that check. Every anchor must match exactly once: when a new Mole moves one, this
   stops and says so, rather than shipping a Mole that nags or rewrites itself inside a signed app. */
const PATCHES = [
  {
    file: 'lib/manage/update.sh',
    find: 'is_nix_install() {\n    [[ "${SCRIPT_DIR:-}" == /nix/store/* ]]\n}\n',
    add: 'after',
    text: '\n# Grub: this copy ships inside Grub.app and is replaced only when Grub updates.\nis_grub_bundle() {\n    return 0\n}\n',
  },
  {
    file: 'lib/manage/update.sh',
    find: '    local msg_cache="$1" message=""\n    is_nix_install && return 0\n',
    add: 'after',
    text: '    is_grub_bundle && return 0 # Grub: no update notices\n',
  },
  {
    file: 'lib/manage/update.sh',
    find: 'checked=0 interval=0\n    is_nix_install && return 0\n',
    add: 'after',
    text: '    is_grub_bundle && return 0 # Grub: no update checks\n',
  },
  {
    file: 'lib/manage/update.sh',
    find: '    local install_method="Manual"\n    if is_nix_install; then\n',
    replace: '    local install_method="Manual"\n    if is_grub_bundle; then # Grub\n        install_method="Grub"\n    elif is_nix_install; then\n',
  },
  {
    file: 'lib/manage/update.sh',
    find: '    if is_nix_install; then\n        local review_icon="${ICON_REVIEW:-⊙}"\n        log_error "Mole was installed via Nix. Self-update is disabled."\n',
    add: 'before',
    text: '    if is_grub_bundle; then # Grub\n        log_error "This Mole comes with Grub and updates when Grub does."\n        exit 1\n    fi\n\n',
  },
  {
    file: 'lib/manage/remove.sh',
    find: '    if declare -f is_nix_install > /dev/null 2>&1 && is_nix_install; then\n',
    add: 'before',
    text: '    if declare -f is_grub_bundle > /dev/null 2>&1 && is_grub_bundle; then # Grub\n        log_error "This Mole comes with Grub. It goes when Grub goes."\n        exit 1\n    fi\n\n',
  },
];

// GPL-3.0 section 5(a): a modified copy says what changed and when.
const CHANGES = (lock) => `This is Mole ${lock.version} (https://github.com/${REPO}/tree/${lock.tag}) by tw93, as shipped inside Grub.
Mole is licensed under GPL-3.0-or-later; see LICENSE. Grub is not affiliated with Mole.

Grub changed lib/manage/update.sh and lib/manage/remove.sh so this copy never checks for updates,
never updates or removes itself, and reports itself as installed by Grub. Every change is marked
"# Grub". Nothing else is changed. analyze-go and status-go are Mole's own release builds,
re-signed with Grub's Developer ID.

Source: https://github.com/${REPO}/archive/refs/tags/${lock.tag}.tar.gz
Each Grub release also carries the exact Mole source it ships.
`;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readLock = () => JSON.parse(fs.readFileSync(LOCK, 'utf8'));

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

// The cached copy if it's the pinned one, otherwise a fresh download that must match.
async function pinned({ file, url, sha256: want }) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && sha256(dest) === want) return dest;
  console.log(`  downloading ${file}`);
  await download(url, dest);
  const got = sha256(dest);
  if (got !== want) {
    fs.rmSync(dest);
    throw new Error(`${file} doesn't match mole.lock.json.\n  expected ${want}\n  got      ${got}`);
  }
  return dest;
}

function applyPatches(dir) {
  for (const p of PATCHES) {
    const file = path.join(dir, p.file);
    const text = fs.readFileSync(file, 'utf8');
    const hits = text.split(p.find).length - 1;
    if (hits !== 1) throw new Error(`Grub's change to ${p.file} expected its anchor once, found it ${hits} times:\n${p.find}\nUpdate PATCHES in scripts/fetch-mole.js for this Mole.`);
    const next = p.replace ?? (p.add === 'after' ? p.find + p.text : p.text + p.find);
    fs.writeFileSync(file, text.replace(p.find, () => next));
  }
}

// A stamp of everything that decides the result, so an unchanged pin skips the work.
const stampFor = (lock, arch) =>
  crypto.createHash('sha256').update(JSON.stringify([lock.source, lock.binaries[arch]])).update(fs.readFileSync(__filename)).digest('hex');

async function assemble(arch) {
  const lock = readLock();
  if (!lock.binaries[arch]) throw new Error(`mole.lock.json has no binaries for ${arch}.`);
  const base = path.join(VENDOR, arch);
  const out = path.join(base, 'mole');
  const stampFile = path.join(base, 'stamp');
  const stamp = stampFor(lock, arch);
  if (fs.existsSync(path.join(out, 'mole')) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) {
    console.log(`Mole ${lock.version} (${arch}) is ready.`);
    return out;
  }
  console.log(`Mole ${lock.version} (${arch}):`);

  const tarball = await pinned(lock.source);
  const goBins = { analyze: await pinned(lock.binaries[arch].analyze), status: await pinned(lock.binaries[arch].status) };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grub-mole-'));
  try {
    execFileSync('/usr/bin/tar', ['-xzf', tarball, '-C', tmp]);
    const [top] = fs.readdirSync(tmp);
    const src = path.join(tmp, top);

    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'bin'), { recursive: true });
    // The same files Homebrew installs: the entry script, the subcommand scripts, the library, and the license.
    fs.copyFileSync(path.join(src, 'mole'), path.join(out, 'mole'));
    for (const f of fs.readdirSync(path.join(src, 'bin')).filter((f) => f.endsWith('.sh'))) fs.copyFileSync(path.join(src, 'bin', f), path.join(out, 'bin', f));
    fs.cpSync(path.join(src, 'lib'), path.join(out, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE'));
    fs.copyFileSync(goBins.analyze, path.join(out, 'bin/analyze-go'));
    fs.copyFileSync(goBins.status, path.join(out, 'bin/status-go'));
    applyPatches(out);
    fs.writeFileSync(path.join(out, 'CHANGES-BY-GRUB.txt'), CHANGES(lock));
    execFileSync('/bin/chmod', ['-R', 'u+rwX,go+rX,go-w', out]);
    execFileSync('/bin/chmod', ['755', path.join(out, 'mole'), ...['analyze-go', 'status-go'].map((b) => path.join(out, 'bin', b)), ...fs.readdirSync(path.join(out, 'bin')).filter((f) => f.endsWith('.sh')).map((f) => path.join(out, 'bin', f))]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // A quick run when this Mac can: the entry script finds its library and reports the pinned version.
  if (arch === process.arch) {
    const v = execFileSync(path.join(out, 'mole'), ['--version'], { cwd: os.homedir(), encoding: 'utf8' });
    if (!v.includes(lock.version)) throw new Error(`The assembled Mole says:\n${v}\nbut mole.lock.json pins ${lock.version}.`);
  }
  fs.writeFileSync(stampFile, stamp);
  console.log(`  ready at ${path.relative(root, out)}`);
  return out;
}

async function bump(version) {
  const v = version.replace(/^v/i, '');
  const release = await (await fetch(`https://api.github.com/repos/${REPO}/releases/tags/V${v}`)).json();
  if (!release.assets) throw new Error(`No Mole release V${v} on GitHub.`);
  const asset = (name) => {
    const a = release.assets.find((x) => x.name === name);
    if (!a?.digest?.startsWith('sha256:')) throw new Error(`Release V${v} has no ${name} with a SHA-256.`);
    return { file: name, url: a.browser_download_url, sha256: a.digest.slice(7) };
  };
  const source = { file: `Mole-${v}.tar.gz`, url: `https://github.com/${REPO}/archive/refs/tags/V${v}.tar.gz` };
  // GitHub doesn't publish a digest for tag archives, so it's measured here. Homebrew's formula pins the
  // same archive; compare against it before trusting the new number.
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, source.file);
  await download(source.url, dest);
  source.sha256 = sha256(dest);
  const old = readLock();
  const lock = {
    version: v,
    tag: `V${v}`,
    source,
    binaries: Object.fromEntries(
      Object.entries(GO_ARCH).map(([arch, go]) => [arch, { analyze: asset(`analyze-darwin-${go}`), status: asset(`status-darwin-${go}`) }])
    ),
  };
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  console.log(`Pinned Mole ${v} (was ${old.version}).
  source sha256 ${source.sha256}
  should match the sha256 in Homebrew's formula once it has ${v}: https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/m/mole.rb

Before shipping it:
  1. Read what changed: https://github.com/${REPO}/compare/${old.tag}...V${v}
  2. npm run mole:check
`);
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--bump') {
    if (!args[1]) throw new Error('Usage: node scripts/fetch-mole.js --bump <version>');
    await bump(args[1]);
    args.splice(0, 2);
  }
  for (const arch of args.length ? args : [process.arch]) await assemble(arch);
})().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
