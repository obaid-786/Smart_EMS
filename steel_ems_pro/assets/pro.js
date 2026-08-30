/* Steel EMS Pro — enriched with classic 20260802 timing / HMD / energy info */
(function () {
  const DEPT = {
    plant: { name: 'Plant', short: 'Plant' },
    ccm: { name: 'CCM', short: 'CCM' },
    mill: { name: 'Rolling Mill', short: 'RM' },
    cpp: { name: 'CPP', short: 'CPP' },
    dri: { name: '100 DRI', short: 'DRI' },
    system: { name: 'System', short: 'SYS' },
  };

  const META = {
    home: ['Plant home', 'All departments · live overview'],
    ccm: ['CCM · Live', 'Strand HMD · cast · billets · heat no.'],
    hmd: ['Rolling Mill · Live', 'On-load · idle · stop · HMD line · SEC'],
    energy: ['EMS', 'Period on-load / idle / stop · live electrical'],
    loss: ['Smart Detector', 'Util · PF · THD · ₹ loss · % graphs'],
    report: ['MIS', 'Date · time · heat wise · print · Excel'],
    soon: ['Coming soon', 'Department not connected yet'],
    health: ['Health & trust', 'PLC · DB8 · poll age · thresholds'],
    about: ['About product', 'Version · credit'],
  };

  let activeDept = 'plant';
  let periodBands = null;
  let periodHeatStats = null;
  let periodEnergy = null;
  let dataFolder = {
    log_dir: '',
    log_file: '',
    default_log_dir: 'D:\\Smart EMS and MIS Project\\Plant_Data',
    rows_approx: 0,
    files: [],
  };

  function fmtBytes(n) {
    const x = Number(n) || 0;
    if (x < 1024) return `${x} B`;
    if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
    return `${(x / (1024 * 1024)).toFixed(1)} MB`;
  }

  function paintDataFolderUI() {
    const dir = dataFolder.log_dir || '—';
    const short = dir.length > 42 ? '…' + dir.slice(-40) : dir;
    if ($('dataFolderHint')) {
      $('dataFolderHint').textContent = `Save: ${short}`;
      $('dataFolderHint').title = `All data saves to:\n${dir || '—'}`;
    }
    document.querySelectorAll('[data-log-dir-input]').forEach((el) => {
      if (document.activeElement !== el) el.value = dataFolder.log_dir || '';
    });
    const meta =
      `Folder: ${dir} · Energy: ${dataFolder.log_file || '—'} · ~${(dataFolder.rows_approx || 0).toLocaleString()} rows · ` +
      `Files: ccm_heats.jsonl · rm_heats.jsonl · ems_readings.jsonl · pac3200_log.csv`;
    document.querySelectorAll('[data-log-dir-meta]').forEach((el) => { el.textContent = meta; });
    const files = dataFolder.files || [];
    const bodyHtml = files.length
      ? files.map((f) => `<tr>
          <td class="mono">${f.name || ''}</td>
          <td>${fmtBytes(f.size)}</td>
          <td class="mono">${(f.mtime || '').replace('T', ' ').slice(0, 19)}</td>
          <td><a class="btn" href="/api/data/download/${encodeURIComponent(f.name || '')}" style="padding:4px 10px;font-size:12px;text-decoration:none;">Download</a></td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="muted">No files yet — save folder, keep bridge running</td></tr>';
    document.querySelectorAll('[data-log-dir-files]').forEach((el) => { el.innerHTML = bodyHtml; });
  }

  async function refreshDataFolder() {
    try {
      const cfg = await fetch('/api/log-config', { cache: 'no-store' }).then((r) => r.json());
      if (cfg && cfg.ok !== false) {
        dataFolder = {
          log_dir: cfg.log_dir || '',
          log_file: cfg.log_file || '',
          default_log_dir: cfg.default_log_dir || dataFolder.default_log_dir,
          rows_approx: cfg.rows_approx || 0,
          files: cfg.files || [],
        };
      }
    } catch (e) {
      dataFolder.log_dir = dataFolder.log_dir || '';
    }
    paintDataFolderUI();
  }

  async function saveDataFolder(fromEl) {
    const card = fromEl?.closest?.('.data-folder-card');
    const input = card?.querySelector?.('[data-log-dir-input]') || document.querySelector('[data-log-dir-input]');
    const log_dir = (input?.value || '').trim();
    if (!log_dir) {
      alert('Enter a folder path, e.g. D:\\Smart EMS and MIS Project\\Plant_Data');
      return;
    }
    try {
      const res = await fetch('/api/log-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_dir }),
      });
      const cfg = await res.json();
      if (!res.ok || !cfg.ok) {
        alert(cfg.error || 'Could not set data folder');
        return;
      }
      await refreshDataFolder();
      alert('Data folder saved.\n\nCasting · CCM/RM heats · energy CSV · EMS readings will use:\n' + (cfg.log_dir || log_dir));
    } catch (e) {
      alert('Could not reach bridge. Is bridge_server.py running?');
    }
  }
  let lossResult = null;
  let lossPrice = 8;
  let lossPfTarget = 0.95;
  let lossUtilTarget = 85;
  let lossThdILimit = 5;
  let lossThdVLimit = 5;

  const HMD_STAGES = [
    { id: 'entry', label: 'Entry', count: 'CCM_RM_ENTRY_COUNTS', hmd: 'CCM_RM_ENTRY_HMD' },
    { id: 'r3', label: 'R3', count: 'R3_COUNTS', hmd: 'R3_HMD' },
    { id: 'ccs1', label: 'CCS1', count: 'CCS1_COUNTS', hmd: 'CCS1_HMD' },
    { id: 'ccs2', label: 'CCS2', count: 'CCS2_COUNTS', hmd: 'CCS2_HMD' },
    { id: 'dd', label: 'DShear', count: 'DSHEAR_COUNTS', hmd: 'DSHEAR_HMD' },
    { id: 'blkIn', label: 'Blk In', count: 'BLOCK_ENTRY_COUNTS', hmd: 'BLOCK_ENTRY_HMD' },
    { id: 'blkOut', label: 'Blk Out', count: 'BLOCK_EXIT_COUNTS', hmd: 'BLOCK_EXIT_HMD' },
    { id: 'tmt', label: 'TMT', count: 'TMT_COUNTS', hmd: 'TMT_HMD' },
  ];

  const SHARED_HEAT_KEY = 'steel_ems_shared_heat';
  const CAST_MS = 75 * 60 * 1000;
  const CYCLE_MS = 2.3 * 3600 * 1000;

  let live = { connected: false, data: {}, timestamp: null, billets_ok: false, plc_ip: null, error: null };
  let ccmHeats = [], rmHeats = [];
  let ccmAll = [], rmAll = [];
  let rptRangeLabel = '';
  let startKw = 500, onloadKw = 1600;
  let session = { onLoadSec: 0, idleSec: 0, stopSec: 0, onLoadKwh: 0, idleKwh: 0, totalKwh: 0, totalKvah: 0 };
  let lastTick = null;
  let charts = {};
  /** Shared plant heat — generated on CCM start, shown on Rolling Mill */
  let sharedHeat = {
    heatNo: null, startedAt: null, endedAt: null, active: false,
    castSec: 0, lastCastSec: 0, source: null, lastSaved: null,
  };
  let ccmEdgePrimed = false;
  let prevCcmBits = { s1: false, s2: false };
  let prevCcmAbs = { s1: 0, s2: 0 };

  const $ = (id) => document.getElementById(id);
  const n = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  const fmt = (v, d = 1) => n(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const bit = (v) => v === true || v === 1 || v === '1' || v === 'true' || (typeof v === 'number' && v > 0);
  const d = () => live.data || {};

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function modeOf(kw) {
    if (kw > onloadKw) return 'onload';
    if (kw > startKw) return 'idle';
    return 'stop';
  }

  function sessionStats() {
    const on = session.onLoadSec || 0;
    const idle = session.idleSec || 0;
    const stop = session.stopSec || 0;
    const run = on + idle;
    const total = run + stop;
    return {
      on, idle, stop, run, total,
      util: run > 0 ? (on / run) * 100 : 0,
      avail: total > 0 ? (run / total) * 100 : 0,
      onPct: total > 0 ? (on / total) * 100 : 0,
      idlePct: total > 0 ? (idle / total) * 100 : 0,
      stopPct: total > 0 ? (stop / total) * 100 : 0,
      onKwh: session.onLoadKwh || 0,
      idleKwh: session.idleKwh || 0,
      totalKwh: session.totalKwh || 0,
      totalKvah: session.totalKvah || 0,
    };
  }

  function tickSession(kw, kva) {
    const now = performance.now();
    if (lastTick == null) { lastTick = now; return; }
    const dt = Math.min(2.5, (now - lastTick) / 1000);
    lastTick = now;
    if (dt <= 0) return;
    const mode = modeOf(kw);
    const dkwh = kw * dt / 3600;
    const dkvah = n(kva) * dt / 3600;
    if (mode === 'onload') {
      session.onLoadSec += dt;
      session.onLoadKwh += dkwh;
      session.totalKwh += dkwh;
      session.totalKvah += dkvah;
    } else if (mode === 'idle') {
      session.idleSec += dt;
      session.idleKwh += dkwh;
      session.totalKwh += dkwh;
      session.totalKvah += dkvah;
    } else {
      session.stopSec += dt;
    }
  }

  function mergeServerSession(srv) {
    if (!srv) return;
    /* Prefer higher accumulated timers (server band integrator) */
    session.onLoadSec = Math.max(session.onLoadSec, n(srv.on_load_sec));
    session.idleSec = Math.max(session.idleSec, n(srv.idle_sec));
    session.stopSec = Math.max(session.stopSec, n(srv.stop_sec));
    session.onLoadKwh = Math.max(session.onLoadKwh, n(srv.on_load_kwh));
    session.idleKwh = Math.max(session.idleKwh, n(srv.idle_kwh));
    session.totalKwh = Math.max(session.totalKwh, n(srv.total_kwh));
  }

  function kpi(label, value, sub, cls) {
    return `<div class="kpi ${cls || ''}"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub || ''}</div></div>`;
  }

  function ageSec() {
    if (!live.timestamp) return null;
    return Math.max(0, (Date.now() / 1000) - Number(live.timestamp));
  }

  function setBars(elId, st) {
    const el = $(elId);
    if (!el) return;
    el.innerHTML = `<i class="on" style="width:${st.onPct}%"></i><i class="idle" style="width:${st.idlePct}%"></i><i class="stop" style="width:${st.stopPct}%"></i>`;
  }

  function doughnut(canvasId, st) {
    const canvas = $(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    const data = [st.on, st.idle, st.stop];
    if (charts[canvasId]) {
      charts[canvasId].data.datasets[0].data = data;
      charts[canvasId].update('none');
      return;
    }
    charts[canvasId] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['On-load', 'Idle run', 'Stop'],
        datasets: [{
          data,
          backgroundColor: ['#22c55e', '#f59e0b', '#64748b'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#b6c3d4', boxWidth: 12, font: { size: 11 } } },
        },
        cutout: '62%',
      },
    });
  }

  function deptTitle(view) {
    const d = DEPT[activeDept] || DEPT.plant;
    if (view === 'energy') return `${d.name} · EMS`;
    if (view === 'loss') return 'Rolling Mill · Smart Detector';
    if (view === 'report') return `${d.name} · MIS`;
    if (view === 'soon') return `${d.name} · Coming soon`;
    return (META[view] || META.home)[0];
  }

  function deptSub(view) {
    const d = DEPT[activeDept] || DEPT.plant;
    if (view === 'energy') {
      if (activeDept === 'ccm') return 'CCM electrical context · heat · cast energy bands';
      if (activeDept === 'mill') return 'Rolling Mill EMS · HT · on-load / idle / stop · phase';
      return 'Plant EMS · all live electrical information';
    }
    if (view === 'loss') return '₹ loss from util · PF · THD · idle/stop · % graphs';
    if (view === 'report') {
      if (activeDept === 'ccm') return 'CCM MIS · saved heats · print · Excel';
      if (activeDept === 'mill') return 'Rolling Mill MIS · heats · time · SEC · print · Excel';
      return 'Plant MIS · CCM + Rolling Mill';
    }
    if (view === 'soon') return `${d.name} Live · EMS · MIS will be added here`;
    return (META[view] || META.home)[1];
  }

  function showView(name, dept) {
    if (dept) activeDept = dept;
    else if (name === 'ccm') activeDept = 'ccm';
    else if (name === 'hmd') activeDept = 'mill';
    else if (name === 'home') activeDept = 'plant';

    document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + name));

    document.querySelectorAll('[data-view]').forEach((btn) => {
      const v = btn.getAttribute('data-view');
      const d = btn.getAttribute('data-dept') || '';
      let on = false;
      if (v === 'energy' || v === 'report' || v === 'soon') {
        on = v === name && d === activeDept;
      } else {
        on = v === name;
      }
      btn.classList.toggle('active', on);
    });

    /* Expand the department you navigated into (still allow manual minimize) */
    if (activeDept === 'ccm' || activeDept === 'mill' || activeDept === 'cpp' || activeDept === 'dri') {
      setDeptOpen(activeDept, true, false);
    }

    $('pageTitle').textContent = deptTitle(name);
    $('pageSub').textContent = deptSub(name);
    if (name === 'report') {
      initReportDefaults();
      syncReportFilterUI();
      syncReportDeptUI();
      loadHeats();
    }
    if (name === 'soon') paintSoon();
    if (name === 'health' || name === 'ccm') refreshDataFolder();
    if (name === 'energy') {
      initEmsPeriodDefaults();
      syncEmsPeriodCard();
      if (activeDept === 'mill' && !periodBands) loadEmsPeriod();
    }
    if (name === 'loss') {
      activeDept = 'mill';
      initLossDefaults();
      if (!periodBands) loadEmsPeriod().then(() => calculateSmartLoss());
      else calculateSmartLoss();
    }
    paint();
  }

  function syncEmsPeriodCard() {
    const card = $('emsPeriodCard');
    if (!card) return;
    /* Productivity period panel is for Rolling Mill EMS (also usable from other EMS) */
    card.style.display = (activeDept === 'mill' || activeDept === 'ccm' || activeDept === 'plant') ? '' : 'none';
    const h = card.querySelector('h4');
    if (h) {
      if (activeDept === 'mill') h.textContent = 'Rolling Mill EMS · Energy meter · 24h / productivity';
      else if (activeDept === 'ccm') h.textContent = 'Plant HT productivity · On-load / Idle / Stop (CCM EMS)';
      else h.textContent = 'Productivity · On-load / Idle / Stop (date & time)';
    }
  }

  function emsDayStartHour() {
    const h = Math.floor(n($('emsDayStartHour')?.value, 9));
    return Math.max(0, Math.min(23, h));
  }

  function applyEmsWindowPreset(force) {
    const preset = $('emsWindowPreset')?.value || 'plant24';
    if (!force && preset === 'custom') return;
    const now = new Date();
    const hour = emsDayStartHour();
    let from = null;
    let to = null;
    if (preset === 'last24') {
      to = now;
      from = new Date(now.getTime() - 24 * 3600 * 1000);
    } else if (preset === 'today') {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      to = now;
    } else if (preset === 'plant24' || preset === 'prevPlant') {
      /* Plant day: e.g. 09:00 → next day 09:00 */
      let start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
      if (now < start) start = new Date(start.getTime() - 24 * 3600 * 1000);
      if (preset === 'prevPlant') start = new Date(start.getTime() - 24 * 3600 * 1000);
      from = start;
      to = new Date(start.getTime() + 24 * 3600 * 1000);
      if (preset === 'plant24' && to > now) to = now;
    } else {
      return;
    }
    if ($('emsFromTime') && from) $('emsFromTime').value = localInputValue(from);
    if ($('emsToTime') && to) $('emsToTime').value = localInputValue(to);
  }

  function initEmsPeriodDefaults() {
    const now = new Date();
    if ($('emsMonth') && !$('emsMonth').value) {
      $('emsMonth').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    if ($('emsDayStartHour') && ($('emsDayStartHour').value === '' || $('emsDayStartHour').value == null)) {
      $('emsDayStartHour').value = '9';
    }
    const preset = $('emsWindowPreset')?.value || 'plant24';
    if (preset !== 'custom') {
      applyEmsWindowPreset(true);
      return;
    }
    const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    if ($('emsFromTime') && !$('emsFromTime').value) $('emsFromTime').value = localInputValue(startDay);
    if ($('emsToTime') && !$('emsToTime').value) $('emsToTime').value = localInputValue(now);
  }

  function paintPeriodEnergy() {
    if (!$('emsMeterPeriodKpis')) return;
    if (!periodEnergy || !(periodEnergy.readings > 0 || periodEnergy.kwh_consumed != null)) {
      $('emsMeterPeriodKpis').innerHTML = [
        kpi('Meter ΔkWh', '—', 'calculate period', ''),
        kpi('Meter ΔkVAh', '—', 'calculate period', ''),
        kpi('Meter ΔkVArh', '—', 'calculate period', ''),
        kpi('Samples', '—', 'PAC log', ''),
      ].join('');
      if ($('emsMeterCalcKpis')) {
        $('emsMeterCalcKpis').innerHTML = [
          kpi('Calc kWh', '—', '∫ kW·dt', ''),
          kpi('Calc kVAh', '—', '∫ kVA·dt', ''),
          kpi('Calc kVArh', '—', '∫ kVAr·dt', ''),
          kpi('Avg PF', '—', 'period', ''),
        ].join('');
      }
      return;
    }
    const e = periodEnergy;
    $('emsMeterPeriodKpis').innerHTML = [
      kpi('Meter ΔkWh', fmt(e.kwh_consumed, 2), `${fmt(e.kwh_start, 1)} → ${fmt(e.kwh_end, 1)}`, 'ok'),
      kpi('Meter ΔkVAh', fmt(e.kvah_consumed, 2), `${fmt(e.kvah_start, 1)} → ${fmt(e.kvah_end, 1)}`, ''),
      kpi('Meter ΔkVArh', fmt(e.kvarh_consumed, 2), `${fmt(e.kvarh_start, 1)} → ${fmt(e.kvarh_end, 1)}`, ''),
      kpi('Samples', String(e.readings || 0), e.saved ? 'saved' : 'PAC log', e.saved ? 'ok' : ''),
    ].join('');
    if ($('emsMeterCalcKpis')) {
      $('emsMeterCalcKpis').innerHTML = [
        kpi('Calc kWh', fmt(e.calc_kwh, 2), '∫ kW·dt', 'ok'),
        kpi('Calc kVAh', fmt(e.calc_kvah, 2), '∫ kVA·dt', ''),
        kpi('Calc kVArh', fmt(e.calc_kvarh, 2), '∫ kVAr·dt', ''),
        kpi('Avg PF', e.avg_pf != null ? fmt(e.avg_pf, 3) : '—', `Avg ${fmt(e.avg_kw, 1)} kW`, ''),
      ].join('');
    }
  }

  async function saveEmsReading(energy, from, to) {
    if (!energy) return false;
    const row = {
      ...energy,
      window_start: from,
      window_end: to,
      day_start_hour: emsDayStartHour(),
      source: 'pro-ems-period',
      dept: 'mill',
    };
    try {
      const r = await fetch('/api/production/ems_readings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      });
      const j = await r.json();
      return !!(j && j.ok);
    } catch (e) {
      return false;
    }
  }

  function bandsToStats(b) {
    const on = n(b.on_load_sec);
    const idle = n(b.idle_sec);
    const stop = n(b.stop_sec);
    const run = on + idle;
    const total = run + stop;
    return {
      on, idle, stop, run, total,
      util: run > 0 ? (on / run) * 100 : 0,
      avail: total > 0 ? (run / total) * 100 : 0,
      onPct: total > 0 ? (on / total) * 100 : 0,
      idlePct: total > 0 ? (idle / total) * 100 : 0,
      stopPct: total > 0 ? (stop / total) * 100 : 0,
      onKwh: n(b.on_load_kwh),
      idleKwh: n(b.idle_kwh),
      totalKwh: n(b.total_kwh),
    };
  }

  function paintPeriodProductivity() {
    paintPeriodEnergy();
    if (!$('emsPeriodTimeKpis')) return;
    if (!periodBands) {
      $('emsPeriodTimeKpis').innerHTML = [
        kpi('On-load', '—', 'load period', ''),
        kpi('Idle', '—', 'load period', ''),
        kpi('Stop', '—', 'load period', ''),
        kpi('Util', '—', 'load period', ''),
      ].join('');
      if ($('emsPeriodExtraKpis')) $('emsPeriodExtraKpis').innerHTML = '';
      if ($('emsPeriodHeatKpis')) $('emsPeriodHeatKpis').innerHTML = '';
      return;
    }
    const st = bandsToStats(periodBands);
    $('emsPeriodTimeKpis').innerHTML = [
      kpi('On-load time', fmtTime(st.on), `> ${periodBands.onload_kw} kW · ${fmt(st.onPct, 1)}%`, 'ok'),
      kpi('Idle time', fmtTime(st.idle), `${periodBands.start_kw}–${periodBands.onload_kw} kW · ${fmt(st.idlePct, 1)}%`, 'warn'),
      kpi('Stop time', fmtTime(st.stop), `≤ ${periodBands.start_kw} kW · ${fmt(st.stopPct, 1)}%`, ''),
      kpi('Utilization', fmt(st.util, 1) + '%', `Avail ${fmt(st.avail, 1)}%`, st.util >= 75 ? 'ok' : 'warn'),
    ].join('');
    if ($('emsPeriodExtraKpis')) {
      $('emsPeriodExtraKpis').innerHTML = [
        kpi('Productive kWh', fmt(st.onKwh, 2), 'on-load band', 'ok'),
        kpi('Idle kWh', fmt(st.idleKwh, 2), 'idle band', 'warn'),
        kpi('Period kWh', fmt(st.totalKwh, 2), `${periodBands.samples || 0} samples`, ''),
        kpi('Run time', fmtTime(st.run), 'on-load + idle', ''),
      ].join('');
    }
    doughnut('chartEmsPeriod', st);
    setBars('emsPeriodBars', st);
    if ($('emsPeriodNote')) {
      $('emsPeriodNote').textContent =
        `On-load ${fmt(st.onPct, 1)}% · Idle ${fmt(st.idlePct, 1)}% · Stop ${fmt(st.stopPct, 1)}% · Util ${fmt(st.util, 1)}%`;
    }
    const hs = periodHeatStats || { heats: 0, on: 0, idle: 0, stop: 0, good: 0, util: 0 };
    if ($('emsPeriodHeatKpis')) {
      $('emsPeriodHeatKpis').innerHTML = [
        kpi('RM heats', String(hs.heats), 'saved in range', ''),
        kpi('Heat on-load', fmtTime(hs.on), `Idle ${fmtTime(hs.idle)}`, 'ok'),
        kpi('Heat util', fmt(hs.util, 1) + '%', `Good ${fmt(hs.good, 3)} t`, hs.util >= 75 ? 'ok' : 'warn'),
        kpi('Heat stop*', fmtTime(hs.stop), 'if saved on heat', ''),
      ].join('');
    }
  }

  async function loadEmsPeriod() {
    initEmsPeriodDefaults();
    const from = $('emsFromTime')?.value;
    const to = $('emsToTime')?.value;
    if (!from || !to) {
      if ($('emsPeriodMeta')) $('emsPeriodMeta').textContent = 'Select From and To date & time';
      return;
    }
    const startIso = from.length === 16 ? from + ':00' : from;
    const endIso = to.length === 16 ? to + ':00' : to;
    if ($('emsPeriodMeta')) $('emsPeriodMeta').textContent = 'Calculating energy & productivity…';
    try {
      const bandUrl = `/api/bands?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&start_kw=${encodeURIComponent(startKw)}&onload_kw=${encodeURIComponent(onloadKw)}`;
      const heatUrl = `/api/production/rm_heats?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
      const energyUrl = `/api/energy?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
      const [bj, hj, ej] = await Promise.all([
        fetch(bandUrl, { cache: 'no-store' }).then((r) => r.json()),
        fetch(heatUrl, { cache: 'no-store' }).then((r) => r.json()),
        fetch(energyUrl, { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (bj && bj.ok !== false && bj.on_load_sec != null) {
        periodBands = bj;
      } else {
        periodBands = null;
      }
      periodEnergy = ej && (ej.readings != null) ? ej : null;
      let saved = false;
      if (periodEnergy && (periodEnergy.readings > 0 || n(periodEnergy.kwh_consumed) !== 0)) {
        saved = await saveEmsReading(periodEnergy, startIso, endIso);
        if (periodEnergy) periodEnergy.saved = saved;
      }
      const rows = (hj && hj.ok && hj.rows) ? hj.rows : [];
      const on = rows.reduce((s, h) => s + n(h.onLoadSec), 0);
      const idle = rows.reduce((s, h) => s + n(h.idleSec), 0);
      const stop = rows.reduce((s, h) => s + n(h.stopSec), 0);
      const good = rows.reduce((s, h) => s + n(h.goodTon), 0);
      const run = on + idle;
      periodHeatStats = {
        heats: rows.length,
        on, idle, stop, good,
        util: run > 0 ? (on / run) * 100 : 0,
      };
      if ($('emsPeriodMeta')) {
        const mkwh = periodEnergy ? fmt(periodEnergy.kwh_consumed, 2) + ' kWh' : 'no meter';
        $('emsPeriodMeta').textContent =
          `Period ${from.replace('T', ' ')} → ${to.replace('T', ' ')} · meter ${mkwh} · ` +
          `${periodBands ? (periodBands.samples || 0) + ' log samples' : 'no log'} · ` +
          `${rows.length} RM heats · ${saved ? 'saved' : 'not saved'} · ${new Date().toLocaleString('en-GB')}`;
      }
    } catch (e) {
      periodBands = null;
      periodHeatStats = null;
      periodEnergy = null;
      if ($('emsPeriodMeta')) $('emsPeriodMeta').textContent = 'Failed to load period: ' + (e.message || e);
    }
    paintPeriodProductivity();
  }

  function exportEmsMonthExcel() {
    initEmsPeriodDefaults();
    const monthVal = $('emsMonth')?.value;
    if (!monthVal || !/^\d{4}-\d{2}$/.test(monthVal)) {
      alert('Select a month for day-wise Excel');
      return;
    }
    const [ys, ms] = monthVal.split('-');
    const hour = emsDayStartHour();
    const url = `/api/energy/month.xls?year=${encodeURIComponent(ys)}&month=${encodeURIComponent(ms)}&day_start_hour=${encodeURIComponent(hour)}`;
    if ($('emsPeriodMeta')) {
      $('emsPeriodMeta').textContent =
        `Downloading month Excel ${monthVal} · plant day ${String(hour).padStart(2, '0')}:00 → +24h (auto-saves each day)…`;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = `Sugna_RM_EMS_Energy_${ys}${ms}_h${String(hour).padStart(2, '0')}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function syncReportDeptUI() {
    const d = DEPT[activeDept] || DEPT.plant;
    if ($('rptDeptLabel')) $('rptDeptLabel').textContent = `· ${d.name}`;
    if ($('rptCcmCard')) $('rptCcmCard').style.display = (activeDept === 'mill') ? 'none' : '';
    if ($('rptRmCard')) $('rptRmCard').style.display = (activeDept === 'ccm') ? 'none' : '';
  }

  function paintSoon() {
    const d = DEPT[activeDept] || DEPT.cpp;
    if ($('soonKicker')) $('soonKicker').textContent = 'Department roadmap';
    if ($('soonTitle')) $('soonTitle').textContent = `${d.name} — coming next`;
    if ($('soonLead')) {
      $('soonLead').textContent =
        `${d.name} will be arranged like CCM and Rolling Mill: Live screen, EMS energy, and MIS report (date / time / heat wise).`;
    }
    if ($('soonRoadmap')) {
      $('soonRoadmap').innerHTML = [
        kpi('Live', 'Planned', `${d.short} process tags`, ''),
        kpi('EMS', 'Planned', `${d.short} kW · kWh · kVAh`, ''),
        kpi('MIS', 'Planned', `${d.short} print · Excel`, ''),
      ].join('');
    }
  }

  function paintConn() {
    const kw = n(d()['Total Active Power_2']);
    const mode = modeOf(kw);
    $('pillConn').textContent = live.connected ? 'LIVE' : 'OFFLINE';
    $('pillConn').className = 'pill ' + (live.connected ? 'live' : 'off');
    const age = ageSec();
    $('pillAge').textContent = age == null ? 'no poll' : (age < 3 ? `${age.toFixed(1)}s` : `STALE ${age.toFixed(0)}s`);
    $('pillAge').className = 'pill' + (age != null && age < 3 ? '' : ' off');
    $('pillMode').textContent = mode.toUpperCase();
    $('pillMode').className = 'pill' + (mode === 'onload' ? ' live' : mode === 'idle' ? ' demo' : '');
    $('clock').textContent = new Date().toLocaleTimeString('en-GB');
  }

  function timeKpis(prefix) {
    const st = sessionStats();
    const kw = n(d()['Total Active Power_2']);
    return [
      kpi('On-load time', fmtTime(st.on), `> ${onloadKw} kW · ${fmt(st.onPct, 1)}%`, 'ok'),
      kpi('Idle run', fmtTime(st.idle), `${startKw}–${onloadKw} kW · ${fmt(st.idlePct, 1)}%`, 'warn'),
      kpi('Stop time', fmtTime(st.stop), `≤ ${startKw} kW · ${fmt(st.stopPct, 1)}%`, ''),
      kpi('Utilization', fmt(st.util, 1) + '%', `Avail ${fmt(st.avail, 1)}% · HT ${fmt(kw, 1)} kW`, st.util >= 75 ? 'ok' : 'warn'),
    ].join('');
  }

  function paintHome() {
    const x = d();
    const kw = n(x['Total Active Power_2']);
    const s1 = Math.floor(n(x.CCM_STAND1_COUNTS));
    const s2 = Math.floor(n(x.CCM_STAND2_COUNTS));
    const r3 = Math.floor(n(x.R3_COUNTS));
    const tmt = Math.floor(n(x.TMT_COUNTS));
    const miss = Math.max(0, r3 - tmt);
    const yieldPct = r3 > 0 ? (tmt / r3) * 100 : 0;
    const st = sessionStats();
    const unit = 0.5699; /* default 110×110×6000 @ 7.85 — classic default */
    const goodT = tmt * unit;
    const sec = goodT > 0 ? st.totalKwh / goodT : 0;

    $('homeKpis').innerHTML = [
      kpi('HT load', fmt(kw, 1), 'kW', modeOf(kw) === 'onload' ? 'ok' : ''),
      kpi('CCM S1/S2', `${s1}/${s2}`, `${s1 + s2} pcs`, ''),
      kpi('R3 → TMT', `${r3}→${tmt}`, `Miss ${miss}`, miss ? 'warn' : 'ok'),
      kpi('Yield', fmt(yieldPct, 1) + '%', 'TMT ÷ R3', yieldPct >= 98 ? 'ok' : 'warn'),
      kpi('Good tons*', fmt(goodT, 3), 'TMT × unit (live)', 'ok'),
      kpi('SEC*', fmt(sec, 2), 'kWh / t session', ''),
    ].join('');
    $('homeTimeKpis').innerHTML = timeKpis();

    const s1on = bit(x.CCM_STAND1_HMD), s2on = bit(x.CCM_STAND2_HMD);
    $('homeSenseS1').classList.toggle('on', s1on);
    $('homeSenseS2').classList.toggle('on', s2on);
    $('homeCntS1').textContent = String(s1);
    $('homeCntS2').textContent = String(s2);
    $('ccmTimeline').innerHTML = `
      <div class="step ${s1on || s2on ? 'on' : ''}"><div class="n">Step 1</div><div class="t">Start</div><div class="d">Any strand HMD ON</div></div>
      <div class="step"><div class="n">Step 2</div><div class="t">Cast ~75 min</div><div class="d">Sequence running</div></div>
      <div class="step wait"><div class="n">Step 3</div><div class="t">Gap 2.3 h</div><div class="d">Next heat window</div></div>`;
    $('ccmTimelineNote').textContent = (s1on || s2on)
      ? `HMD ON · S1 ${s1on ? 'TRUE' : 'off'} · S2 ${s2on ? 'TRUE' : 'off'}`
      : 'Waiting for Strand HMD TRUE / HIGH…';

    $('millBandKpis').innerHTML = [
      kpi('Mode', modeOf(kw).toUpperCase(), `start ${startKw} · on-load ${onloadKw}`, modeOf(kw) === 'onload' ? 'ok' : modeOf(kw) === 'idle' ? 'warn' : ''),
      kpi('Session kWh', fmt(st.totalKwh, 2), `On ${fmt(st.onKwh, 2)} · Idle ${fmt(st.idleKwh, 2)}`, ''),
    ].join('');
    $('homeYieldKpis').innerHTML = [
      kpi('Miss-roll', String(miss), 'R3 − TMT', miss ? 'alarm' : 'ok'),
      kpi('PF / Hz', `${fmt(x['Average Power Factor_2'] ?? x['Power Factor L1_2'], 2)} / ${fmt(x.Frequency_2, 2)}`, 'electrical', ''),
    ].join('');
    $('homeElec').innerHTML = `V ${fmt(x['3-Ph Average Volt L-L_2'], 1)} · I ${fmt(x['3-Ph Average Curr_2'], 1)} A · kVA ${fmt(x['Total Apparent Power_2'], 1)} · meter ${fmt(x.I_KWH_, 1)} kWh`;

    doughnut('chartRunIdle', st);
    setBars('runIdleBars', st);
    $('runIdleLegend').textContent = `On-load ${fmt(st.onPct, 1)}% · Idle ${fmt(st.idlePct, 1)}% · Stop ${fmt(st.stopPct, 1)}% · Util ${fmt(st.util, 1)}%`;
  }

  function loadSharedHeat() {
    try {
      const j = JSON.parse(localStorage.getItem(SHARED_HEAT_KEY) || 'null');
      if (j && j.heatNo) {
        sharedHeat = {
          heatNo: String(j.heatNo),
          startedAt: j.startedAt || null,
          endedAt: j.endedAt || null,
          active: !!j.active,
          castSec: n(j.castSec),
          lastCastSec: n(j.lastCastSec || j.castSec),
          source: j.source || 'ccm',
          lastSaved: j.lastSaved || null,
        };
      }
    } catch (e) { /* ignore */ }
  }

  function saveSharedHeat() {
    try {
      localStorage.setItem(SHARED_HEAT_KEY, JSON.stringify(sharedHeat));
    } catch (e) { /* ignore */ }
  }

  function nextCcmHeatNo() {
    const t = new Date();
    return `C-AUTO-${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}-${pad2(t.getHours())}${pad2(t.getMinutes())}${pad2(t.getSeconds())}`;
  }

  function heatAgeMs() {
    if (!sharedHeat.startedAt) return 0;
    const t = Date.parse(sharedHeat.startedAt);
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0;
  }

  function cycleReady() {
    if (!sharedHeat.startedAt) return { ready: true, waitMs: 0, nextAt: null, nextLabel: '—' };
    const startMs = Date.parse(sharedHeat.startedAt);
    if (!Number.isFinite(startMs)) return { ready: true, waitMs: 0, nextAt: null, nextLabel: '—' };
    const nextMs = startMs + CYCLE_MS;
    const waitMs = Math.max(0, nextMs - Date.now());
    const nextAt = new Date(nextMs);
    const nextLabel = nextAt.toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    if (sharedHeat.active) {
      return { ready: false, waitMs: Math.max(0, CYCLE_MS - (Date.now() - startMs)), nextAt, nextLabel };
    }
    return { ready: waitMs <= 0, waitMs, nextAt, nextLabel };
  }

  function saveCcmHeatRecord(row) {
    const payload = {
      ...row,
      castTime: fmtTime(row.castSec),
      log_dir: dataFolder.log_dir || null,
      savedAt: new Date().toISOString(),
    };
    fetch('/api/production/ccm_heats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
    try {
      const key = 'pro_ccm_saved_heats';
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      list.unshift(payload);
      localStorage.setItem(key, JSON.stringify(list.slice(0, 200)));
    } catch (e) { /* ignore */ }
  }

  function startSharedHeat({ auto = true, heatNo = null } = {}) {
    if (sharedHeat.active) return false;
    /* Previous heat already saved on End — reset casting running time for new heat */
    const lastCast = n(sharedHeat.castSec || sharedHeat.lastCastSec);
    const no = (heatNo || nextCcmHeatNo()).trim();
    sharedHeat = {
      heatNo: no,
      startedAt: new Date().toISOString(),
      endedAt: null,
      active: true,
      castSec: 0,
      lastCastSec: lastCast,
      source: auto ? 'ccm-auto' : 'ccm-manual',
      lastSaved: sharedHeat.lastSaved || null,
    };
    saveSharedHeat();
    return true;
  }

  function endSharedHeat({ auto = false } = {}) {
    if (!sharedHeat.active) return false;
    const x = d();
    const s1 = Math.floor(n(x.CCM_STAND1_COUNTS));
    const s2 = Math.floor(n(x.CCM_STAND2_COUNTS));
    const castSec = Math.max(0, Math.floor(heatAgeMs() / 1000));
    const endedAt = new Date().toISOString();
    const unit = 0.5699;
    const row = {
      heatNo: sharedHeat.heatNo,
      startedAt: sharedHeat.startedAt,
      endedAt,
      s1, s2,
      totalPcs: s1 + s2,
      unitTon: unit,
      tons: (s1 + s2) * unit,
      castSec,
      castMin: castSec / 60,
      endReason: auto ? 'auto_75min' : 'manual',
      source: 'pro-ccm',
      auto: !!auto,
    };
    /* Save casting time + heat data BEFORE next heat can reset the timer */
    saveCcmHeatRecord(row);
    sharedHeat.active = false;
    sharedHeat.endedAt = endedAt;
    sharedHeat.castSec = castSec;
    sharedHeat.lastCastSec = castSec;
    sharedHeat.lastSaved = row;
    sharedHeat.source = auto ? 'ccm-auto-end' : 'ccm-manual-end';
    saveSharedHeat();
    return true;
  }

  function tickCcmHeat() {
    const x = d();
    const s1Bit = bit(x.CCM_STAND1_HMD);
    const s2Bit = bit(x.CCM_STAND2_HMD);
    const s1Abs = Math.floor(n(x.CCM_STAND1_COUNTS));
    const s2Abs = Math.floor(n(x.CCM_STAND2_COUNTS));
    if (!ccmEdgePrimed) {
      prevCcmBits = { s1: s1Bit, s2: s2Bit };
      prevCcmAbs = { s1: s1Abs, s2: s2Abs };
      ccmEdgePrimed = true;
      return;
    }
    const rise = (s1Bit && !prevCcmBits.s1) || (s2Bit && !prevCcmBits.s2)
      || (s1Abs > prevCcmAbs.s1) || (s2Abs > prevCcmAbs.s2);
    const autoOn = !!$('ccmAutoHeatPro')?.checked;
    if (autoOn && rise && !sharedHeat.active && cycleReady().ready) {
      startSharedHeat({ auto: true });
    }
    if (sharedHeat.active && heatAgeMs() >= CAST_MS) {
      endSharedHeat({ auto: true });
    }
    prevCcmBits = { s1: s1Bit, s2: s2Bit };
    prevCcmAbs = { s1: s1Abs, s2: s2Abs };
  }

  function heatStripHtml(scope) {
    const no = sharedHeat.heatNo || '—';
    const active = !!sharedHeat.active;
    const age = heatAgeMs();
    const left = Math.max(0, CAST_MS - age);
    const next = cycleReady();
    const lastCast = n(sharedHeat.castSec || sharedHeat.lastCastSec);

    /* While casting: show running casting time. When stopped: next heat tentative (not casting clock). */
    const saveHint = dataFolder.log_dir
      ? `Save → ${dataFolder.log_dir.split(/[/\\]/).slice(-2).join('\\')}`
      : 'Choose save folder below';
    const timeKpi = active
      ? kpi('Casting time', fmtTime(age / 1000), `Running · auto end in ${fmtTime(left / 1000)} · ${saveHint}`, 'ok')
      : kpi(
          'Next heat tentative',
          next.ready ? 'READY NOW' : (next.nextLabel || fmtTime(next.waitMs / 1000)),
          next.ready
            ? `Last cast ${lastCast ? fmtTime(lastCast) : '—'} · saved · ${saveHint}`
            : `Countdown ${fmtTime(next.waitMs / 1000)} · last cast ${lastCast ? fmtTime(lastCast) : '—'} · ${saveHint}`,
          (next.ready ? 'ok ' : 'warn ') + 'heat-no'
        );

    return [
      kpi('Heat number', no, active ? `${scope} · CASTING` : (sharedHeat.heatNo ? `${scope} · stopped` : `${scope} · waiting start`), (active ? 'ok ' : '') + 'heat-no'),
      timeKpi,
    ].join('');
  }

  function paintCcm() {
    const x = d();
    const s1 = Math.floor(n(x.CCM_STAND1_COUNTS));
    const s2 = Math.floor(n(x.CCM_STAND2_COUNTS));
    const s1on = bit(x.CCM_STAND1_HMD);
    const s2on = bit(x.CCM_STAND2_HMD);
    if ($('ccmHeatStrip')) $('ccmHeatStrip').innerHTML = heatStripHtml('CCM');
    $('ccmKpis').innerHTML = [
      kpi('Strand 1', String(s1), s1on ? 'HMD TRUE' : 'HMD FALSE', s1on ? 'ok' : ''),
      kpi('Strand 2', String(s2), s2on ? 'HMD TRUE' : 'HMD FALSE', s2on ? 'ok' : ''),
      kpi('Total pcs', String(s1 + s2), 'S1+S2', ''),
      kpi('Est. tons', fmt((s1 + s2) * 0.5699, 3), '× unit 0.5699 t', ''),
      kpi('DB8', live.billets_ok ? 'OK' : 'FAIL', 'billets', live.billets_ok ? 'ok' : 'alarm'),
      kpi('Poll', ageSec() == null ? '—' : fmt(ageSec(), 1) + 's', 'age', ''),
    ].join('');
    /* No on-load / idle / stop on CCM — those belong to Rolling Mill only */
    $('senseS1').classList.toggle('on', s1on);
    $('senseS2').classList.toggle('on', s2on);
    $('cntS1').textContent = String(s1);
    $('cntS2').textContent = String(s2);
    const active = sharedHeat.active;
    const next = cycleReady();
    const lastCast = n(sharedHeat.castSec || sharedHeat.lastCastSec);
    if ($('ccmAlgo')) {
      $('ccmAlgo').innerHTML = `
        <div class="step ${active || s1on || s2on ? 'on' : ''}"><div class="n">Step 1</div><div class="t">Start</div><div class="d">${sharedHeat.heatNo || 'Auto heat no.'}</div></div>
        <div class="step ${active ? 'on' : ''}"><div class="n">Step 2</div><div class="t">Casting time</div><div class="d">${active ? fmtTime(heatAgeMs() / 1000) : (lastCast ? fmtTime(lastCast) + ' saved' : '—')}</div></div>
        <div class="step ${!active && next.ready ? 'on' : 'wait'}"><div class="n">Step 3</div><div class="t">Next heat</div><div class="d">${active ? 'casting…' : (next.ready ? 'READY' : (next.nextLabel || fmtTime(next.waitMs / 1000)))}</div></div>`;
    }
    if ($('btnCcmStartHeat')) $('btnCcmStartHeat').disabled = !!sharedHeat.active;
    if ($('btnCcmEndHeat')) $('btnCcmEndHeat').disabled = !sharedHeat.active;
  }

  function paintHmd() {
    const x = d();
    const r3 = Math.floor(n(x.R3_COUNTS));
    const tmt = Math.floor(n(x.TMT_COUNTS));
    const entry = Math.floor(n(x.CCM_RM_ENTRY_COUNTS));
    const miss = Math.max(0, r3 - tmt);
    const yieldPct = r3 > 0 ? (tmt / r3) * 100 : 0;
    const st = sessionStats();
    const unit = 0.5699;
    const goodT = tmt * unit;
    const sec = goodT > 0 ? st.totalKwh / goodT : 0;
    const kw = n(x['Total Active Power_2']);

    $('hmdKpis').innerHTML = [
      kpi('Heat no.', sharedHeat.heatNo || '—', sharedHeat.active ? 'CCM open' : 'from CCM', (sharedHeat.heatNo ? 'ok ' : '') + 'heat-no'),
      kpi('Entry', String(entry), bit(x.CCM_RM_ENTRY_HMD) ? 'HMD ON' : '—', ''),
      kpi('R3', String(r3), bit(x.R3_HMD) ? 'HMD ON' : '—', ''),
      kpi('TMT', String(tmt), bit(x.TMT_HMD) ? 'HMD ON' : '—', 'ok'),
      kpi('Miss-roll', String(miss), `Yield ${fmt(yieldPct, 1)}%`, miss ? 'warn' : 'ok'),
      kpi('HT kW', fmt(kw, 1), modeOf(kw).toUpperCase(), modeOf(kw) === 'onload' ? 'ok' : ''),
    ].join('');
    if ($('hmdTimeKpis')) $('hmdTimeKpis').innerHTML = timeKpis();
    if ($('hmdLine')) {
      $('hmdLine').innerHTML = HMD_STAGES.slice(0, 4).map((s) =>
        kpi(s.label, String(Math.floor(n(x[s.count]))), bit(x[s.hmd]) ? 'HMD ON' : '—', bit(x[s.hmd]) ? 'ok' : '')
      ).join('');
    }
    if ($('hmdFlowFull')) {
      $('hmdFlowFull').innerHTML = HMD_STAGES.map((s) => {
        const on = bit(x[s.hmd]);
        return `<div class="hmd-chip ${on ? 'on' : ''}"><div class="n">${s.label}${on ? ' ●' : ''}</div><div class="c">${Math.floor(n(x[s.count]))}</div></div>`;
      }).join('');
    }
    doughnut('chartHmdTime', st);
    setBars('hmdBars', st);
    if ($('hmdTimeLegend')) {
      $('hmdTimeLegend').textContent =
        `On-load ${fmt(st.onPct, 1)}% · Idle ${fmt(st.idlePct, 1)}% · Stop ${fmt(st.stopPct, 1)}% · Util ${fmt(st.util, 1)}%`;
    }
    if ($('rmBandKpis')) {
      $('rmBandKpis').innerHTML = [
        kpi('Mode', modeOf(kw).toUpperCase(), `HT ${fmt(kw, 1)} kW`, modeOf(kw) === 'onload' ? 'ok' : modeOf(kw) === 'idle' ? 'warn' : ''),
        kpi('Session kWh', fmt(st.totalKwh, 2), `start ${startKw} · on ${onloadKw}`, ''),
        kpi('Session kVAh', fmt(st.totalKvah, 2), `start ${startKw} · on ${onloadKw}`, ''),
      ].join('');
    }
    if ($('thrStartRm')) $('thrStartRm').value = startKw;
    if ($('thrOnRm')) $('thrOnRm').value = onloadKw;
    if ($('hmdSecKpis')) {
      $('hmdSecKpis').innerHTML = [
        kpi('SEC*', fmt(sec, 2), 'session kWh / good t', ''),
        kpi('Idle kWh', fmt(st.idleKwh, 2), `On-load ${fmt(st.onKwh, 2)} kWh`, 'warn'),
      ].join('');
    }
  }

  function tag(x, ...keys) {
    for (const k of keys) {
      if (x[k] != null && x[k] !== '') return x[k];
    }
    return 0;
  }

  function paintEnergy() {
    syncEmsPeriodCard();
    paintPeriodProductivity();
    const x = d();
    const st = sessionStats();
    const kw = n(x['Total Active Power_2']);
    const kva = n(x['Total Apparent Power_2']);
    const kvar = n(x['Total Reac Power_2']);
    const pf = n(tag(x, 'Total Power Factor_2', 'Average Power Factor_2', 'Power Factor L1_2'));
    const hz = n(tag(x, 'Line Frequency_2', 'Frequency_2'));
    const vll = n(x['3-Ph Average Volt L-L_2']);
    const vln = n(x['3-Ph Average Volt L-N_2']);
    const amp = n(x['3-Ph Average Curr_2']);
    const kwhM = n(tag(x, 'I_KWH_', 'O_KWH_1'));
    const kvahM = n(tag(x, 'I_KVAH_2', 'O_KVAH_1'));
    const kvarhM = n(tag(x, 'I_KVARH_2', 'O_KVARH_1'));
    const mode = modeOf(kw);
    const s1 = Math.floor(n(x.CCM_STAND1_COUNTS));
    const s2 = Math.floor(n(x.CCM_STAND2_COUNTS));
    const r3 = Math.floor(n(x.R3_COUNTS));
    const tmt = Math.floor(n(x.TMT_COUNTS));
    const miss = Math.max(0, r3 - tmt);
    const yieldPct = r3 > 0 ? (tmt / r3) * 100 : 0;
    const unit = 0.5699;
    const goodT = tmt * unit;
    const sec = goodT > 0 ? st.totalKwh / goodT : 0;
    const demandFactor = kva > 0 ? (kw / kva) * 100 : 0;

    const deptName = (DEPT[activeDept] || DEPT.plant).name;
    if ($('emsHeatStrip')) $('emsHeatStrip').innerHTML = heatStripHtml(deptName + ' EMS');
    if ($('energyKpis')) {
      $('energyKpis').innerHTML = [
        kpi('Active', fmt(kw, 1), 'kW · HT load', mode === 'onload' ? 'ok' : ''),
        kpi('Apparent', fmt(kva, 1), 'kVA', ''),
        kpi('Reactive', fmt(kvar, 1), 'kVAr', ''),
        kpi('PF', fmt(pf, 3), `${fmt(hz, 2)} Hz`, pf >= 0.95 ? 'ok' : 'warn'),
        kpi('Voltage L-L', fmt(vll, 1), `L-N ${fmt(vln, 1)} V`, ''),
        kpi('Current', fmt(amp, 1), 'A · 3-ph avg', ''),
      ].join('');
    }

    if ($('energyMeterKpis')) {
      $('energyMeterKpis').innerHTML = [
        kpi('kWh meter', fmt(kwhM, 1), 'import cumulative', ''),
        kpi('kVAh meter', fmt(kvahM, 1), 'import cumulative', ''),
        kpi('kVARh meter', fmt(kvarhM, 1), 'import cumulative', ''),
        kpi('Session kWh', fmt(st.totalKwh, 2), `On ${fmt(st.onKwh, 2)} · Idle ${fmt(st.idleKwh, 2)}`, 'ok'),
        kpi('Session kVAh', fmt(st.totalKvah, 2), 'run bands only', ''),
        kpi('Demand factor', fmt(demandFactor, 1) + '%', 'kW ÷ kVA', demandFactor >= 90 ? 'ok' : 'warn'),
      ].join('');
    }

    if ($('energyTimeKpis')) $('energyTimeKpis').innerHTML = timeKpis();
    doughnut('chartEnergyTime', st);
    setBars('energyBars', st);
    if ($('energyTimeNote')) {
      $('energyTimeNote').textContent =
        `On-load ${fmt(st.onPct, 1)}% (${fmtTime(st.on)}) · Idle ${fmt(st.idlePct, 1)}% (${fmtTime(st.idle)}) · Stop ${fmt(st.stopPct, 1)}% (${fmtTime(st.stop)}) · Util ${fmt(st.util, 1)}% · Avail ${fmt(st.avail, 1)}%`;
    }

    if ($('energyBandKpis')) {
      $('energyBandKpis').innerHTML = [
        kpi('Productive kWh', fmt(st.onKwh, 2), `> ${onloadKw} kW`, 'ok'),
        kpi('Idle kWh', fmt(st.idleKwh, 2), `${startKw}–${onloadKw} kW`, 'warn'),
        kpi('SEC*', fmt(sec, 2), `kWh / ${fmt(goodT, 3)} t`, ''),
      ].join('');
    }
    if ($('thrStartEms')) $('thrStartEms').value = startKw;
    if ($('thrOnEms')) $('thrOnEms').value = onloadKw;
    if ($('energyQuality')) {
      $('energyQuality').textContent =
        `Bands: stop ≤ ${startKw} · idle ${startKw}–${onloadKw} · on-load > ${onloadKw} kW · THD I ${fmt(x['THD Current L1_2'], 1)}/${fmt(x['THD Current L2_2'], 1)}/${fmt(x['THD Current L3_2'], 1)}% · THD V ${fmt(x['THD Voltage L1_2'], 1)}/${fmt(x['THD Voltage L2_2'], 1)}/${fmt(x['THD Voltage L3_2'], 1)}%`;
    }

    if ($('emsPhaseBody')) {
      const phases = [
        {
          name: 'L1',
          vln: x['Voltage L1-N_2'], vll: x['Voltage L1-L2_2'],
          kw: x['Active Power L1_2'], kva: x['Apparent Power L1_2'], kvar: x['Reactive power L1_2'],
          pf: x['Power Factor L1_2'], thdi: x['THD Current L1_2'], thdv: x['THD Voltage L1_2'],
        },
        {
          name: 'L2',
          vln: x['Voltage L2-N_2'], vll: x['Voltage L2-L3_2'],
          kw: x['Active Power L2_2'], kva: x['Apparent Power L2_2'], kvar: x['Reactive power L2_2'],
          pf: x['Power Factor L2_2'], thdi: x['THD Current L2_2'], thdv: x['THD Voltage L2_2'],
        },
        {
          name: 'L3',
          vln: x['Voltage L3-N_3'], vll: x['Voltage L3-L1_3'],
          kw: x['Active Power L3_2'], kva: x['Apparent Power L3_2'], kvar: x['Reactive power L3_2'],
          pf: x['Power Factor L3_2'], thdi: x['THD Current L3_2'], thdv: x['THD Voltage L3_2'],
        },
      ];
      $('emsPhaseBody').innerHTML = phases.map((p) => `<tr>
        <td>${p.name}</td>
        <td>${fmt(p.vln, 1)}</td><td>${fmt(p.vll, 1)}</td>
        <td>${fmt(p.kw, 1)}</td><td>${fmt(p.kva, 1)}</td><td>${fmt(p.kvar, 1)}</td>
        <td>${fmt(p.pf, 3)}</td><td>${fmt(p.thdi, 1)}</td><td>${fmt(p.thdv, 1)}</td>
      </tr>`).join('');
    }

    if ($('emsProdKpis')) {
      $('emsProdKpis').innerHTML = [
        kpi('CCM S1 / S2', `${s1} / ${s2}`, `${s1 + s2} pcs · ${fmt((s1 + s2) * unit, 3)} t`, ''),
        kpi('R3 → TMT', `${r3} → ${tmt}`, `Miss ${miss} · Yield ${fmt(yieldPct, 1)}%`, miss ? 'warn' : 'ok'),
      ].join('');
    }
    if ($('emsProdKpis2')) {
      $('emsProdKpis2').innerHTML = [
        kpi('Good tons*', fmt(goodT, 3), 'TMT × unit', 'ok'),
        kpi('Heat no.', sharedHeat.heatNo || '—', sharedHeat.active ? 'CCM open' : 'from CCM', (sharedHeat.heatNo ? 'ok ' : '') + 'heat-no'),
      ].join('');
    }
    if ($('emsProdNote')) {
      $('emsProdNote').textContent =
        `Same DB4/DB8 tags as Plant home · CCM · Rolling Mill · PLC ${live.connected ? 'ONLINE' : 'OFFLINE'} · poll ${ageSec() == null ? '—' : fmt(ageSec(), 1) + 's'}`;
    }
  }

  function pad2(x) { return String(x).padStart(2, '0'); }
  function todayStr() {
    const t = new Date();
    return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  }
  function dayBounds(ds) {
    const d0 = ds || todayStr();
    return { start: d0 + 'T00:00:00', end: d0 + 'T23:59:59', ds: d0 };
  }
  function localInputValue(dt) {
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  }
  function parseLocalDt(s) {
    if (!s) return null;
    const d0 = new Date(String(s).replace(' ', 'T'));
    return Number.isNaN(d0.getTime()) ? null : d0;
  }
  function heatDt(h) {
    for (const key of ['endedAt', 'startedAt', 'savedAt', 'date']) {
      if (h && h[key]) {
        const d0 = parseLocalDt(h[key]);
        if (d0) return d0;
      }
    }
    return null;
  }
  function filterHeats(rows, start, end) {
    return (rows || []).filter((h) => {
      const dt = heatDt(h);
      if (!dt) return false;
      if (start && dt < start) return false;
      if (end && dt > end) return false;
      return true;
    });
  }
  function heatKey(h) {
    return String(h.heatNo || '').trim();
  }

  function initReportDefaults() {
    const ds = todayStr();
    if ($('rptFromDate') && !$('rptFromDate').value) $('rptFromDate').value = ds;
    if ($('rptToDate') && !$('rptToDate').value) $('rptToDate').value = ds;
    const now = new Date();
    const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    if ($('rptFromTime') && !$('rptFromTime').value) $('rptFromTime').value = localInputValue(startDay);
    if ($('rptToTime') && !$('rptToTime').value) $('rptToTime').value = localInputValue(now);
  }

  function syncReportFilterUI() {
    const type = $('rptType')?.value || 'date';
    const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
    show('rptWrapFromDate', type === 'date' || type === 'heat');
    show('rptWrapToDate', type === 'date' || type === 'heat');
    show('rptWrapFromTime', type === 'time');
    show('rptWrapToTime', type === 'time');
    show('rptWrapHeat', type === 'heat');
  }

  function reportBounds() {
    const type = $('rptType')?.value || 'date';
    if (type === 'time') {
      const a = parseLocalDt($('rptFromTime')?.value);
      const b = parseLocalDt($('rptToTime')?.value);
      if (!a || !b) return null;
      return {
        type,
        start: a,
        end: b,
        startIso: localInputValue(a).replace('T', ' '),
        endIso: localInputValue(b).replace('T', ' '),
        label: `${localInputValue(a).replace('T', ' ')} → ${localInputValue(b).replace('T', ' ')}`,
      };
    }
    const from = $('rptFromDate')?.value || todayStr();
    const to = $('rptToDate')?.value || from;
    const start = parseLocalDt(from + 'T00:00:00');
    const end = parseLocalDt(to + 'T23:59:59');
    if (!start || !end) return null;
    return {
      type,
      start,
      end,
      startIso: from + 'T00:00:00',
      endIso: to + 'T23:59:59',
      label: type === 'heat'
        ? `Heat filter · ${from} → ${to}`
        : `${from} → ${to}`,
    };
  }

  function fillHeatSelect(ccmRows, rmRows) {
    const sel = $('rptHeat');
    if (!sel) return;
    const prev = sel.value;
    const set = new Map();
    [...ccmRows, ...rmRows].forEach((h) => {
      const k = heatKey(h);
      if (!k) return;
      if (!set.has(k)) set.set(k, String(h.endedAt || h.startedAt || '').replace('T', ' ').slice(0, 19));
    });
    const keys = [...set.keys()].sort((a, b) => String(b).localeCompare(String(a), undefined, { numeric: true }));
    sel.innerHTML = keys.length
      ? keys.map((k) => `<option value="${k}">${k}${set.get(k) ? ' · ' + set.get(k) : ''}</option>`).join('')
      : '<option value="">No heats in range</option>';
    if (prev && keys.includes(prev)) sel.value = prev;
  }

  async function loadHeats() {
    initReportDefaults();
    syncReportFilterUI();
    const b = reportBounds();
    if (!b) {
      if ($('rptMeta')) $('rptMeta').textContent = 'Select a valid date / time range';
      return;
    }
    try {
      const [c, r] = await Promise.all([
        fetch(`/api/production/ccm_heats?start=${encodeURIComponent(b.startIso)}&end=${encodeURIComponent(b.endIso)}`, { cache: 'no-store' }).then((x) => x.json()),
        fetch(`/api/production/rm_heats?start=${encodeURIComponent(b.startIso)}&end=${encodeURIComponent(b.endIso)}`, { cache: 'no-store' }).then((x) => x.json()),
      ]);
      ccmAll = (c.ok && c.rows) ? c.rows.slice() : [];
      rmAll = (r.ok && r.rows) ? r.rows.slice() : [];
    } catch (e) {
      ccmAll = [];
      rmAll = [];
    }

    let ccm = filterHeats(ccmAll, b.start, b.end);
    let rm = filterHeats(rmAll, b.start, b.end);
    fillHeatSelect(ccm, rm);

    if (b.type === 'heat') {
      const hk = $('rptHeat')?.value || '';
      if (hk) {
        ccm = ccm.filter((h) => heatKey(h) === hk);
        rm = rm.filter((h) => heatKey(h) === hk);
        rptRangeLabel = `Heat ${hk} · ${b.label}`;
      } else {
        rptRangeLabel = b.label + ' · pick a heat';
      }
    } else {
      rptRangeLabel = (b.type === 'time' ? 'Time wise · ' : 'Date wise · ') + b.label;
    }

    ccmHeats = ccm.slice().reverse();
    rmHeats = rm.slice().reverse();
    if ($('rptMeta')) {
      $('rptMeta').textContent =
        `${rptRangeLabel} · ${ccmHeats.length} CCM · ${rmHeats.length} RM · loaded ${new Date().toLocaleString('en-GB')}`;
    }
    paintReport();
  }

  function reportSummary() {
    const ccmTons = ccmHeats.reduce((s, h) => s + n(h.tons), 0);
    const ccmPcs = ccmHeats.reduce((s, h) => s + n(h.totalPcs), 0);
    const ccmS1 = ccmHeats.reduce((s, h) => s + n(h.s1), 0);
    const ccmS2 = ccmHeats.reduce((s, h) => s + n(h.s2), 0);
    const good = rmHeats.reduce((s, h) => s + n(h.goodTon), 0);
    const miss = rmHeats.reduce((s, h) => s + n(h.missPcs), 0);
    const on = rmHeats.reduce((s, h) => s + n(h.onLoadSec), 0);
    const idle = rmHeats.reduce((s, h) => s + n(h.idleSec), 0);
    const kwh = rmHeats.reduce((s, h) => s + n(h.totalKwh), 0);
    const run = on + idle;
    const util = run > 0 ? (on / run) * 100 : 0;
    return { ccmTons, ccmPcs, ccmS1, ccmS2, good, miss, on, idle, kwh, run, util };
  }

  function paintReport() {
    if (!$('reportKpis')) return;
    syncReportDeptUI();
    const st = sessionStats();
    const s = reportSummary();
    const ccmBlock = [
      kpi('CCM heats', String(ccmHeats.length), rptRangeLabel || 'range', ''),
      kpi('CCM tons', fmt(s.ccmTons, 3), `${s.ccmPcs} billets`, 'ok'),
    ];
    const rmBlock = [
      kpi('RM heats', String(rmHeats.length), 'saved', ''),
      kpi('RM good t', fmt(s.good, 3), `Miss ${s.miss}`, s.miss ? 'warn' : 'ok'),
      kpi('Saved on-load', fmtTime(s.on), 'from heats', 'ok'),
      kpi('Saved util', fmt(s.util, 1) + '%', `Idle ${fmtTime(s.idle)}`, ''),
    ];
    let kpis = [];
    if (activeDept === 'ccm') kpis = [...ccmBlock, kpi('Live on-load', fmtTime(st.on), 'session', 'ok'), kpi('Live idle', fmtTime(st.idle), 'session', 'warn')];
    else if (activeDept === 'mill') kpis = [...rmBlock];
    else kpis = [...ccmBlock, ...rmBlock];
    $('reportKpis').innerHTML = kpis.join('');
    $('reportTimeKpis').innerHTML = [
      kpi('Live on-load', fmtTime(st.on), 'running now', 'ok'),
      kpi('Live idle', fmtTime(st.idle), 'running now', 'warn'),
      kpi('Live stop', fmtTime(st.stop), 'running now', ''),
      kpi('Saved kWh', fmt(s.kwh, 1), `SEC ${s.good > 0 ? fmt(s.kwh / s.good, 2) : '—'}`, ''),
    ].join('');
    if ($('rptCcmBody')) {
      $('rptCcmBody').innerHTML = ccmHeats.length
        ? ccmHeats.map((h) => `<tr>
            <td>${h.heatNo || '—'}</td>
            <td>${String(h.startedAt || '').replace('T', ' ').slice(0, 19) || '—'}</td>
            <td>${String(h.endedAt || '').replace('T', ' ').slice(0, 19)}</td>
            <td>${h.s1 ?? 0}</td><td>${h.s2 ?? 0}</td><td>${h.totalPcs ?? 0}</td><td>${fmt(h.tons, 3)}</td>
          </tr>`).join('')
        : '<tr><td colspan="7">No saved CCM heats in selection</td></tr>';
    }
    if ($('rptRmBody')) {
      $('rptRmBody').innerHTML = rmHeats.length
        ? rmHeats.map((h) => `<tr>
            <td>${h.heatNo || '—'}</td>
            <td>${String(h.endedAt || '').replace('T', ' ').slice(0, 19)}</td>
            <td>${h.r3 ?? h.r1 ?? 0}</td><td>${h.tmt ?? 0}</td><td>${h.missPcs ?? 0}</td>
            <td>${fmt(h.goodTon, 3)}</td>
            <td>${fmtTime(h.onLoadSec)}</td><td>${fmtTime(h.idleSec)}</td>
            <td>${fmt(h.utilPct, 1)}</td><td>${fmt(h.kwhPerTon, 2)}</td>
          </tr>`).join('')
        : '<tr><td colspan="10">No saved RM heats in selection</td></tr>';
    }
    buildReportPrintSheet();
  }

  function buildReportPrintSheet() {
    const sheet = $('rptPrintSheet');
    if (!sheet) return;
    const s = reportSummary();
    const st = sessionStats();
    const ccmRows = ccmHeats.map((h) => `<tr>
      <td>${h.heatNo || '—'}</td>
      <td>${String(h.startedAt || '').replace('T', ' ').slice(0, 19) || '—'}</td>
      <td>${String(h.endedAt || '').replace('T', ' ').slice(0, 19)}</td>
      <td>${h.s1 ?? 0}</td><td>${h.s2 ?? 0}</td><td>${h.totalPcs ?? 0}</td><td>${fmt(h.tons, 3)}</td>
    </tr>`).join('') || '<tr><td colspan="7">No CCM heats</td></tr>';
    const rmRows = rmHeats.map((h) => `<tr>
      <td>${h.heatNo || '—'}</td>
      <td>${String(h.endedAt || '').replace('T', ' ').slice(0, 19)}</td>
      <td>${h.r3 ?? h.r1 ?? 0}</td><td>${h.tmt ?? 0}</td><td>${h.missPcs ?? 0}</td>
      <td>${fmt(h.goodTon, 3)}</td>
      <td>${fmtTime(h.onLoadSec)}</td><td>${fmtTime(h.idleSec)}</td>
      <td>${fmt(h.utilPct, 1)}</td><td>${fmt(h.kwhPerTon, 2)}</td>
    </tr>`).join('') || '<tr><td colspan="10">No RM heats</td></tr>';
    sheet.innerHTML = `
      <div class="ps-head">
        <div>
          <h1>SUGNA SPONGE AND POWER PVT LTD</h1>
          <p>Steel EMS Pro · MIS Production Report</p>
          <p>${rptRangeLabel || '—'} · Printed ${new Date().toLocaleString('en-GB')}</p>
        </div>
        <div class="ps-right">${ccmHeats.length} CCM · ${rmHeats.length} RM</div>
      </div>
      <div class="ps-sec">Summary</div>
      <div class="ps-grid">
        <div class="ps-kpi"><div class="l">CCM tons</div><div class="v">${fmt(s.ccmTons, 3)}</div><div class="s">${s.ccmPcs} billets</div></div>
        <div class="ps-kpi"><div class="l">RM good t</div><div class="v">${fmt(s.good, 3)}</div><div class="s">Miss ${s.miss}</div></div>
        <div class="ps-kpi"><div class="l">On-load</div><div class="v">${fmtTime(s.on)}</div><div class="s">Saved heats</div></div>
        <div class="ps-kpi"><div class="l">Util %</div><div class="v">${fmt(s.util, 1)}%</div><div class="s">Idle ${fmtTime(s.idle)}</div></div>
        <div class="ps-kpi"><div class="l">Saved kWh</div><div class="v">${fmt(s.kwh, 1)}</div><div class="s">SEC ${s.good > 0 ? fmt(s.kwh / s.good, 2) : '—'}</div></div>
        <div class="ps-kpi"><div class="l">Live now</div><div class="v">${fmtTime(st.on)}</div><div class="s">On-load · Idle ${fmtTime(st.idle)} · Stop ${fmtTime(st.stop)}</div></div>
      </div>
      <div class="ps-sec">CCM heats</div>
      <table><thead><tr><th>Heat</th><th>Started</th><th>Ended</th><th>S1</th><th>S2</th><th>Pcs</th><th>t</th></tr></thead><tbody>${ccmRows}</tbody></table>
      <div class="ps-sec">RM heats · time &amp; SEC</div>
      <table><thead><tr><th>Heat</th><th>Ended</th><th>R3</th><th>TMT</th><th>Miss</th><th>t</th><th>On-load</th><th>Idle</th><th>Util%</th><th>kWh/t</th></tr></thead><tbody>${rmRows}</tbody></table>
      <p class="ps-foot">Coding by Amazad Ali · Steel EMS Pro</p>`;
  }

  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  }

  function exportReportExcel() {
    if (!ccmHeats.length && !rmHeats.length) {
      alert('Load a report with data first');
      return;
    }
    const s = reportSummary();
    const st = sessionStats();
    const lines = [];
    lines.push(['SUGNA SPONGE AND POWER PVT LTD'].map(csvEscape).join(','));
    lines.push(['Steel EMS Pro MIS Report', rptRangeLabel || ''].map(csvEscape).join(','));
    lines.push(['Generated', new Date().toLocaleString('en-GB')].map(csvEscape).join(','));
    lines.push('');
    lines.push(['Summary'].map(csvEscape).join(','));
    lines.push(['CCM heats', ccmHeats.length, 'CCM tons', fmt(s.ccmTons, 3), 'CCM billets', s.ccmPcs].map(csvEscape).join(','));
    lines.push(['RM heats', rmHeats.length, 'RM good t', fmt(s.good, 3), 'Miss pcs', s.miss].map(csvEscape).join(','));
    lines.push(['Saved on-load', fmtTime(s.on), 'Saved idle', fmtTime(s.idle), 'Util %', fmt(s.util, 1), 'kWh', fmt(s.kwh, 1)].map(csvEscape).join(','));
    lines.push(['Live on-load', fmtTime(st.on), 'Live idle', fmtTime(st.idle), 'Live stop', fmtTime(st.stop)].map(csvEscape).join(','));
    lines.push('');
    lines.push(['CCM heats'].map(csvEscape).join(','));
    lines.push(['Heat', 'Started', 'Ended', 'S1', 'S2', 'Pcs', 'Tons'].map(csvEscape).join(','));
    ccmHeats.forEach((h) => {
      lines.push([
        h.heatNo || '', String(h.startedAt || '').replace('T', ' ').slice(0, 19),
        String(h.endedAt || '').replace('T', ' ').slice(0, 19),
        h.s1 ?? 0, h.s2 ?? 0, h.totalPcs ?? 0, n(h.tons).toFixed(3),
      ].map(csvEscape).join(','));
    });
    lines.push('');
    lines.push(['RM heats'].map(csvEscape).join(','));
    lines.push(['Heat', 'Ended', 'R3', 'TMT', 'Miss', 'Good t', 'On-load', 'Idle', 'Util%', 'kWh/t', 'Total kWh'].map(csvEscape).join(','));
    rmHeats.forEach((h) => {
      lines.push([
        h.heatNo || '', String(h.endedAt || '').replace('T', ' ').slice(0, 19),
        h.r3 ?? h.r1 ?? 0, h.tmt ?? 0, h.missPcs ?? 0, n(h.goodTon).toFixed(3),
        fmtTime(h.onLoadSec), fmtTime(h.idleSec), n(h.utilPct).toFixed(1), n(h.kwhPerTon).toFixed(2), n(h.totalKwh).toFixed(2),
      ].map(csvEscape).join(','));
    });
    const stamp = todayStr().replace(/-/g, '');
    const type = $('rptType')?.value || 'date';
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Sugna_MIS_${type}_${stamp}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function printReport() {
    if (!ccmHeats.length && !rmHeats.length) {
      alert('Load a report with data first');
      return;
    }
    buildReportPrintSheet();
    document.body.classList.add('print-mis');
    window.print();
    setTimeout(() => document.body.classList.remove('print-mis'), 500);
  }

  function emsPeriodLabel() {
    const from = ($('emsFromTime')?.value || '').replace('T', ' ');
    const to = ($('emsToTime')?.value || '').replace('T', ' ');
    const dept = (DEPT[activeDept] || DEPT.mill).name;
    return `${dept} EMS · ${from || '—'} → ${to || '—'}`;
  }

  function buildEmsPrintSheet() {
    const sheet = $('emsPrintSheet');
    if (!sheet || (!periodBands && !periodEnergy)) return;
    const st = periodBands ? bandsToStats(periodBands) : { on: 0, idle: 0, stop: 0, util: 0, avail: 0, onPct: 0, idlePct: 0, stopPct: 0, onKwh: 0, idleKwh: 0 };
    const hs = periodHeatStats || { heats: 0, on: 0, idle: 0, stop: 0, good: 0, util: 0 };
    const liveSt = sessionStats();
    const onloadKwLbl = periodBands ? periodBands.onload_kw : onloadKw;
    const startKwLbl = periodBands ? periodBands.start_kw : startKw;
    const samplesLbl = periodBands ? (periodBands.samples || 0) : (periodEnergy?.readings || 0);
    sheet.innerHTML = `
      <div class="ps-head">
        <div>
          <h1>SUGNA SPONGE AND POWER PVT LTD</h1>
          <p>Steel EMS Pro · ${emsPeriodLabel()}</p>
          <p>Printed ${new Date().toLocaleString('en-GB')}</p>
        </div>
        <div class="ps-right">${periodEnergy ? fmt(periodEnergy.kwh_consumed, 1) + ' kWh' : 'Util ' + fmt(st.util, 1) + '%'}</div>
      </div>
      <div class="ps-sec">Energy meter (PAC)</div>
      <div class="ps-grid">
        <div class="ps-kpi"><div class="l">Meter ΔkWh</div><div class="v">${periodEnergy ? fmt(periodEnergy.kwh_consumed, 2) : '—'}</div><div class="s">register delta</div></div>
        <div class="ps-kpi"><div class="l">Meter ΔkVAh</div><div class="v">${periodEnergy ? fmt(periodEnergy.kvah_consumed, 2) : '—'}</div><div class="s">register delta</div></div>
        <div class="ps-kpi"><div class="l">Meter ΔkVArh</div><div class="v">${periodEnergy ? fmt(periodEnergy.kvarh_consumed, 2) : '—'}</div><div class="s">register delta</div></div>
        <div class="ps-kpi"><div class="l">Calc kWh</div><div class="v">${periodEnergy ? fmt(periodEnergy.calc_kwh, 2) : '—'}</div><div class="s">∫ kW·dt</div></div>
        <div class="ps-kpi"><div class="l">Calc kVAh</div><div class="v">${periodEnergy ? fmt(periodEnergy.calc_kvah, 2) : '—'}</div><div class="s">∫ kVA·dt</div></div>
        <div class="ps-kpi"><div class="l">Calc kVArh</div><div class="v">${periodEnergy ? fmt(periodEnergy.calc_kvarh, 2) : '—'}</div><div class="s">∫ kVAr·dt</div></div>
      </div>
      <div class="ps-sec">Period productivity (HT kW log)</div>
      <div class="ps-grid">
        <div class="ps-kpi"><div class="l">On-load</div><div class="v">${fmtTime(st.on)}</div><div class="s">&gt; ${onloadKwLbl} kW · ${fmt(st.onPct, 1)}%</div></div>
        <div class="ps-kpi"><div class="l">Idle</div><div class="v">${fmtTime(st.idle)}</div><div class="s">${startKwLbl}–${onloadKwLbl} kW · ${fmt(st.idlePct, 1)}%</div></div>
        <div class="ps-kpi"><div class="l">Stop</div><div class="v">${fmtTime(st.stop)}</div><div class="s">≤ ${startKwLbl} kW · ${fmt(st.stopPct, 1)}%</div></div>
        <div class="ps-kpi"><div class="l">Utilization</div><div class="v">${fmt(st.util, 1)}%</div><div class="s">Avail ${fmt(st.avail, 1)}%</div></div>
        <div class="ps-kpi"><div class="l">Productive kWh</div><div class="v">${fmt(st.onKwh, 2)}</div><div class="s">on-load band</div></div>
        <div class="ps-kpi"><div class="l">Idle kWh</div><div class="v">${fmt(st.idleKwh, 2)}</div><div class="s">Samples ${samplesLbl}</div></div>
      </div>
      <div class="ps-sec">Saved RM heats (same range)</div>
      <div class="ps-grid">
        <div class="ps-kpi"><div class="l">RM heats</div><div class="v">${hs.heats}</div><div class="s">saved</div></div>
        <div class="ps-kpi"><div class="l">Heat on-load</div><div class="v">${fmtTime(hs.on)}</div><div class="s">Idle ${fmtTime(hs.idle)}</div></div>
        <div class="ps-kpi"><div class="l">Heat util</div><div class="v">${fmt(hs.util, 1)}%</div><div class="s">Good ${fmt(hs.good, 3)} t</div></div>
        <div class="ps-kpi"><div class="l">Heat stop</div><div class="v">${fmtTime(hs.stop)}</div><div class="s">if saved</div></div>
      </div>
      <div class="ps-sec">Live session (now)</div>
      <div class="ps-grid">
        <div class="ps-kpi"><div class="l">Live on-load</div><div class="v">${fmtTime(liveSt.on)}</div><div class="s">session</div></div>
        <div class="ps-kpi"><div class="l">Live idle</div><div class="v">${fmtTime(liveSt.idle)}</div><div class="s">session</div></div>
        <div class="ps-kpi"><div class="l">Live stop</div><div class="v">${fmtTime(liveSt.stop)}</div><div class="s">session</div></div>
        <div class="ps-kpi"><div class="l">Live util</div><div class="v">${fmt(liveSt.util, 1)}%</div><div class="s">now</div></div>
      </div>
      <p class="ps-foot">Coding by Amazad Ali · Steel EMS Pro</p>`;
  }

  function printEmsPeriod() {
    if (!periodBands && !periodEnergy) {
      alert('Calculate period first');
      return;
    }
    buildEmsPrintSheet();
    document.body.classList.add('print-ems');
    window.print();
    setTimeout(() => document.body.classList.remove('print-ems'), 500);
  }

  function exportEmsExcel() {
    if (!periodBands && !periodEnergy) {
      alert('Calculate period first');
      return;
    }
    const st = periodBands ? bandsToStats(periodBands) : null;
    const hs = periodHeatStats || { heats: 0, on: 0, idle: 0, stop: 0, good: 0, util: 0 };
    const liveSt = sessionStats();
    const e = periodEnergy || {};
    const from = ($('emsFromTime')?.value || '').replace('T', ' ');
    const to = ($('emsToTime')?.value || '').replace('T', ' ');
    const lines = [];
    lines.push(['SUGNA SPONGE AND POWER PVT LTD'].map(csvEscape).join(','));
    lines.push(['Steel EMS Pro · Rolling Mill EMS', emsPeriodLabel()].map(csvEscape).join(','));
    lines.push(['From', from, 'To', to, 'Day start hour', emsDayStartHour()].map(csvEscape).join(','));
    lines.push(['Generated', new Date().toLocaleString('en-GB')].map(csvEscape).join(','));
    lines.push('');
    lines.push(['Energy meter (PAC registers)'].map(csvEscape).join(','));
    lines.push(['Meter kWh start', e.kwh_start, 'end', e.kwh_end, 'ΔkWh', e.kwh_consumed].map(csvEscape).join(','));
    lines.push(['Meter kVAh start', e.kvah_start, 'end', e.kvah_end, 'ΔkVAh', e.kvah_consumed].map(csvEscape).join(','));
    lines.push(['Meter kVArh start', e.kvarh_start, 'end', e.kvarh_end, 'ΔkVArh', e.kvarh_consumed].map(csvEscape).join(','));
    lines.push('');
    lines.push(['Calculated energy (∫ power·dt)'].map(csvEscape).join(','));
    lines.push(['Calc kWh', e.calc_kwh, 'Calc kVAh', e.calc_kvah, 'Calc kVArh', e.calc_kvarh].map(csvEscape).join(','));
    lines.push(['Avg kW', e.avg_kw, 'Avg PF', e.avg_pf, 'Samples', e.readings].map(csvEscape).join(','));
    lines.push('');
    if (st && periodBands) {
      lines.push(['Period from HT kW log'].map(csvEscape).join(','));
      lines.push(['On-load time', fmtTime(st.on), 'sec', st.on, '%', fmt(st.onPct, 1)].map(csvEscape).join(','));
      lines.push(['Idle time', fmtTime(st.idle), 'sec', st.idle, '%', fmt(st.idlePct, 1)].map(csvEscape).join(','));
      lines.push(['Stop time', fmtTime(st.stop), 'sec', st.stop, '%', fmt(st.stopPct, 1)].map(csvEscape).join(','));
      lines.push(['Utilization %', fmt(st.util, 1), 'Availability %', fmt(st.avail, 1)].map(csvEscape).join(','));
      lines.push(['Productive kWh', fmt(st.onKwh, 2), 'Idle kWh', fmt(st.idleKwh, 2), 'Period kWh', fmt(st.totalKwh, 2)].map(csvEscape).join(','));
      lines.push(['Mill start kW', periodBands.start_kw, 'On-load kW', periodBands.onload_kw, 'Samples', periodBands.samples || 0].map(csvEscape).join(','));
      lines.push('');
    }
    lines.push(['Saved RM heats (same range)'].map(csvEscape).join(','));
    lines.push(['RM heats', hs.heats, 'Heat on-load', fmtTime(hs.on), 'Heat idle', fmtTime(hs.idle), 'Heat stop', fmtTime(hs.stop)].map(csvEscape).join(','));
    lines.push(['Heat util %', fmt(hs.util, 1), 'Good tons', fmt(hs.good, 3)].map(csvEscape).join(','));
    lines.push('');
    lines.push(['Live session now'].map(csvEscape).join(','));
    lines.push(['Live on-load', fmtTime(liveSt.on), 'Live idle', fmtTime(liveSt.idle), 'Live stop', fmtTime(liveSt.stop), 'Live util %', fmt(liveSt.util, 1)].map(csvEscape).join(','));
    const stamp = todayStr().replace(/-/g, '');
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Sugna_EMS_Energy_${stamp}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function initLossDefaults() {
    initEmsPeriodDefaults();
    if ($('emsFromTime')?.value && $('lossFromTime')) $('lossFromTime').value = $('emsFromTime').value;
    if ($('emsToTime')?.value && $('lossToTime')) $('lossToTime').value = $('emsToTime').value;
    if ($('lossFromTime') && !$('lossFromTime').value) {
      const now = new Date();
      const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      $('lossFromTime').value = localInputValue(startDay);
    }
    if ($('lossToTime') && !$('lossToTime').value) {
      $('lossToTime').value = localInputValue(new Date());
    }
    try {
      const saved = JSON.parse(localStorage.getItem('pro_loss_cfg') || 'null');
      if (saved) {
        if (saved.price != null) lossPrice = n(saved.price, 8);
        if (saved.util != null) lossUtilTarget = n(saved.util, 85);
      }
    } catch (e) { /* ignore */ }
    if ($('lossPrice')) $('lossPrice').value = lossPrice;
    if ($('lossUtilTarget')) $('lossUtilTarget').value = lossUtilTarget;
    applyMeterAutoTargets();
  }

  function meterThdAvg(prefix) {
    const x = d();
    if (prefix === 'I') {
      return (n(x['THD Current L1_2']) + n(x['THD Current L2_2']) + n(x['THD Current L3_2'])) / 3;
    }
    return (n(x['THD Voltage L1_2']) + n(x['THD Voltage L2_2']) + n(x['THD Voltage L3_2'])) / 3;
  }

  /**
   * Auto PF target / THD I / THD V limits from live energy meter (DB4 Output).
   * - PF target: hold meter PF if already ≥ 0.95, else aim 0.95
   * - THD limits: IEC floor 5%; if meter higher, set improve-to 85% of reading (min 5%)
   */
  function applyMeterAutoTargets() {
    const x = d();
    const pf = n(tag(x, 'Total Power Factor_2', 'Average Power Factor_2', 'Power Factor L1_2'));
    const thdI = meterThdAvg('I');
    const thdV = meterThdAvg('V');

    if (pf > 0.01) {
      lossPfTarget = pf >= 0.95 ? Math.min(0.99, Math.round(pf * 100) / 100) : 0.95;
    } else {
      lossPfTarget = 0.95;
    }
    if (thdI > 0) {
      lossThdILimit = thdI <= 5 ? 5 : Math.max(5, Math.round(thdI * 0.85 * 10) / 10);
    } else {
      lossThdILimit = 5;
    }
    if (thdV > 0) {
      lossThdVLimit = thdV <= 5 ? 5 : Math.max(5, Math.round(thdV * 0.85 * 10) / 10);
    } else {
      lossThdVLimit = 5;
    }

    if ($('lossMeterAutoKpis')) {
      $('lossMeterAutoKpis').innerHTML = [
        kpi('PF target (auto)', fmt(lossPfTarget, 2), `Meter PF ${pf > 0.01 ? fmt(pf, 3) : '—'}`, pf >= lossPfTarget ? 'ok' : 'warn'),
        kpi('THD I limit (auto)', fmt(lossThdILimit, 1) + '%', `Meter avg ${fmt(thdI, 1)}%`, thdI <= lossThdILimit ? 'ok' : 'warn'),
        kpi('THD V limit (auto)', fmt(lossThdVLimit, 1) + '%', `Meter avg ${fmt(thdV, 1)}%`, thdV <= lossThdVLimit ? 'ok' : 'warn'),
      ].join('');
    }
    return { pf, thdI, thdV };
  }

  function readLossSettings() {
    lossPrice = Math.max(0, n($('lossPrice')?.value, lossPrice));
    lossUtilTarget = Math.min(100, Math.max(50, n($('lossUtilTarget')?.value, lossUtilTarget)));
    applyMeterAutoTargets();
    try {
      localStorage.setItem('pro_loss_cfg', JSON.stringify({
        price: lossPrice, util: lossUtilTarget,
      }));
    } catch (e) { /* ignore */ }
  }

  /**
   * Smart Loss algorithm (Rolling Mill):
   * 1) Idle energy waste — kWh burned in idle band × ₹/unit
   * 2) Stop opportunity — equivalent on-load energy during stop × 25% × ₹
   * 3) Util gap — if util < target, soft gap × avg on-load kW × 15% × ₹
   * 4) PF down — from meter vs auto PF target (I²R style)
   * 5) THD I — from meter vs auto I limit
   * 6) THD V — from meter vs auto V limit
   */
  function computeSmartLoss() {
    readLossSettings();
    const meter = applyMeterAutoTargets();
    const x = d();
    const st = periodBands ? bandsToStats(periodBands) : sessionStats();
    const pf = Math.max(0.01, meter.pf || n(tag(x, 'Total Power Factor_2', 'Average Power Factor_2', 'Power Factor L1_2'), 1));
    const thdI = meter.thdI;
    const thdV = meter.thdV;
    const totalKwh = Math.max(st.totalKwh, st.onKwh + st.idleKwh, 0.0001);
    const onH = st.on / 3600;
    const idleH = st.idle / 3600;
    const stopH = st.stop / 3600;
    const avgOnKw = onH > 0.0001 ? (st.onKwh / onH) : Math.max(n(x['Total Active Power_2']), 1);

    const idleKwh = Math.max(0, st.idleKwh);
    const idleRs = idleKwh * lossPrice;

    const stopOppKwh = avgOnKw * stopH * 0.25;
    const stopRs = stopOppKwh * lossPrice;

    const utilGap = Math.max(0, lossUtilTarget - st.util);
    const utilGapKwh = (utilGap / 100) * (onH + idleH) * avgOnKw * 0.15;
    const utilRs = utilGapKwh * lossPrice;

    const pfT = Math.max(lossPfTarget, 0.7);
    let pfFactor = 0;
    if (pf < pfT) {
      pfFactor = Math.max(0, (1 / (pf * pf)) - (1 / (pfT * pfT)));
    }
    const pfKwh = totalKwh * 0.06 * pfFactor;
    const pfRs = pfKwh * lossPrice;
    const pfLossPct = pf < pfT ? ((pfT - pf) / pfT) * 100 : 0;

    const thdIRatio = thdI / 100;
    let thdIKwh = totalKwh * (thdIRatio * thdIRatio);
    if (thdI > lossThdILimit) {
      thdIKwh *= (1 + (thdI - lossThdILimit) / lossThdILimit);
    }
    const thdIRs = thdIKwh * lossPrice;

    const thdVRatio = thdV / 100;
    let thdVKwh = totalKwh * (thdVRatio * thdVRatio) * 0.5; /* voltage THD weighted lower than current */
    if (thdV > lossThdVLimit) {
      thdVKwh *= (1 + (thdV - lossThdVLimit) / lossThdVLimit);
    }
    const thdVRs = thdVKwh * lossPrice;

    const factors = [
      { id: 'idle', label: 'Idle run', rs: idleRs, kwh: idleKwh, color: '#f59e0b',
        tip: 'Energy used between mill-start and on-load thresholds' },
      { id: 'stop', label: 'Stop opportunity', rs: stopRs, kwh: stopOppKwh, color: '#64748b',
        tip: '25% of equivalent on-load energy during stop time' },
      { id: 'util', label: 'Util gap', rs: utilRs, kwh: utilGapKwh, color: '#38bdf8',
        tip: `Util ${fmt(st.util, 1)}% vs target ${lossUtilTarget}%` },
      { id: 'pf', label: 'PF down', rs: pfRs, kwh: pfKwh, color: '#a78bfa',
        tip: `Meter PF ${fmt(pf, 3)} vs auto target ${fmt(pfT, 2)} · gap ${fmt(pfLossPct, 1)}%` },
      { id: 'thdi', label: 'I THD%', rs: thdIRs, kwh: thdIKwh, color: '#f472b6',
        tip: `Meter THD I ${fmt(thdI, 1)}% · auto limit ${fmt(lossThdILimit, 1)}%` },
      { id: 'thdv', label: 'V THD%', rs: thdVRs, kwh: thdVKwh, color: '#fb7185',
        tip: `Meter THD V ${fmt(thdV, 1)}% · auto limit ${fmt(lossThdVLimit, 1)}%` },
    ];
    const totalRs = factors.reduce((s, f) => s + f.rs, 0);
    const totalLossKwh = factors.reduce((s, f) => s + f.kwh, 0);
    factors.forEach((f) => {
      f.pct = totalRs > 0 ? (f.rs / totalRs) * 100 : 0;
    });

    const actions = [];
    if (idleRs > 0 && idleRs === Math.max(...factors.map((f) => f.rs))) {
      actions.push('Top loss = Idle run → reduce waiting with billet in mill; raise schedule density.');
    }
    if (st.util < lossUtilTarget) {
      actions.push(`Utilization ${fmt(st.util, 1)}% below ${lossUtilTarget}% → cut idle/stop gaps between passes.`);
    }
    if (pf < pfT) {
      actions.push(`Meter PF ${fmt(pf, 3)} below auto target ${fmt(pfT, 2)} → check APFC / capacitor bank.`);
    }
    if (thdI > lossThdILimit) {
      actions.push(`Meter THD I ${fmt(thdI, 1)}% above auto limit ${fmt(lossThdILimit, 1)}% → check drives / filters.`);
    }
    if (thdV > lossThdVLimit) {
      actions.push(`Meter THD V ${fmt(thdV, 1)}% above auto limit ${fmt(lossThdVLimit, 1)}% → check supply / resonance.`);
    }
    if (stopH > onH && onH > 0) {
      actions.push('Stop time exceeds on-load → review mill start readiness and CCM feed timing.');
    }
    if (!actions.length) {
      actions.push('Losses look controlled vs meter-based auto targets. Keep monitoring period trends.');
    }

    return {
      price: lossPrice,
      st, pf, thdI, thdV, avgOnKw, totalRs, totalLossKwh, factors, actions,
      pfTarget: lossPfTarget, thdILimit: lossThdILimit, thdVLimit: lossThdVLimit,
      source: periodBands ? 'period log' : 'live session',
      from: $('lossFromTime')?.value || '',
      to: $('lossToTime')?.value || '',
    };
  }

  function doughnutLoss(canvasId, factors) {
    const canvas = $(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    const data = factors.map((f) => Math.max(0, f.rs));
    const labels = factors.map((f) => f.label);
    const colors = factors.map((f) => f.color);
    if (charts[canvasId]) {
      charts[canvasId].data.labels = labels;
      charts[canvasId].data.datasets[0].data = data;
      charts[canvasId].data.datasets[0].backgroundColor = colors;
      charts[canvasId].update('none');
      return;
    }
    charts[canvasId] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#b6c3d4', boxWidth: 12, font: { size: 11 } } },
        },
        cutout: '58%',
      },
    });
  }

  function barLoss(canvasId, factors) {
    const canvas = $(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    const labels = factors.map((f) => f.label);
    const pcts = factors.map((f) => f.pct);
    const colors = factors.map((f) => f.color);
    if (charts[canvasId]) {
      charts[canvasId].data.labels = labels;
      charts[canvasId].data.datasets[0].data = pcts;
      charts[canvasId].data.datasets[0].backgroundColor = colors;
      charts[canvasId].update('none');
      return;
    }
    charts[canvasId] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '% of ₹ loss',
          data: pcts,
          backgroundColor: colors,
          borderWidth: 0,
          borderRadius: 6,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            max: 100,
            ticks: { color: '#8494a8', callback: (v) => v + '%' },
            grid: { color: 'rgba(148,163,184,0.12)' },
          },
          y: { ticks: { color: '#b6c3d4' }, grid: { display: false } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${fmt(c.raw, 1)}% of total ₹ loss` } },
        },
      },
    });
  }

  function paintLoss() {
    if (!$('lossTotalKpis')) return;
    if (!lossResult) {
      $('lossTotalKpis').innerHTML = [
        kpi('Total loss', '—', 'Calculate loss', ''),
        kpi('Loss kWh*', '—', 'equivalent', ''),
        kpi('Unit price', `₹${fmt(lossPrice, 1)}`, '/ kWh', ''),
        kpi('Source', '—', 'period or live', ''),
      ].join('');
      return;
    }
    const r = lossResult;
    const st = r.st;
    $('lossTotalKpis').innerHTML = [
      kpi('Total loss', `₹${fmt(r.totalRs, 0)}`, r.source, r.totalRs > 0 ? 'alarm' : 'ok'),
      kpi('Loss kWh*', fmt(r.totalLossKwh, 2), 'equivalent energy', 'warn'),
      kpi('Unit price', `₹${fmt(r.price, 1)}`, '/ kWh', ''),
      kpi('Util now', fmt(st.util, 1) + '%', `target ${lossUtilTarget}%`, st.util >= lossUtilTarget ? 'ok' : 'warn'),
    ].join('');
    $('lossFactorKpis').innerHTML = r.factors.map((f) =>
      kpi(f.label, `₹${fmt(f.rs, 0)}`, `${fmt(f.pct, 1)}% · ${fmt(f.kwh, 2)} kWh*`, f.rs > 0 ? 'warn' : 'ok')
    ).join('');

    doughnutLoss('chartLossMix', r.factors);
    if ($('lossMixBars')) {
      $('lossMixBars').innerHTML = r.factors.map((f) =>
        `<i style="width:${f.pct}%;background:${f.color}" title="${f.label}"></i>`
      ).join('');
    }
    if ($('lossMixNote')) {
      $('lossMixNote').textContent = r.factors.map((f) => `${f.label} ${fmt(f.pct, 1)}%`).join(' · ');
    }
    barLoss('chartLossBars', r.factors);

    applyMeterAutoTargets();
    if ($('lossDriverKpis')) {
      $('lossDriverKpis').innerHTML = [
        kpi('PF (meter)', fmt(r.pf, 3), `auto target ${fmt(r.pfTarget ?? lossPfTarget, 2)}`, r.pf >= (r.pfTarget ?? lossPfTarget) ? 'ok' : 'alarm'),
        kpi('THD I (meter)', fmt(r.thdI, 1) + '%', `auto limit ${fmt(r.thdILimit ?? lossThdILimit, 1)}%`, r.thdI <= (r.thdILimit ?? lossThdILimit) ? 'ok' : 'alarm'),
        kpi('THD V (meter)', fmt(r.thdV, 1) + '%', `auto limit ${fmt(r.thdVLimit ?? lossThdVLimit, 1)}%`, r.thdV <= (r.thdVLimit ?? lossThdVLimit) ? 'ok' : 'alarm'),
        kpi('On / Idle / Stop', `${fmtTime(st.on)}`, `Idle ${fmtTime(st.idle)} · Stop ${fmtTime(st.stop)}`, ''),
      ].join('');
    }
    if ($('lossActions')) {
      $('lossActions').innerHTML = r.actions.map((a) => `<div class="loss-item">${a}</div>`).join('');
    }
    if ($('lossAlgoNote')) {
      $('lossAlgoNote').textContent =
        'Algorithm: Idle kWh×₹ + Stop opportunity (25%) + Util gap (15%) + PF I²R share + THD² heating. *kWh are equivalent loss units for cost.';
    }
    if ($('lossMeta')) {
      const from = (r.from || '').replace('T', ' ');
      const to = (r.to || '').replace('T', ' ');
      $('lossMeta').textContent =
        `${from || 'session'} → ${to || 'now'} · ₹${fmt(r.totalRs, 0)} total · ${r.source} · ${new Date().toLocaleString('en-GB')}`;
    }
  }

  async function calculateSmartLoss() {
    initLossDefaults();
    readLossSettings();
    /* Align EMS period inputs then refresh bands for selected loss range */
    if ($('lossFromTime')?.value && $('emsFromTime')) $('emsFromTime').value = $('lossFromTime').value;
    if ($('lossToTime')?.value && $('emsToTime')) $('emsToTime').value = $('lossToTime').value;
    if ($('lossMeta')) $('lossMeta').textContent = 'Calculating smart loss…';
    if ($('lossFromTime')?.value && $('lossToTime')?.value) {
      await loadEmsPeriod();
    }
    lossResult = computeSmartLoss();
    paintLoss();
  }

  function buildLossPrintSheet() {
    const sheet = $('lossPrintSheet');
    if (!sheet || !lossResult) return;
    const r = lossResult;
    sheet.innerHTML = `
      <div class="ps-head">
        <div>
          <h1>SUGNA SPONGE AND POWER PVT LTD</h1>
          <p>Smart Detector · Rolling Mill</p>
          <p>${(r.from || '').replace('T', ' ')} → ${(r.to || '').replace('T', ' ')} · Printed ${new Date().toLocaleString('en-GB')}</p>
        </div>
        <div class="ps-right">₹${fmt(r.totalRs, 0)}</div>
      </div>
      <div class="ps-sec">Total</div>
      <div class="ps-grid">
        <div class="ps-kpi"><div class="l">Total loss</div><div class="v">₹${fmt(r.totalRs, 0)}</div><div class="s">${r.source}</div></div>
        <div class="ps-kpi"><div class="l">Loss kWh*</div><div class="v">${fmt(r.totalLossKwh, 2)}</div><div class="s">₹${fmt(r.price, 1)}/kWh</div></div>
        <div class="ps-kpi"><div class="l">Util</div><div class="v">${fmt(r.st.util, 1)}%</div><div class="s">target ${lossUtilTarget}%</div></div>
        <div class="ps-kpi"><div class="l">PF / THD I / THD V</div><div class="v">${fmt(r.pf, 3)} / ${fmt(r.thdI, 1)}% / ${fmt(r.thdV, 1)}%</div><div class="s">auto ${fmt(r.pfTarget, 2)} / ${fmt(r.thdILimit, 1)}% / ${fmt(r.thdVLimit, 1)}%</div></div>
      </div>
      <div class="ps-sec">Factor breakdown</div>
      <table>
        <thead><tr><th>Factor</th><th>₹ loss</th><th>%</th><th>kWh*</th><th>Note</th></tr></thead>
        <tbody>
          ${r.factors.map((f) => `<tr><td>${f.label}</td><td>${fmt(f.rs, 2)}</td><td>${fmt(f.pct, 1)}</td><td>${fmt(f.kwh, 2)}</td><td>${f.tip}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="ps-sec">Actions</div>
      <p>${r.actions.join('<br>')}</p>
      <p class="ps-foot">Coding by Amazad Ali · Steel EMS Pro</p>`;
  }

  function printLoss() {
    if (!lossResult) { alert('Calculate loss first'); return; }
    buildLossPrintSheet();
    document.body.classList.add('print-loss');
    window.print();
    setTimeout(() => document.body.classList.remove('print-loss'), 500);
  }

  function exportLossExcel() {
    if (!lossResult) { alert('Calculate loss first'); return; }
    const r = lossResult;
    const lines = [];
    lines.push(['SUGNA SPONGE AND POWER PVT LTD'].map(csvEscape).join(','));
    lines.push(['Smart Detector · Rolling Mill'].map(csvEscape).join(','));
    lines.push(['From', (r.from || '').replace('T', ' '), 'To', (r.to || '').replace('T', ' ')].map(csvEscape).join(','));
    lines.push(['Unit price ₹/kWh', r.price, 'Source', r.source].map(csvEscape).join(','));
    lines.push(['Total loss ₹', fmt(r.totalRs, 2), 'Loss kWh*', fmt(r.totalLossKwh, 2)].map(csvEscape).join(','));
    lines.push(['PF meter', fmt(r.pf, 3), 'PF auto target', fmt(r.pfTarget, 2)].map(csvEscape).join(','));
    lines.push(['THD I meter %', fmt(r.thdI, 1), 'THD I auto limit', fmt(r.thdILimit, 1)].map(csvEscape).join(','));
    lines.push(['THD V meter %', fmt(r.thdV, 1), 'THD V auto limit', fmt(r.thdVLimit, 1)].map(csvEscape).join(','));
    lines.push(['Util %', fmt(r.st.util, 1)].map(csvEscape).join(','));
    lines.push('');
    lines.push(['Factor', '₹ loss', '%', 'kWh*', 'Note'].map(csvEscape).join(','));
    r.factors.forEach((f) => {
      lines.push([f.label, fmt(f.rs, 2), fmt(f.pct, 1), fmt(f.kwh, 2), f.tip].map(csvEscape).join(','));
    });
    lines.push('');
    lines.push(['Actions'].map(csvEscape).join(','));
    r.actions.forEach((a) => lines.push([a].map(csvEscape).join(',')));
    const stamp = todayStr().replace(/-/g, '');
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Sugna_Smart_Loss_${stamp}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function paintHealth() {
    const age = ageSec();
    const st = sessionStats();
    $('healthCards').innerHTML = [
      kpi('PLC', live.connected ? 'ONLINE' : 'OFFLINE', live.plc_ip || live.error || '—', live.connected ? 'ok' : 'alarm'),
      kpi('DB8', live.billets_ok ? 'OK' : 'FAIL', 'HMD + counts', live.billets_ok ? 'ok' : 'alarm'),
      kpi('Poll age', age == null ? '—' : fmt(age, 1) + ' s', 'fresh &lt; 3s', age != null && age < 3 ? 'ok' : 'warn'),
      kpi('Start thr', String(startKw), 'kW', ''),
      kpi('On-load thr', String(onloadKw), 'kW', ''),
      kpi('Save folder', dataFolder.log_dir ? 'SET' : '—', dataFolder.log_dir ? dataFolder.log_dir.split(/[/\\]/).slice(-2).join('\\') : 'choose path', dataFolder.log_dir ? 'ok' : 'warn'),
      kpi('Session run', fmtTime(st.run), `Util ${fmt(st.util, 1)}%`, 'ok'),
    ].join('');
    paintDataFolderUI();
  }

  function paint() {
    paintConn();
    const active = document.querySelector('.view.active')?.id?.replace('view-', '') || 'home';
    if (active === 'home') paintHome();
    if (active === 'ccm') paintCcm();
    if (active === 'hmd') paintHmd();
    if (active === 'energy') paintEnergy();
    if (active === 'loss') paintLoss();
    if (active === 'report') paintReport();
    if (active === 'soon') paintSoon();
    if (active === 'health') paintHealth();
  }

  async function pullThresholds() {
    try {
      const j = await fetch('/api/mes/thresholds', { cache: 'no-store' }).then((r) => r.json());
      if (j.ok) {
        if (j.start_kw != null) startKw = n(j.start_kw, startKw);
        if (j.onload_kw != null) onloadKw = n(j.onload_kw, onloadKw);
        if ($('thrStart')) $('thrStart').value = startKw;
        if ($('thrOn')) $('thrOn').value = onloadKw;
        if ($('thrStartRm')) $('thrStartRm').value = startKw;
        if ($('thrOnRm')) $('thrOnRm').value = onloadKw;
        if ($('thrStartEms')) $('thrStartEms').value = startKw;
        if ($('thrOnEms')) $('thrOnEms').value = onloadKw;
        mergeServerSession(j.session);
      }
    } catch (e) { /* optional */ }
  }

  async function poll() {
    try {
      const res = await fetch('/api/live', { cache: 'no-store' });
      const j = await res.json();
      live = {
        connected: !!j.connected,
        data: j.data || {},
        timestamp: j.timestamp,
        billets_ok: !!j.billets_ok,
        plc_ip: j.plc_ip,
        error: j.error,
      };
      const data = j.data || {};
      const kw = n(data['Total Active Power_2']);
      const kva = n(data['Total Apparent Power_2']);
      tickSession(kw, kva);
      loadSharedHeat();
      tickCcmHeat();
    } catch (e) {
      live.connected = false;
      live.error = String(e.message || e);
    }
    paint();
  }

  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView(btn.getAttribute('data-view'), btn.getAttribute('data-dept') || undefined);
    });
  });
  document.querySelectorAll('[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView(btn.getAttribute('data-go'), btn.getAttribute('data-dept') || undefined);
    });
  });
  function syncDeptChevrons() {
    document.querySelectorAll('.dept').forEach((el) => {
      const open = el.classList.contains('open');
      const hd = el.querySelector('.dept-hd');
      if (hd) hd.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function saveDeptNav() {
    const state = {};
    document.querySelectorAll('.dept[data-dept-group]').forEach((el) => {
      state[el.getAttribute('data-dept-group')] = el.classList.contains('open');
    });
    try { localStorage.setItem('pro_dept_nav', JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function loadDeptNav() {
    /* Start all departments minimized; user expands as needed */
    document.querySelectorAll('.dept[data-dept-group]').forEach((el) => {
      el.classList.remove('open');
    });
    syncDeptChevrons();
    try {
      localStorage.setItem('pro_dept_nav', JSON.stringify({
        ccm: false, mill: false, cpp: false, dri: false,
      }));
    } catch (e) { /* ignore */ }
  }

  function setDeptOpen(key, open, persist = true) {
    const panel = document.querySelector(`.dept[data-dept-group="${key}"]`);
    if (!panel) return;
    panel.classList.toggle('open', !!open);
    syncDeptChevrons();
    if (persist) saveDeptNav();
  }

  document.querySelectorAll('[data-dept-toggle]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const key = btn.getAttribute('data-dept-toggle');
      const panel = document.querySelector(`.dept[data-dept-group="${key}"]`);
      if (!panel) return;
      panel.classList.toggle('open');
      syncDeptChevrons();
      saveDeptNav();
    });
  });
  loadDeptNav();
  $('btnRefresh').addEventListener('click', () => { poll(); pullThresholds(); loadHeats(); refreshDataFolder(); });

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.closest('[data-log-dir-save]')) {
      saveDataFolder(t);
      return;
    }
    if (t.closest('[data-log-dir-refresh]')) {
      refreshDataFolder();
      return;
    }
    if (t.closest('[data-log-dir-default]')) {
      const def = dataFolder.default_log_dir || 'D:\\Smart EMS and MIS Project\\Plant_Data';
      document.querySelectorAll('[data-log-dir-input]').forEach((el) => { el.value = def; });
      return;
    }
    if (t.closest('[data-log-dir-export]')) {
      window.location.href = '/api/data/export.zip';
    }
  });
  function resetMillTimers() {
    if (!confirm('Reset Rolling Mill session timers (on-load / idle / stop)?')) return;
    session = { onLoadSec: 0, idleSec: 0, stopSec: 0, onLoadKwh: 0, idleKwh: 0, totalKwh: 0, totalKvah: 0 };
    lastTick = performance.now();
    paint();
  }
  $('btnResetSess')?.addEventListener('click', resetMillTimers);
  $('btnResetSessRm')?.addEventListener('click', resetMillTimers);

  function applyThresholdInputs(startEl, onEl) {
    startKw = Math.max(0, n(startEl?.value, startKw));
    onloadKw = Math.max(startKw + 1, n(onEl?.value, onloadKw));
    if ($('thrStart')) $('thrStart').value = startKw;
    if ($('thrOn')) $('thrOn').value = onloadKw;
    if ($('thrStartRm')) $('thrStartRm').value = startKw;
    if ($('thrOnRm')) $('thrOnRm').value = onloadKw;
    if ($('thrStartEms')) $('thrStartEms').value = startKw;
    if ($('thrOnEms')) $('thrOnEms').value = onloadKw;
    fetch('/api/mes/thresholds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_kw: startKw, onload_kw: onloadKw }),
    }).catch(() => {});
    paint();
  }
  $('thrStart')?.addEventListener('change', () => applyThresholdInputs($('thrStart'), $('thrOn')));
  $('thrOn')?.addEventListener('change', () => applyThresholdInputs($('thrStart'), $('thrOn')));
  $('thrStartRm')?.addEventListener('change', () => applyThresholdInputs($('thrStartRm'), $('thrOnRm')));
  $('thrOnRm')?.addEventListener('change', () => applyThresholdInputs($('thrStartRm'), $('thrOnRm')));
  $('thrStartEms')?.addEventListener('change', () => applyThresholdInputs($('thrStartEms'), $('thrOnEms')));
  $('thrOnEms')?.addEventListener('change', () => applyThresholdInputs($('thrStartEms'), $('thrOnEms')));

  document.querySelectorAll('[data-acc-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-acc-toggle');
      const panel = document.querySelector(`.acc[data-acc="${key}"]`);
      if (panel) panel.classList.toggle('open');
    });
  });

  $('rptType')?.addEventListener('change', () => {
    syncReportFilterUI();
    if (($('rptType').value || '') === 'heat') loadHeats();
  });
  $('btnRptLoad')?.addEventListener('click', () => loadHeats());
  $('btnRptPrint')?.addEventListener('click', () => printReport());
  $('btnRptExcel')?.addEventListener('click', () => exportReportExcel());
  $('btnEmsPeriodLoad')?.addEventListener('click', () => loadEmsPeriod());
  $('btnEmsMonthExcel')?.addEventListener('click', () => exportEmsMonthExcel());
  $('btnEmsPrint')?.addEventListener('click', () => printEmsPeriod());
  $('btnEmsExcel')?.addEventListener('click', () => exportEmsExcel());
  $('emsWindowPreset')?.addEventListener('change', () => {
    applyEmsWindowPreset(true);
  });
  $('emsDayStartHour')?.addEventListener('change', () => {
    if (($('emsWindowPreset')?.value || '') !== 'custom') applyEmsWindowPreset(true);
  });
  ['emsFromTime', 'emsToTime'].forEach((id) => {
    $(id)?.addEventListener('change', () => {
      if ($('emsWindowPreset')) $('emsWindowPreset').value = 'custom';
    });
  });
  $('btnLossCalc')?.addEventListener('click', () => calculateSmartLoss());
  $('btnLossPrint')?.addEventListener('click', () => printLoss());
  $('btnLossExcel')?.addEventListener('click', () => exportLossExcel());
  ['lossPrice', 'lossUtilTarget'].forEach((id) => {
    $(id)?.addEventListener('change', () => { readLossSettings(); if (lossResult) calculateSmartLoss(); });
  });
  $('rptHeat')?.addEventListener('change', () => {
    if (($('rptType')?.value || '') === 'heat') loadHeats();
  });

  $('btnCcmStartHeat')?.addEventListener('click', () => {
    if (startSharedHeat({ auto: false })) paint();
    else alert('Heat already open');
  });
  $('btnCcmEndHeat')?.addEventListener('click', () => {
    if (endSharedHeat({ auto: false })) paint();
  });
  window.addEventListener('storage', (ev) => {
    if (ev.key === SHARED_HEAT_KEY) {
      loadSharedHeat();
      paint();
    }
  });

  try {
    const saved = JSON.parse(localStorage.getItem('pro_thr') || 'null');
    if (saved) {
      startKw = n(saved.start, startKw);
      onloadKw = n(saved.on, onloadKw);
    }
  } catch (e) { /* ignore */ }
  setInterval(() => {
    try { localStorage.setItem('pro_thr', JSON.stringify({ start: startKw, on: onloadKw })); } catch (e) { /* ignore */ }
  }, 5000);

  loadSharedHeat();
  refreshDataFolder();
  const hash = (location.hash || '').replace('#', '');
  if (META[hash]) showView(hash);
  pullThresholds();
  poll();
  setInterval(poll, 1000);
  setInterval(pullThresholds, 10000);
})();
