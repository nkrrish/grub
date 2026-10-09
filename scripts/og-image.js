// Renders build/og/og.html to docs/og.png, the 1200x630 social share image for grub.attechy.com.
// Drawn at 2x and scaled down for clean edges. Run with: npx electron scripts/og-image.js
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');

app.whenReady().then(async () => {
  app.dock?.hide();
  const win = new BrowserWindow({ show: false, width: 2400, height: 1260, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(root, 'build/og/og.html'), { query: { scale: '2' } });
  for (let i = 0; i < 80 && win.getTitle() !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 2400, height: 1260 });
  const big = path.join(root, 'build/og/og@2x.png');
  fs.writeFileSync(big, image.resize({ width: 2400, height: 1260 }).toPNG());
  execFileSync('sips', ['-z', '630', '1200', big, '--out', path.join(root, 'docs/og.png')], { stdio: 'ignore' });
  console.log('wrote docs/og.png');
  app.quit();
});
