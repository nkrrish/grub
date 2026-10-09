// Renders build/og/og.html into Grub's share images, drawn at 2x and scaled down for clean edges:
//   docs/og.png                 1200x630, the website's Open Graph image
//   brand/github-social.png     1280x640, upload in GitHub: Settings > General > Social preview
// Run with: npx electron scripts/og-image.js
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const TARGETS = [
  { w: 1200, h: 630, out: 'docs/og.png' },
  { w: 1280, h: 640, out: 'brand/github-social.png' },
];

// One window for every render: a second BrowserWindow in the same run fails to load the file.
async function render(win, { w, h, out }) {
  win.setContentSize(w * 2, h * 2);
  await win.loadFile(path.join(root, 'build/og/og.html'), { query: { scale: '2', w: String(w), h: String(h) } });
  for (let i = 0; i < 80 && win.getTitle() !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
  // Offscreen frames lag the canvas (Electron 42+): wait for two painted frames before capturing.
  await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: w * 2, height: h * 2 });
  const big = path.join(root, 'build/og/render@2x.png');
  fs.writeFileSync(big, image.resize({ width: w * 2, height: h * 2 }).toPNG());
  execFileSync('sips', ['-z', String(h), String(w), big, '--out', path.join(root, out)], { stdio: 'ignore' });
  fs.rmSync(big);
  console.log('wrote', out);
}

app.whenReady().then(async () => {
  app.dock?.hide();
  const win = new BrowserWindow({ show: false, width: 2560, height: 1280, useContentSize: true, webPreferences: { offscreen: true } });
  for (const t of TARGETS) await render(win, t);
  app.quit();
});
