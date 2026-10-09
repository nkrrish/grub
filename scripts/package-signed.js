// Builds a universal Grub.app signed with Developer ID and the hardened runtime, ready for notarization.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { packager } = require('@electron/packager');
const { generateAssetCatalogForIcon } = require('@electron/packager/dist/icon-composer');

const root = path.join(__dirname, '..');
const identity = process.env.GRUB_SIGN_IDENTITY || 'Developer ID Application: Attechy Ltd (NY6MJC8WU5)';
const entitlements = path.join(root, 'build/entitlements.mac.plist');

let hasActool = true;
try { execSync('actool --version', { stdio: 'ignore' }); } catch { hasActool = false; }

(async () => {
  // actool output differs between runs, so letting packager compile the Icon Composer icon per arch
  // breaks the universal merge. Compile it once and ship the same Assets.car in both slices.
  const extraResource = [];
  const extendInfo = {
    NSAppleEventsUsageDescription: 'Grub reads your login items through System Events so it can list them under Startup items.',
  };
  if (hasActool) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grub-icon-'));
    fs.writeFileSync(path.join(dir, 'Assets.car'), await generateAssetCatalogForIcon(path.join(root, 'brand/Icon.icon')));
    extraResource.push(path.join(dir, 'Assets.car'));
    extendInfo.CFBundleIconName = 'Icon';
  }

  const paths = await packager({
    dir: root,
    name: 'Grub',
    platform: 'darwin',
    arch: 'universal',
    icon: path.join(root, 'build/icon.icns'),
    extraResource,
    out: path.join(root, 'out'),
    overwrite: true,
    appBundleId: 'com.attechy.grub',
    asar: { unpackDir: 'node_modules/node-pty' },
    ignore: [
      /^\/out/,
      /^\/docs/,
      /^\/wrangler\.jsonc$/,
      /^\/\.impeccable/,
      // DMG window artwork, only used when building the installer.
      /^\/build\/dmg/,
      /\.md$/,
      // Only mark.svg is used at runtime; the rest of brand/ is source artwork.
      /^\/brand\/(?!mark\.svg$)/,
      // node-pty ships Windows binaries and its C++ sources; the Mac app needs neither.
      /^\/node_modules\/node-pty\/(prebuilds\/win32-|deps|third_party|src|binding\.gyp)/,
    ],
    osxUniversal: { x64ArchFiles: '**/node_modules/node-pty/prebuilds/**' },
    extendInfo,
    osxSign: {
      identity,
      optionsForFile: (file) => (file.endsWith('Grub.app') ? { hardenedRuntime: true, entitlements } : { hardenedRuntime: true }),
    },
  });
  console.log(paths.join('\n'));
})().catch((err) => { console.error(err); process.exit(1); });
