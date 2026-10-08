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
    return (s.top_processes || []).map((p) => ({ label: p.label || p.name, app: p.app || null, cpu: p.cpu || 0, mem: p.memory_bytes || 0 }));
  }

  function cpuWord(load) {
    return load < 20 ? 'Napping.' : load < 60 ? 'Digging steadily.' : 'Sweating through its fur.';
  }

  function memWord(pct) {
    return pct < 60 ? 'Plenty of room.' : pct < 85 ? 'Getting cosy.' : 'Packed. Close a few apps.';
  }

  return { speed, battery, network, heat, gpu, gadgets, apps, cpuWord, memWord };
})();
