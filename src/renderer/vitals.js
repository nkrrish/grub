// Plain-language readings of a `mo status` snapshot, shared by the window and the menu bar.
const Vitals = (() => {
  function speed(mbs) {
    const kb = (mbs || 0) * 1000;
    if (kb >= 1000) return { value: (kb / 1000).toFixed(kb >= 10000 ? 0 : 1), unit: 'MB/s' };
    return { value: kb.toFixed(0), unit: 'KB/s' };
  }

  // "3:10" -> "3h 10m"
  function duration(t) {
    const m = /^(\d+):(\d+)$/.exec(t || '');
    if (!m || (m[1] === '0' && m[2] === '00')) return '';
    return m[1] === '0' ? `${+m[2]}m` : `${m[1]}h ${+m[2]}m`;
  }

  function battery(s) {
    const b = s.batteries?.[0];
    if (!b) return null;
    const status = (b.status || '').toLowerCase();
    const left = duration(b.time_left);
    let state = 'Plugged in';
    let detail = 'Full';
    if (status.includes('discharg')) [state, detail] = ['On battery', left ? `${left} left` : ''];
    else if (status.includes('charging') || status.includes('finishing')) [state, detail] = ['Charging', left ? `${left} to full` : ''];
    else if (b.percent < 100) detail = 'Not charging';
    const t = s.thermal || {};
    return {
      pct: b.percent,
      state,
      detail,
      health: b.health || '',
      capacity: b.capacity || 0,
      cycles: b.cycle_count || 0,
      charger: state !== 'On battery' && t.adapter_power > 0 ? Math.round(t.adapter_power) : 0,
      worn: b.capacity > 0 && b.capacity < 80,
    };
  }

  function network(s) {
    const ifs = s.network || [];
    const down = ifs.reduce((n, i) => n + (i.rx_rate_mbs || 0), 0);
    const up = ifs.reduce((n, i) => n + (i.tx_rate_mbs || 0), 0);
    return { down, up, online: ifs.some((i) => i.ip), vpn: !!s.proxy?.enabled };
  }

  function heat(s) {
    const t = s.thermal || {};
    const cpuTemp = t.cpu_temp > 0 ? Math.round(t.cpu_temp) : null;
    const gpuTemp = t.gpu_temp > 0 ? Math.round(t.gpu_temp) : null;
    const fan = t.fan_count > 0 ? Math.round(t.fan_speed || 0) : null;
    const power = t.system_power > 0 ? Math.round(t.system_power) : null;
    let note = 'Grub can’t feel the heat on this Mac.';
    if (cpuTemp != null) note = cpuTemp < 60 ? 'Cool as dirt.' : cpuTemp < 80 ? 'Warm. Grub’s fur is damp.' : 'Hot! Give it some air.';
    else if (power != null) note = power < 20 ? 'Barely breaking a sweat.' : power < 60 ? 'Working, not sweating.' : 'Working hard. Feels toasty.';
    return { cpuTemp, gpuTemp, fan, fanLabel: fan == null ? 'No reading' : fan === 0 ? 'Resting' : `${fan.toLocaleString()} RPM`, power, note };
  }

  function gpu(s) {
    const g = s.gpu?.[0];
    if (!g) return null;
    return { name: g.name, usage: g.usage >= 0 ? Math.round(g.usage) : null, cores: g.core_count || 0 };
  }

  function gadgets(s) {
    const all = s.bluetooth || [];
    const connected = all
      .filter((d) => d.connected)
      .map((d) => {
        const levels = [...(d.battery || '').matchAll(/(\d+)\s*%/g)].map((m) => +m[1]);
        return { name: d.name, battery: levels.length ? Math.min(...levels) : null };
      });
    return { connected, paired: all.length };
  }

  // Main already adds each app's helpers together and keeps the top 6.
  function apps(s) {
    return (s.top_processes || []).map((p) => ({ label: p.label || p.name, app: p.app || null, cpu: p.cpu || 0, mem: p.memory_bytes || 0, count: p.count || 1 }));
  }

  function cpuWord(load) {
    return load < 20 ? 'Napping.' : load < 60 ? 'Digging steadily.' : 'Sweating through its fur.';
  }

  function memWord(pct) {
    return pct < 60 ? 'Plenty of room.' : pct < 85 ? 'Getting cosy.' : 'Packed. Close a few apps.';
  }


  // Mole Title Cases its notes ("Good: High Memory"); the rest of Grub speaks in sentence case.
  function sentence(str) {
    return (str || '').replace(/(?!^)\b([A-Z])([a-z]+)/g, (_, a, b) => a.toLowerCase() + b);
  }

  function healthTitle(score) {
    if (score >= 85) return 'Fresh as dirt.';
    if (score >= 70) return 'Slightly whiffy.';
    if (score >= 50) return 'Starting to smell.';
    return 'Something died in here.';
  }

  // What's dragging the score down, worst first. Each culprit has a few lines.
  const CULPRIT_LINES = {
    disk: [(v) => `Only ${v.free} of disk left. Snack time.`, () => "Disk's stuffed. Grub's drooling.", (v) => `Disk's ${v.pct}% full. Dinner is served.`],
    memory: [() => "Memory's full. Grub can't think.", (v) => `${v.pct}% memory. The burrow's crowded.`],
    swap: [(v) => `${v.swap} of swap. Messy burrow.`],
    cpu: [() => "CPU's sweating. Grub smells smoke.", (v) => `CPU at ${v.pct}%. Something's chewing.`],
    trash: [(v) => `${v.trash} rotting in the Trash. Yum.`],
    uptime: [(v) => `Up ${v.days} days. Even moles sleep.`],
    battery: [(v) => `Battery at ${v.cap}%. Running on crumbs.`],
    none: [() => 'Fresh as dirt.', () => 'Not a crumb out of place.', () => 'Nothing to eat here.'],
  };

  function findCulprits(s, cpuSamples) {
    const out = [];
    const disk = (s.disks || []).find((d) => d.mount === '/');
    if (disk && disk.used_percent >= 90)
      out.push({ key: 'disk', sev: 3 + (disk.used_percent - 90) / 10, v: { free: bytes(disk.total - disk.used), pct: Math.round(disk.used_percent) } });
    const mem = s.memory || {};
    if (mem.used_percent >= 85) out.push({ key: 'memory', sev: 2 + (mem.used_percent - 85) / 15, v: { pct: Math.round(mem.used_percent) } });
    if (mem.swap_used >= 2e9) out.push({ key: 'swap', sev: 1.8 + mem.swap_used / 1e10, v: { swap: bytes(mem.swap_used) } });
    cpuSamples.push(s.cpu?.usage ?? 0);
    if (cpuSamples.length > 5) cpuSamples.shift();
    const cpu = cpuSamples.reduce((n, x) => n + x, 0) / cpuSamples.length; // sustained, not one spike
    if (cpuSamples.length >= 3 && cpu >= 70) out.push({ key: 'cpu', sev: 2 + (cpu - 70) / 30, v: { pct: Math.round(cpu) } });
    if (s.trash_size >= 1e9) out.push({ key: 'trash', sev: 1.5, v: { trash: bytes(s.trash_size) } });
    const days = Math.floor((s.uptime_seconds || 0) / 86400);
    if (days >= 7) out.push({ key: 'uptime', sev: 1, v: { days } });
    const bat = s.batteries?.[0];
    if (bat && bat.capacity && bat.capacity < 80) out.push({ key: 'battery', sev: 1, v: { cap: bat.capacity } });
    return out.sort((a, b) => b.sev - a.sev);
  }

  // One headline per window, fed every status update. The phrasing is kept while a culprit stays on top,
  // so it doesn't reshuffle every 2s; it's picked by the hour so the window and the menu bar agree.
  function headliner() {
    const cpuSamples = [];
    let culprit = { key: null, line: null };
    let challenger = { key: null, count: 0 };
    return (s) => {
      const found = findCulprits(s, cpuSamples);
      const top = found[0] || { key: 'none', sev: 0, v: {} };
      const current = found.find((c) => c.key === culprit.key) || (culprit.key === 'none' && !found.length ? top : null);
      // a new culprit has to stay on top for 3 updates (~6s) before it takes over
      if (!current || top.key === culprit.key) challenger = { key: null, count: 0 };
      else if (challenger.key === top.key) challenger.count++;
      else challenger = { key: top.key, count: 1 };
      let shown = current;
      if (!current || challenger.count >= 3) {
        const lines = CULPRIT_LINES[top.key];
        culprit = { key: top.key, line: lines[Math.floor(Date.now() / 3.6e6) % lines.length] };
        challenger = { key: null, count: 0 };
        shown = top;
      }
      const score = s.health_score ?? 0;
      return culprit.key === 'none' && score < 85 ? healthTitle(score) : culprit.line(shown.v);
    };
  }

  return { speed, battery, network, heat, gpu, gadgets, apps, cpuWord, memWord, sentence, headliner };
})();
