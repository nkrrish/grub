const $ = (sel) => document.querySelector(sel);

function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), units.length - 1);
  const v = n / 1000 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function mood(score) {
  if (score >= 85) return 'Fresh as dirt.';
  if (score >= 70) return 'Slightly whiffy.';
  if (score >= 50) return 'Starting to smell.';
  return 'Something died in here.';
}

function bar(id, v, hot) {
  const node = $(id);
  node.style.setProperty('--v', Math.max(0, Math.min(1, v)));
  if (hot !== undefined) node.classList.toggle('is-hot', hot);
}

function render(s) {
  const score = s.health_score ?? 0;
  const badge = $('#t-score');
  badge.textContent = score;
  badge.classList.toggle('is-meh', score < 70 && score >= 50);
  badge.classList.toggle('is-bad', score < 50);
  $('#t-title').textContent = mood(score);
  $('#t-sub').textContent = s.health_score_msg || s.hardware?.model || '';

  const disk = (s.disks || []).find((d) => d.mount === '/');
  if (disk) {
    $('#t-disk').textContent = `${bytes(disk.total - disk.used)} free`;
    bar('#t-disk-bar', disk.used_percent / 100, disk.used_percent >= 90);
  }
  const cpu = s.cpu?.usage ?? 0;
  $('#t-cpu').textContent = `${cpu.toFixed(0)}%`;
  bar('#t-cpu-bar', cpu / 100);
  const mem = s.memory?.used_percent ?? 0;
  $('#t-mem').textContent = `${mem.toFixed(0)}%`;
  bar('#t-mem-bar', mem / 100);

  const bat = s.batteries?.[0];
  $('#t-bat').textContent = bat ? `${bat.percent}%` : '—';
  const net = (s.network || []).reduce((n, i) => n + (i.rx_rate_mbs || 0) + (i.tx_rate_mbs || 0), 0);
  $('#t-net').textContent = net >= 1 ? `${net.toFixed(1)} MB/s` : `${(net * 1000).toFixed(0)} KB/s`;
  $('#t-up').textContent = s.uptime || '—';
}

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
