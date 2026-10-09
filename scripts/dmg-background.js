// Renders build/dmg/background.html to build/dmg/background@2x.png (1320x840) and background.png (660x420)
// with Electron, then combines them into background.tiff for a sharp DMG window on Retina screens.
// Run with: npx electron scripts/dmg-background.js
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const dir = path.join(__dirname, '..', 'build', 'dmg');

async function render(scale) {
  const win = new BrowserWindow({ show: false, width: 660 * scale, height: 420 * scale, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(dir, 'background.html'), { query: { scale: String(scale) } });
  for (let i = 0; i < 80 && win.getTitle() !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 660 * scale, height: 420 * scale });
  const file = path.join(dir, 'background@2x.png');
  fs.writeFileSync(file, image.resize({ width: 660 * scale, height: 420 * scale }).toPNG());
  win.destroy();
  return file;
}

app.whenReady().then(async () => {
  app.dock?.hide();
  // Render once at Retina size, then scale down for the 1x version.
  const two = await render(2);
  const one = path.join(dir, 'background.png');
  execFileSync('sips', ['-z', '420', '660', two, '--out', one], { stdio: 'ignore' });
  execFileSync('tiffutil', ['-cathidpicheck', one, two, '-out', path.join(dir, 'background.tiff')]);
  console.log('wrote', path.relative(process.cwd(), path.join(dir, 'background.tiff')));
  app.quit();
});
