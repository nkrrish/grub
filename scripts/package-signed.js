// Builds Grub.app twice, once for Apple Silicon (arm64) and once for Intel (x64), each signed with Developer ID
// and the hardened runtime, ready for notarization. Separate builds are about half the size of a universal one.
// Each carries the Mole pinned in mole.lock.json, built for its arch, as Contents/Resources/mole; its Go helpers
// are signed along with everything else.
// Output: out/Grub-darwin-arm64/Grub.app and out/Grub-darwin-x64/Grub.app. Pass an arch to build just one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

const root = path.join(__dirname, '..');
// Not in packager's public exports, so load the file by path.
const { generateAssetCatalogForIcon } = require(path.join(root, 'node_modules/@electron/packager/dist/icon-composer.js'));
const identity = process.env.GRUB_SIGN_IDENTITY || 'Developer ID Application: Attechy Ltd (NY6MJC8WU5)';
const entitlements = path.join(root, 'build/entitlements.mac.plist');
const ARCHES = process.argv[2] ? [process.argv[2]] : ['arm64', 'x64'];

// Checks every Mole file against mole.lock.json, and fetches whatever isn't cached yet.
execFileSync(process.execPath, [path.join(__dirname, 'fetch-mole.js'), ...ARCHES], { stdio: 'inherit' });

let hasActool = true;
try { execSync('actool --version', { stdio: 'ignore' }); } catch { hasActool = false; }

(async () => {
  // Compile the Icon Composer icon once and ship the same Assets.car in every build.
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

  for (const arch of ARCHES) {
    const other = arch === 'arm64' ? 'x64' : 'arm64';
    const paths = await packager({
      dir: root,
      name: 'Grub',
      platform: 'darwin',
      arch,
      icon: path.join(root, 'build/icon.icns'),
      extraResource: [...extraResource, path.join(root, 'vendor/mole', arch, 'mole')],
      out: path.join(root, 'out'),
      overwrite: true,
      appBundleId: 'com.attechy.grub',
      asar: { unpackDir: 'node_modules/node-pty' },
      ignore: [
        /^\/out/,
        // Mole goes in Resources (extraResource above), not in app.asar
        /^\/vendor/,
        /^\/mole\.lock\.json$/,
        /^\/docs/,
        /^\/scripts/,
        /^\/wrangler\.jsonc$/,
        /^\/\.impeccable/,
        // DMG window artwork and the website share image, never used by the app.
        /^\/build\/(dmg|og)/,
        /\.md$/,
        // Only mark.svg is used at runtime; the rest of brand/ is source artwork.
        /^\/brand\/(?!mark\.svg$)/,
        // node-pty ships Windows binaries, the other Mac arch's binary and its C++ sources; this build needs none.
        /^\/node_modules\/node-pty\/(prebuilds\/win32-|deps|third_party|src|binding\.gyp)/,
        new RegExp(`^/node_modules/node-pty/prebuilds/darwin-${other}`),
      ],
      extendInfo,
      osxSign: {
        identity,
        optionsForFile: (file) => (file.endsWith('Grub.app') ? { hardenedRuntime: true, entitlements } : { hardenedRuntime: true }),
      },
    });
    console.log(paths.join('\n'));
  }
})().catch((err) => { console.error(err); process.exit(1); });
