/* CCM + Rolling Mill MIS — DB8 BILLETS_COUNTS live HMD + heat reports */
(function () {
  /* Map UI stage id → PLC DB8 DWord count tag + Bool HMD tag */
  const HMD_STAGES = [
    { id: 'entry',  label: 'Mill Entry',  countTag: 'CCM_RM_ENTRY_COUNTS', hmdTag: 'CCM_RM_ENTRY_HMD' },
    { id: 'r3',     label: 'R3 Stand',    countTag: 'R3_COUNTS',           hmdTag: 'R3_HMD' },
    { id: 'ccs1',   label: 'CCS1',        countTag: 'CCS1_COUNTS',         hmdTag: 'CCS1_HMD' },
    { id: 'ccs2',   label: 'CCS2',        countTag: 'CCS2_COUNTS',         hmdTag: 'CCS2_HMD' },
    { id: 'dd',     label: 'DD Shear',    countTag: 'DSHEAR_COUNTS',       hmdTag: 'DSHEAR_HMD' },
    { id: 'blkIn',  label: 'Block Entry', countTag: 'BLOCK_ENTRY_COUNTS',  hmdTag: 'BLOCK_ENTRY_HMD' },
    { id: 'blkOut', label: 'Block Exit',  countTag: 'BLOCK_EXIT_COUNTS',   hmdTag: 'BLOCK_EXIT_HMD' },
    { id: 'tmt',    label: 'TMT',         countTag: 'TMT_COUNTS',          hmdTag: 'TMT_HMD' },
  ];
  const CCM_COUNT_TAGS = { s1: 'CCM_STAND1_COUNTS', s2: 'CCM_STAND2_COUNTS' };
  const CCM_HMD_TAGS = { s1: 'CCM_STAND1_HMD', s2: 'CCM_STAND2_HMD' };

  let lastLiveKw = 0, lastLiveKwh = null, lastMisTs = null;
  let millStartOn = false;
  let rmAutoTimer = null;
  let rmTickTimer = null; // UI timing independent of poll gaps
  let plcHmdLive = false;   // true when DB8 counts present on live payload
  let plcAbsCounts = Object.fromEntries(HMD_STAGES.map(s => [s.id, 0]));
  let plcAbsCcm = { s1: 0, s2: 0 };
  let plcHmdBits = Object.fromEntries(HMD_STAGES.map(s => [s.id, false]));
  let plcCcmBits = { s1: false, s2: false };
  let rmBaseline = null;    // absolute counts at RM heat start
  let ccmBaseline = null;   // absolute CCM strand counts at heat start
  /** Session timers from HT kW bands (no manual START) */
  let rmSession = { onLoadSec: 0, idleSec: 0, stopSec: 0, onLoadKwh: 0, idleKwh: 0, totalKwh: 0 };

  let ccmActive = false;
  let ccmHeat = null;
  /* CCM timing algorithm (easy plant rules)
   *  START  → any strand HMD rising edge (or count +1)
   *  CAST   → keep heat open ~75 minutes, then auto End & save
   *  CYCLE  → next auto-start only after 2.3 hours from that heat's start
   */
  const CCM_CAST_MIN_DEFAULT = 75;
  const CCM_CYCLE_HR_DEFAULT = 2.3;
  let prevCcmBits = { s1: false, s2: false };
  let prevCcmAbsForEdge = { s1: 0, s2: 0 };
  let ccmEdgePrimed = false; /* skip first sample so live counts don't false-start a heat */
  let ccmLastStartedAt = null; /* epoch ms — used for 2.3 h cycle gate */
  let ccmBillets = [];
  let ccmBilSeq = 0;
  /** Keep strand box green briefly after HMD pulse / count edge (both stands) */
  let ccmSenseHoldUntil = { s1: 0, s2: 0 };
  try {
    const savedStart = Number(localStorage.getItem('ccm_last_started_at') || 0);
    if (savedStart > 0) ccmLastStartedAt = savedStart;
  } catch (e) { /* ignore */ }
  let ccmStore = [];

  let rmActive = false;
  let rmHeat = null;
  let rmStore = [];
  /** Heat-relative (or absolute when no heat) counts shown in UI */
  let hmdCounts = Object.fromEntries(HMD_STAGES.map(s => [s.id, 0]));

  function emptyStageMap() {
    return Object.fromEntries(HMD_STAGES.map(s => [s.id, 0]));
  }
  function readPlcAbsFromData(d) {
    const abs = emptyStageMap();
    let any = false;
    HMD_STAGES.forEach(s => {
      if (d[s.countTag] != null && Number.isFinite(Number(d[s.countTag]))) {
        abs[s.id] = Math.max(0, Math.floor(Number(d[s.countTag])));
        any = true;
      }
    });
    const ccm = {
      s1: d[CCM_COUNT_TAGS.s1] != null ? Math.max(0, Math.floor(Number(d[CCM_COUNT_TAGS.s1]))) : plcAbsCcm.s1,
      s2: d[CCM_COUNT_TAGS.s2] != null ? Math.max(0, Math.floor(Number(d[CCM_COUNT_TAGS.s2]))) : plcAbsCcm.s2,
    };
    if (d[CCM_COUNT_TAGS.s1] != null || d[CCM_COUNT_TAGS.s2] != null) any = true;
    const asBit = (v) => {
      if (v === true || v === 1 || v === '1' || v === 'true' || v === 'TRUE') return true;
      if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return true;
      return false;
    };
    const bits = {};
    HMD_STAGES.forEach(s => { bits[s.id] = asBit(d[s.hmdTag]); });
    const ccmBits = { s1: asBit(d[CCM_HMD_TAGS.s1]), s2: asBit(d[CCM_HMD_TAGS.s2]) };
    return { abs, ccm, bits, ccmBits, any, billetsOk: d._billets_ok !== false && any };
  }
  function heatRel(abs, baseline) {
    const out = emptyStageMap();
    HMD_STAGES.forEach(s => {
      out[s.id] = Math.max(0, (abs[s.id] || 0) - (baseline?.[s.id] || 0));
    });
    return out;
  }
  function ccmHeatRel(absCcm, baseline) {
    return {
      s1: Math.max(0, (absCcm.s1 || 0) - (baseline?.s1 || 0)),
      s2: Math.max(0, (absCcm.s2 || 0) - (baseline?.s2 || 0)),
    };
  }
  function refCount(counts) {
    /* Miss-roll reference = R3 (PLC). Fall back to legacy r1 for old heats. */
    return counts.r3 ?? counts.r1 ?? 0;
  }
  /* Billet cut length varies by heat — typically 5600–9000 mm */
  const BILLET_L_MIN = 5600;
  const BILLET_L_MAX = 9000;
  const BILLET_L_STEP = 100;
  const BILLET_L_KEY = 'rm_billet_dims';

  function clampBilletLength(mm) {
    let L = Math.round(n(mm, 6000));
    if (!Number.isFinite(L)) L = 6000;
    return Math.max(BILLET_L_MIN, Math.min(BILLET_L_MAX, L));
  }

  /** Unit weight (metric tons / billet) = volume m³ × density t/m³ */
  function billetUnitTon(wMm, hMm, lMm, density) {
    const w = n(wMm, 110) / 1000;
    const h = n(hMm, 110) / 1000;
    const L = clampBilletLength(lMm) / 1000;
    const dens = n(density, 7.85);
    return w * h * L * dens;
  }

  function fillLengthSelect(sel, selected) {
    if (!sel) return;
    const cur = clampBilletLength(selected != null ? selected : sel.value);
    const opts = [];
    for (let L = BILLET_L_MIN; L <= BILLET_L_MAX; L += BILLET_L_STEP) opts.push(L);
    if (!opts.includes(cur)) opts.push(cur);
    opts.sort((a, b) => a - b);
    sel.innerHTML = opts.map(L =>
      `<option value="${L}" ${L === cur ? 'selected' : ''}>${L} mm${L === 6000 ? ' (std)' : ''}</option>`
    ).join('');
  }

  function unitTonFromInputs(wId, hId, lId, dId) {
    const w = n(document.getElementById(wId)?.value, 110);
    const h = n(document.getElementById(hId)?.value, 110);
    const L = clampBilletLength(document.getElementById(lId)?.value);
    const dens = n(document.getElementById(dId)?.value, 7.85);
    return billetUnitTon(w, h, L, dens);
  }

  function rmBilletDims() {
    const sel = document.getElementById('rmBilletL');
    const customEl = document.getElementById('rmBilletLCustom');
    const L = clampBilletLength(sel?.value || customEl?.value || 6000);
    return {
      w: n(document.getElementById('rmBilletW')?.value, 110),
      h: n(document.getElementById('rmBilletH')?.value, 110),
      L,
      density: n(document.getElementById('rmDensity')?.value, 7.85),
    };
  }

  function syncRmLengthUI(fromCustom) {
    const sel = document.getElementById('rmBilletL');
    const custom = document.getElementById('rmBilletLCustom');
    if (!sel || !custom) return;
    if (fromCustom) {
      const L = clampBilletLength(custom.value);
      custom.value = String(L);
      fillLengthSelect(sel, L);
    } else {
      const L = clampBilletLength(sel.value);
      custom.value = String(L);
    }
  }

  function rmUnitTon() {
    const d = rmBilletDims();
    return billetUnitTon(d.w, d.h, d.L, d.density);
  }

  function refreshRmBilletFormula() {
    const el = document.getElementById('rmBilletFormula');
    if (!el) return;
    const d = rmBilletDims();
    const unit = billetUnitTon(d.w, d.h, d.L, d.density);
    const loss = typeof hmdLoss === 'function' ? hmdLoss() : { tmt: 0, miss: 0, r3: 0 };
    const good = (loss.tmt || 0) * unit;
    const missT = (loss.miss || 0) * unit;
    el.textContent =
      `Section ${d.w}×${d.h}×${d.L} mm · density ${d.density} t/m³ → unit ${unit.toFixed(4)} t/billet · ` +
      `Good ${good.toFixed(3)} t (${loss.tmt || 0}×unit) · Miss ${missT.toFixed(3)} t`;
  }

  function persistRmBilletDims() {
    try { localStorage.setItem(BILLET_L_KEY, JSON.stringify(rmBilletDims())); } catch (e) { /* ignore */ }
  }
  function loadRmBilletDims() {
    try {
      const d = JSON.parse(localStorage.getItem(BILLET_L_KEY) || 'null');
      if (!d) return;
      const w = document.getElementById('rmBilletW');
      const h = document.getElementById('rmBilletH');
      const dens = document.getElementById('rmDensity');
      if (w && d.w) w.value = d.w;
      if (h && d.h) h.value = d.h;
      if (dens && d.density) dens.value = d.density;
      fillLengthSelect(document.getElementById('rmBilletL'), d.L);
      syncRmLengthUI(false);
    } catch (e) { /* ignore */ }
  }

  function syncRmSizeFromCcm() {
    const w = document.getElementById('ccmBilletW')?.value;
    const h = document.getElementById('ccmBilletH')?.value;
    const L = document.getElementById('ccmBilletL')?.value;
    const dens = document.getElementById('ccmDensity')?.value;
    if (w) document.getElementById('rmBilletW').value = w;
    if (h) document.getElementById('rmBilletH').value = h;
    if (dens) document.getElementById('rmDensity').value = dens;
    if (L) {
      fillLengthSelect(document.getElementById('rmBilletL'), L);
      syncRmLengthUI(false);
    }
    persistRmBilletDims();
    refreshRmBilletFormula();
    if (typeof renderRmPanels === 'function') renderRmPanels();
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function dayBounds(dateStr) {
    return { start: dateStr + 'T00:00:00', end: dateStr + 'T23:59:59' };
  }
  function monthBounds(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return {
      start: `${ym}-01T00:00:00`,
      end: `${ym}-${String(last).padStart(2, '0')}T23:59:59`,
    };
  }

  async function postProd(kind, row) {
    let ok = false;
    try {
      const res = await fetch(`${BRIDGE_ORIGIN}/api/production/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      });
      const j = await res.json();
      ok = !!j.ok;
    } catch (e) { /* continue to MES path */ }
    // Dual-write into MES SQLite for Plant MES dashboards / reports
    try {
      const mesKind = kind === 'ccm_heats' ? 'ccm' : 'rm';
      const token = localStorage.getItem('mes_token') || '';
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      await fetch(`${BRIDGE_ORIGIN}/api/mes/heats/${mesKind}`, {
        method: 'POST', headers, body: JSON.stringify(row),
      });
    } catch (e) { /* optional */ }
    return ok;
  }
  async function loadProd(kind, start, end) {
    try {
      let url = `${BRIDGE_ORIGIN}/api/production/${kind}`;
      if (start && end) url += `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
      const res = await fetch(url, { cache: 'no-store' });
      const j = await res.json();
      if (j.ok && Array.isArray(j.rows)) return j.rows;
    } catch (e) { /* fall back local */ }
    return null;
  }
  function localKey(kind) { return 'plant_' + kind; }
  function loadLocal(kind) {
    try { return JSON.parse(localStorage.getItem(localKey(kind)) || '[]'); } catch (e) { return []; }
  }
  function saveLocal(kind, rows) {
    localStorage.setItem(localKey(kind), JSON.stringify(rows.slice(0, 500)));
  }
  async function persistHeat(kind, row) {
    const ok = await postProd(kind, row);
    const list = loadLocal(kind);
    list.unshift(row);
    saveLocal(kind, list);
    if (kind === 'ccm_heats') ccmStore = list;
    if (kind === 'rm_heats') rmStore = list;
    return ok;
  }
  async function refreshStores() {
    const ccmDisk = await loadProd('ccm_heats');
    const rmDisk = await loadProd('rm_heats');
    ccmStore = ccmDisk && ccmDisk.length ? ccmDisk.slice().reverse() : loadLocal('ccm_heats');
    rmStore = rmDisk && rmDisk.length ? rmDisk.slice().reverse() : loadLocal('rm_heats');
    if (ccmDisk) saveLocal('ccm_heats', ccmStore);
    if (rmDisk) saveLocal('rm_heats', rmStore);
  }
  window.refreshStores = refreshStores;

  /* ——— CCM ——— */
  window.refreshCcmFormula = function refreshCcmFormula() {
    const s1 = Math.max(0, parseInt(document.getElementById('ccmS1').value, 10) || 0);
    const s2 = Math.max(0, parseInt(document.getElementById('ccmS2').value, 10) || 0);
    const total = s1 + s2;
    const unit = unitTonFromInputs('ccmBilletW', 'ccmBilletH', 'ccmBilletL', 'ccmDensity');
    const tons = total * unit;
    const src = plcHmdLive ? 'DB8 · CCM_STAND*_COUNTS' : 'manual / demo';
    const pulse = (on) => on ? ' · HMD ON' : '';
    document.getElementById('ccmFormula').textContent =
      `Total billets = ${s1}+${s2} = ${total}  ·  Unit = ${unit.toFixed(4)} t  ·  Heat tons = ${tons.toFixed(3)} t  ·  ${src}`;
    const shared = (typeof window.getSharedPlantTags === 'function') ? window.getSharedPlantTags() : null;
    document.getElementById('ccmLiveKpis').innerHTML = [
      kpiHTML({ label: 'Strand 1 HMD', value: String(s1), unit: 'pcs', sub: `STAND1_COUNTS${pulse(plcCcmBits.s1)}`, barPct: pct(s1, 0, 80), lo: '0', hi: '80' }),
      kpiHTML({ label: 'Strand 2 HMD', value: String(s2), unit: 'pcs', sub: `STAND2_COUNTS${pulse(plcCcmBits.s2)}`, barPct: pct(s2, 0, 80), lo: '0', hi: '80' }),
      kpiHTML({ label: 'Total billets', value: String(total), unit: 'pcs', sub: 'S1 + S2', barPct: pct(total, 0, 120), lo: '0', hi: '120' }),
      kpiHTML({ label: 'Heat tons', value: fmt(tons, 3), unit: 't', sub: 'pcs × unit weight', barPct: pct(tons, 0, 80), lo: '0', hi: '80' }),
      ...(shared ? [
        kpiHTML({ label: 'On-load time', value: fmtTime(shared.on_load_sec), unit: '', sub: `HT > ${shared.onload_kw} kW · same as HMD`, barPct: pct(shared.util_pct, 0, 100), lo: '0', hi: '100%' }),
        kpiHTML({ label: 'Idle run', value: fmtTime(shared.idle_sec), unit: '', sub: `${shared.start_kw}–${shared.onload_kw} kW · same as HMD`, barPct: pct(100 - shared.util_pct, 0, 100), lo: '0', hi: '100%' }),
        kpiHTML({ label: 'R3 / TMT', value: `${shared.r3} / ${shared.tmt}`, unit: 'pcs', sub: `Miss ${shared.miss} · Entry ${shared.entry}`, barPct: pct(shared.yield_pct, 0, 100), lo: '0', hi: '100%' }),
        kpiHTML({ label: 'HT load', value: fmt(shared.ht_kw, 1), unit: 'kW', sub: shared.mill_label, barPct: pct(shared.ht_kw, 0, Math.max(shared.onload_kw * 1.2, 2000)), lo: '0', hi: String(shared.onload_kw) }),
      ] : []),
    ].join('');
    if (ccmActive && ccmHeat) {
      ccmHeat.s1 = s1; ccmHeat.s2 = s2; ccmHeat.totalPcs = total; ccmHeat.unitTon = unit; ccmHeat.tons = tons;
      ccmHeat.plcAbs = { ...plcAbsCcm };
    }
    if (typeof window.renderSharedLiveStrips === 'function') window.renderSharedLiveStrips();
  };

  window.renderCcmTable = function renderCcmTable() {
    const body = document.getElementById('ccmHeatBody');
    if (!ccmStore.length) {
      body.innerHTML = `<tr><td colspan="9" class="empty">No CCM heats saved</td></tr>`;
      return;
    }
    body.innerHTML = ccmStore.map(h => {
      const castMin = h.castMin != null ? Number(h.castMin).toFixed(1)
        : (h.startedAt && h.endedAt
          ? ((new Date(h.endedAt) - new Date(h.startedAt)) / 60000).toFixed(1)
          : '—');
      return `<tr>
      <td>${h.heatNo}</td>
      <td>${(h.startedAt || '').replace('T', ' ').slice(0, 19)}</td>
      <td>${(h.endedAt || '').replace('T', ' ').slice(0, 19)}</td>
      <td>${castMin} min</td>
      <td>${h.s1}</td><td>${h.s2}</td><td>${h.totalPcs}</td>
      <td>${Number(h.tons).toFixed(3)}</td>
      <td>${h.auto ? 'AUTO' : (h.source || 'manual')}</td>
    </tr>`;
    }).join('');
  };

  function ccmTimingConfig() {
    const castMin = Math.max(10, Number(document.getElementById('ccmCastMin')?.value) || CCM_CAST_MIN_DEFAULT);
    const cycleHr = Math.max(0.5, Number(document.getElementById('ccmCycleHr')?.value) || CCM_CYCLE_HR_DEFAULT);
    return {
      castMin,
      cycleHr,
      castMs: castMin * 60 * 1000,
      cycleMs: cycleHr * 3600 * 1000,
    };
  }

  function nextCcmAutoHeatNo() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    return `C-AUTO-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function rememberCcmStart(ts) {
    ccmLastStartedAt = ts;
    try { localStorage.setItem('ccm_last_started_at', String(ts)); } catch (e) { /* ignore */ }
  }

  /** Can we auto-start a new CCM heat? Cycle gap from last start ≥ 2.3 h */
  function ccmCycleReady(now = Date.now()) {
    const { cycleMs } = ccmTimingConfig();
    if (!ccmLastStartedAt) return { ready: true, waitMs: 0 };
    const elapsed = now - ccmLastStartedAt;
    if (elapsed >= cycleMs) return { ready: true, waitMs: 0 };
    return { ready: false, waitMs: cycleMs - elapsed };
  }

  function spawnCcmBillet(strand) {
    const host = document.getElementById('ccmBillets');
    if (!host) return;
    const id = ++ccmBilSeq;
    const leftStart = strand === 's2' ? 62 : 38;
    const bil = { id, strand, left: leftStart, born: performance.now() };
    ccmBillets.push(bil);
    const el = document.createElement('div');
    el.className = 'ccm-billet hot enter';
    el.id = 'ccmBil-' + id;
    el.style.left = leftStart + '%';
    el.title = strand === 's1' ? 'Strand 1' : 'Strand 2';
    host.appendChild(el);
    requestAnimationFrame(() => {
      el.style.left = '88%';
    });
    setTimeout(() => {
      el.classList.add('exit');
      setTimeout(() => {
        el.remove();
        ccmBillets = ccmBillets.filter(b => b.id !== id);
      }, 400);
    }, 900);
  }

  /** Tag TRUE / HIGH → green (same rule for Strand 1 and Strand 2) */
  function ccmHmdTagHigh(tagName, fallbackBit) {
    const d = window.latestPlcData || {};
    const v = d[tagName];
    if (v === true || v === 1 || v === '1' || v === 'true' || v === 'TRUE' || v === 'ON' || v === 'on') return true;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return true;
    if (typeof v === 'string' && v.trim() !== '' && v !== '0' && v.toLowerCase() !== 'false') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return true;
    }
    return !!fallbackBit;
  }

  function ccmStrandSensing(strand) {
    const now = performance.now();
    const tag = strand === 's1' ? CCM_HMD_TAGS.s1 : CCM_HMD_TAGS.s2;
    const bit = strand === 's1' ? plcCcmBits.s1 : plcCcmBits.s2;
    const live = ccmHmdTagHigh(tag, bit);
    const held = now < (ccmSenseHoldUntil[strand] || 0);
    return live || held;
  }

  function pulseCcmSense(strand, ms = 1200) {
    const until = performance.now() + ms;
    if (until > (ccmSenseHoldUntil[strand] || 0)) ccmSenseHoldUntil[strand] = until;
  }

  function applyCcmStrandGreen(node, on, tagName) {
    if (!node) return;
    const box = node.querySelector('.cn-box');
    node.classList.toggle('sensing', !!on);
    if (box) {
      box.classList.toggle('sensing', !!on);
      box.title = `${tagName} = ${on ? 'TRUE (GREEN)' : 'FALSE'}`;
    }
  }

  window.renderCcmPassAnimation = function renderCcmPassAnimation() {
    const s1El = document.getElementById('ccmAnimS1');
    const s2El = document.getElementById('ccmAnimS2');
    const n1 = document.getElementById('ccmNodeS1');
    const n2 = document.getElementById('ccmNodeS2');
    const meta = document.getElementById('ccmPassMeta');
    const { s1, s2 } = liveCcmStrands();
    if (s1El) s1El.textContent = String(s1);
    if (s2El) s2El.textContent = String(s2);
    /* Keep plc bits in sync with latest live payload */
    const d = window.latestPlcData || {};
    if (Object.prototype.hasOwnProperty.call(d, CCM_HMD_TAGS.s1) || Object.prototype.hasOwnProperty.call(d, CCM_HMD_TAGS.s2)) {
      plcCcmBits = {
        s1: ccmHmdTagHigh(CCM_HMD_TAGS.s1, false),
        s2: ccmHmdTagHigh(CCM_HMD_TAGS.s2, false),
      };
    }
    const sense1 = ccmStrandSensing('s1');
    const sense2 = ccmStrandSensing('s2');
    applyCcmStrandGreen(n1, sense1, CCM_HMD_TAGS.s1);
    applyCcmStrandGreen(n2, sense2, CCM_HMD_TAGS.s2);
    window.__ccmBitsDbg = { s1: sense1, s2: sense2, raw1: d[CCM_HMD_TAGS.s1], raw2: d[CCM_HMD_TAGS.s2] };
    if (meta) {
      const sense = [];
      if (sense1) sense.push('S1');
      if (sense2) sense.push('S2');
      meta.innerHTML = sense.length
        ? `<span class="on">HMD ON · ${sense.join(' + ')} · GREEN</span> · ${s1 + s2} pcs`
        : `Waiting for HMD… · S1/S2 tags FALSE · ${s1 + s2} pcs`;
    }
  };

  window.renderCcmTimingPanel = function renderCcmTimingPanel() {
    const cards = document.getElementById('ccmTimingCards');
    const status = document.getElementById('ccmAlgoStatus');
    const bar = document.getElementById('ccmCastBar');
    const fill = document.getElementById('ccmCastBarFill');
    if (!cards) return;
    const cfg = ccmTimingConfig();
    const now = Date.now();
    let castElapsedSec = 0;
    let castPct = 0;
    let modeLabel = 'IDLE';
    if (ccmActive && ccmHeat?.startedAt) {
      castElapsedSec = Math.max(0, (now - new Date(ccmHeat.startedAt).getTime()) / 1000);
      castPct = Math.min(100, (castElapsedSec * 1000 / cfg.castMs) * 100);
      modeLabel = 'CASTING';
    }
    const cycle = ccmCycleReady(now);
    const nextWaitSec = cycle.ready ? 0 : cycle.waitMs / 1000;
    const autoOn = !!document.getElementById('ccmAutoHeat')?.checked;
    cards.innerHTML = `
      <div class="rs"><div class="l">Mode</div><div class="v" style="font-size:16px;">${modeLabel}</div><div class="s">${ccmHeat?.heatNo || 'no heat'} · ${autoOn ? 'AUTO ON' : 'AUTO OFF'}</div></div>
      <div class="rs"><div class="l">Cast elapsed</div><div class="v">${fmtTime(castElapsedSec)}</div><div class="s">Target ${cfg.castMin} min → auto stop</div></div>
      <div class="rs"><div class="l">Next heat in</div><div class="v">${cycle.ready && !ccmActive ? 'READY' : fmtTime(nextWaitSec)}</div><div class="s">Cycle ${cfg.cycleHr} h from last start</div></div>
      <div class="rs"><div class="l">HMD now</div><div class="v" style="font-size:16px;">${plcCcmBits.s1 || plcCcmBits.s2 ? 'SENSE' : '—'}</div><div class="s">S1 ${plcCcmBits.s1 ? 'ON' : 'off'} · S2 ${plcCcmBits.s2 ? 'ON' : 'off'}</div></div>`;
    if (bar && fill) {
      bar.classList.toggle('gap', !ccmActive);
      fill.style.width = (ccmActive ? castPct : (cycle.ready ? 100 : Math.min(100, ((cfg.cycleMs - (cycle.waitMs || 0)) / cfg.cycleMs) * 100))) + '%';
    }
    if (status) {
      if (!autoOn) status.textContent = 'Auto heat OFF — use Start / End buttons manually.';
      else if (ccmActive) status.textContent = `Casting ${ccmHeat?.heatNo || ''} · auto End & save at ${cfg.castMin} min (${fmtTime(Math.max(0, cfg.castMs / 1000 - castElapsedSec))} left).`;
      else if (!cycle.ready) status.textContent = `Waiting cycle gap · next auto-start in ${fmtTime(nextWaitSec)} (2.3 h rule from last heat start).`;
      else status.textContent = 'Auto heat READY · waiting for Strand 1 or Strand 2 HMD sense (or count +1)…';
    }
  };

  function startCcmHeat({ auto = false, heatNo = null } = {}) {
    let no = (heatNo || document.getElementById('ccmHeatNo')?.value || '').trim();
    if (!no) {
      if (auto) {
        no = nextCcmAutoHeatNo();
        const el = document.getElementById('ccmHeatNo');
        if (el) el.value = no;
      } else {
        alert('Enter CCM Heat Number');
        return false;
      }
    }
    if (ccmActive) return false;
    const startedAt = new Date();
    ccmBaseline = { ...plcAbsCcm };
    const rel = ccmHeatRel(plcAbsCcm, ccmBaseline);
    document.getElementById('ccmS1').value = rel.s1;
    document.getElementById('ccmS2').value = rel.s2;
    const cfg = ccmTimingConfig();
    ccmHeat = {
      heatNo: no,
      startedAt: startedAt.toISOString(),
      s1: rel.s1, s2: rel.s2, totalPcs: rel.s1 + rel.s2,
      unitTon: unitTonFromInputs('ccmBilletW', 'ccmBilletH', 'ccmBilletL', 'ccmDensity'), tons: 0,
      baseline: { ...ccmBaseline },
      source: plcHmdLive ? 'DB8' : 'manual',
      auto: !!auto,
      castTargetMin: cfg.castMin,
      cycleTargetHr: cfg.cycleHr,
      billet: {
        w: n(document.getElementById('ccmBilletW').value),
        h: n(document.getElementById('ccmBilletH').value),
        L: n(document.getElementById('ccmBilletL').value),
        density: n(document.getElementById('ccmDensity').value),
      },
    };
    ccmActive = true;
    rememberCcmStart(startedAt.getTime());
    /* Same heat number for Rolling Mill + Steel EMS Pro */
    try {
      localStorage.setItem('steel_ems_shared_heat', JSON.stringify({
        heatNo: no,
        startedAt: startedAt.toISOString(),
        active: true,
        source: auto ? 'ccm-auto' : 'ccm-manual',
      }));
    } catch (e) { /* ignore */ }
    const rmHeatEl = document.getElementById('rmHeatNo');
    if (rmHeatEl && !rmActive) rmHeatEl.value = no;
    document.getElementById('ccmStartBtn').disabled = true;
    document.getElementById('ccmEndBtn').disabled = false;
    const pill = document.getElementById('ccmHeatPill');
    pill.className = 'prod-status run';
    pill.textContent = auto ? 'AUTO CAST' : 'HEAT ACTIVE';
    refreshCcmFormula();
    window.renderCcmPassAnimation();
    window.renderCcmTimingPanel();
    return true;
  }

  let ccmEnding = false;
  async function endCcmHeat({ auto = false, silent = false } = {}) {
    if (!ccmActive || !ccmHeat || ccmEnding) return false;
    ccmEnding = true;
    refreshCcmFormula();
    const endedAt = new Date();
    ccmHeat.endedAt = endedAt.toISOString();
    if (ccmHeat.startedAt) {
      ccmHeat.castMin = (endedAt.getTime() - new Date(ccmHeat.startedAt).getTime()) / 60000;
    }
    ccmHeat.endReason = auto ? 'auto_75min' : 'manual';
    ccmActive = false; /* clear before await so timer cannot double-end */
    const diskOk = await persistHeat('ccm_heats', ccmHeat);
    const saved = { ...ccmHeat };
    try {
      localStorage.setItem('steel_ems_shared_heat', JSON.stringify({
        heatNo: saved.heatNo,
        startedAt: saved.startedAt,
        active: false,
        source: auto ? 'ccm-auto-end' : 'ccm-manual-end',
      }));
    } catch (e) { /* ignore */ }
    const rmHeatEl = document.getElementById('rmHeatNo');
    if (rmHeatEl && !rmActive && saved.heatNo) rmHeatEl.value = saved.heatNo;
    document.getElementById('ccmStartBtn').disabled = false;
    document.getElementById('ccmEndBtn').disabled = true;
    const pill = document.getElementById('ccmHeatPill');
    pill.className = 'prod-status stop';
    pill.textContent = auto ? 'AUTO SAVED' : 'SAVED';
    renderCcmTable();
    window.renderCcmTimingPanel();
    ccmHeat = null;
    ccmEnding = false;
    if (!silent) {
      alert(
        `CCM heat ${saved.heatNo} saved · ${saved.totalPcs} pcs · ${Number(saved.tons).toFixed(3)} t\n` +
        `Cast ${Number(saved.castMin || 0).toFixed(1)} min` +
        (auto ? ' (auto stop ~75 min)' : '') +
        (diskOk ? '\n(also written to disk)' : '\n(browser only — start bridge_server for disk)')
      );
    }
    if (typeof updatePlantOverviewMis === 'function') updatePlantOverviewMis();
    return true;
  }

  /**
   * CCM heat algorithm tick (call on PLC update + timer):
   * 1) Rising HMD / count edge → START (if cycle ready)
   * 2) Cast age ≥ 75 min → STOP & save
   */
  function maybeAutoCcmHeat() {
    const s1Bit = !!plcCcmBits.s1;
    const s2Bit = !!plcCcmBits.s2;
    if (!ccmEdgePrimed) {
      prevCcmBits = { s1: s1Bit, s2: s2Bit };
      prevCcmAbsForEdge = { s1: plcAbsCcm.s1 || 0, s2: plcAbsCcm.s2 || 0 };
      ccmEdgePrimed = true;
      window.renderCcmPassAnimation();
      window.renderCcmTimingPanel();
      return;
    }
    const autoOn = !!document.getElementById('ccmAutoHeat')?.checked;
    const riseS1 = s1Bit && !prevCcmBits.s1;
    const riseS2 = s2Bit && !prevCcmBits.s2;
    const countUpS1 = (plcAbsCcm.s1 || 0) > (prevCcmAbsForEdge.s1 || 0);
    const countUpS2 = (plcAbsCcm.s2 || 0) > (prevCcmAbsForEdge.s2 || 0);
    const senseEdge = riseS1 || riseS2 || countUpS1 || countUpS2;

    if (senseEdge) {
      if (riseS1 || countUpS1) { pulseCcmSense('s1'); spawnCcmBillet('s1'); }
      if (riseS2 || countUpS2) { pulseCcmSense('s2'); spawnCcmBillet('s2'); }
    }
    /* While PLC HMD bit is true, keep green hold refreshed for both stands */
    if (s1Bit) pulseCcmSense('s1', 400);
    if (s2Bit) pulseCcmSense('s2', 400);

    if (autoOn && senseEdge && !ccmActive) {
      const cycle = ccmCycleReady();
      if (cycle.ready) startCcmHeat({ auto: true });
    }

    if (ccmActive && ccmHeat?.startedAt) {
      const { castMs } = ccmTimingConfig();
      const age = Date.now() - new Date(ccmHeat.startedAt).getTime();
      if (age >= castMs) {
        endCcmHeat({ auto: true, silent: false });
      }
    }

    prevCcmBits = { s1: s1Bit, s2: s2Bit };
    prevCcmAbsForEdge = { s1: plcAbsCcm.s1 || 0, s2: plcAbsCcm.s2 || 0 };
    window.renderCcmPassAnimation();
    window.renderCcmTimingPanel();
  }

  function summarizeCcm(rows) {
    const heats = rows.length;
    const pcs = rows.reduce((s, r) => s + (r.totalPcs || 0), 0);
    const tons = rows.reduce((s, r) => s + (r.tons || 0), 0);
    document.getElementById('ccmDayCards').innerHTML = `
      <div class="rs"><div class="l">Heats</div><div class="v">${heats}</div><div class="s">In selected period</div></div>
      <div class="rs"><div class="l">Billets</div><div class="v">${pcs}</div><div class="s">S1+S2 HMD total</div></div>
      <div class="rs"><div class="l">Production</div><div class="v">${tons.toFixed(3)}</div><div class="s">tonnes</div></div>
      <div class="rs"><div class="l">Avg / heat</div><div class="v">${heats ? (tons / heats).toFixed(3) : '0'}</div><div class="s">t / heat</div></div>`;
  }

  function filterByRange(rows, startIso, endIso) {
    const a = new Date(startIso).getTime(), b = new Date(endIso).getTime();
    return rows.filter(r => {
      const t = new Date(r.endedAt || r.startedAt || r.savedAt || 0).getTime();
      return t >= a && t <= b;
    });
  }

  /** Snapshot of open RM heat for reports — does not use reset live line after End */
  function openRmHeatReportRow() {
    if (!rmActive || !rmHeat) return null;
    const loss = hmdLoss();
    const unit = rmUnitTon();
    const goodTon = loss.tmt * unit;
    const runWindow = (rmHeat.onLoadSec || 0) + (rmHeat.idleSec || 0);
    return {
      heatNo: rmHeat.heatNo,
      startedAt: rmHeat.startedAt,
      endedAt: null,
      open: true,
      r3: loss.r3,
      r1: loss.r3,
      tmt: loss.tmt,
      missPcs: loss.miss,
      missTon: loss.miss * unit,
      goodTon,
      onLoadSec: rmHeat.onLoadSec || 0,
      idleSec: rmHeat.idleSec || 0,
      idleKwh: rmHeat.idleKwh || 0,
      totalKwh: rmHeat.totalKwh || 0,
      utilPct: runWindow > 0 ? (rmHeat.onLoadSec / runWindow) * 100 : 0,
      kwhPerTon: goodTon > 0 ? (rmHeat.totalKwh || 0) / goodTon : 0,
      auto: !!rmHeat.auto,
      source: 'OPEN',
    };
  }

  document.querySelectorAll('[data-ccm-inc]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-ccm-inc');
      const el = document.getElementById(id);
      el.value = (parseInt(el.value, 10) || 0) + 1;
      const strand = id === 'ccmS1' ? 's1' : 's2';
      plcAbsCcm[strand] = (plcAbsCcm[strand] || 0) + 1;
      pulseCcmSense(strand, 1200);
      refreshCcmFormula();
      maybeAutoCcmHeat();
    });
  });
  ['ccmS1', 'ccmS2', 'ccmBilletW', 'ccmBilletH', 'ccmBilletL', 'ccmDensity'].forEach(id => {
    document.getElementById(id).addEventListener('input', refreshCcmFormula);
  });

  document.getElementById('ccmStartBtn').addEventListener('click', () => {
    startCcmHeat({ auto: false });
  });

  document.getElementById('ccmEndBtn').addEventListener('click', () => {
    endCcmHeat({ auto: false });
  });

  ['ccmCastMin', 'ccmCycleHr', 'ccmAutoHeat'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => window.renderCcmTimingPanel());
    document.getElementById(id)?.addEventListener('input', () => window.renderCcmTimingPanel());
  });

  document.getElementById('ccmDayBtn').addEventListener('click', () => {
    const d = document.getElementById('ccmDayDate').value;
    if (!d) return;
    const b = dayBounds(d);
    summarizeCcm(filterByRange(ccmStore, b.start, b.end));
  });
  document.getElementById('ccmMonthBtn').addEventListener('click', () => {
    const m = document.getElementById('ccmMonth').value;
    if (!m) return;
    const b = monthBounds(m);
    summarizeCcm(filterByRange(ccmStore, b.start, b.end));
  });
  document.getElementById('ccmExportBtn').addEventListener('click', () => {
    if (!ccmStore.length) { alert('No CCM heats'); return; }
    const hdr = ['heatNo', 'endedAt', 's1', 's2', 'totalPcs', 'tons'];
    const lines = [hdr.join(',')].concat(ccmStore.map(r => hdr.map(k => r[k]).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'ccm_heats.csv'; a.click();
  });
  document.getElementById('ccmReloadBtn').addEventListener('click', async () => {
    await refreshStores(); renderCcmTable(); alert('CCM heats reloaded');
  });

  /* ——— Rolling Mill HMD MIS ——— */
  function hmdLoss() {
    const r3 = refCount(hmdCounts);
    const tmt = hmdCounts.tmt || 0;
    const miss = Math.max(0, r3 - tmt);
    const stageLoss = [];
    for (let i = 0; i < HMD_STAGES.length - 1; i++) {
      const a = HMD_STAGES[i], b = HMD_STAGES[i + 1];
      const d = (hmdCounts[a.id] || 0) - (hmdCounts[b.id] || 0);
      if (d > 0) stageLoss.push(`${a.label}→${b.label}: −${d}`);
    }
    return { r3, r1: r3, tmt, miss, ok: miss === 0, stageLoss };
  }

  /* Pass-line animation state — billets move stand-to-stand on HMD sense */
  let prevHmdBits = Object.fromEntries(HMD_STAGES.map(s => [s.id, false]));
  let prevHmdCounts = emptyStageMap();
  let millBuilt = false;
  let millBillets = []; /* {id, stageIdx, leftPct, hotUntil, exiting} */
  let millBilSeq = 0;
  let millAnimRaf = 0;

  function stageLeftPct(idx) {
    const n = HMD_STAGES.length;
    if (n <= 1) return 50;
    return ((idx + 0.5) / n) * 100;
  }

  function ensureMillPassline() {
    const stands = document.getElementById('millStands');
    const rollers = document.getElementById('millRollers');
    if (!stands || !rollers) return;
    if (!millBuilt) {
      rollers.innerHTML = Array.from({ length: 28 }, () => '<i></i>').join('');
      stands.innerHTML = HMD_STAGES.map((s, i) => `
        <div class="mill-stand" data-stage="${s.id}" id="millStand_${s.id}">
          <div class="ms-lbl">${s.label}</div>
          <div class="ms-house"><div class="ms-gap"></div><div class="ms-eye" title="${s.hmdTag}"></div></div>
          <div class="ms-count" id="millCnt_${s.id}">0</div>
        </div>`).join('');
      millBuilt = true;
    }
  }

  function spawnMillBillet(stageIdx, enterAnim) {
    const id = ++millBilSeq;
    const billet = {
      id,
      stageIdx,
      leftPct: stageLeftPct(stageIdx),
      hotUntil: performance.now() + 900,
      exiting: false,
    };
    millBillets.push(billet);
    /* Keep line readable — drop oldest finished billets */
    if (millBillets.length > 10) millBillets = millBillets.slice(-10);
    paintMillBillets(enterAnim ? id : null);
    return billet;
  }

  function moveMillBilletTo(stageIdx) {
    /* Prefer billet already at previous stand; else spawn at this stand */
    let billet = null;
    for (let i = millBillets.length - 1; i >= 0; i--) {
      const b = millBillets[i];
      if (!b.exiting && b.stageIdx === stageIdx - 1) { billet = b; break; }
    }
    if (!billet) {
      for (let i = millBillets.length - 1; i >= 0; i--) {
        const b = millBillets[i];
        if (!b.exiting && b.stageIdx < stageIdx) { billet = b; break; }
      }
    }
    if (!billet) {
      spawnMillBillet(stageIdx, true);
      return;
    }
    billet.stageIdx = stageIdx;
    billet.leftPct = stageLeftPct(stageIdx);
    billet.hotUntil = performance.now() + 900;
    billet.exiting = false;
    paintMillBillets(null);
  }

  function paintMillBillets(enterId) {
    const root = document.getElementById('millBillets');
    if (!root) return;
    const now = performance.now();
    root.innerHTML = millBillets.map(b => {
      const hot = now < b.hotUntil ? ' hot' : '';
      const enter = enterId === b.id ? ' enter' : '';
      const exit = b.exiting ? ' exit' : '';
      return `<div class="mill-billet${hot}${enter}${exit}" data-id="${b.id}" style="left:${b.leftPct}%;"></div>`;
    }).join('');
  }

  function tickMillAnim() {
    const now = performance.now();
    let dirty = false;
    millBillets = millBillets.filter(b => {
      if (b.exiting && now > b.hotUntil) { dirty = true; return false; }
      return true;
    });
    /* Refresh hot class without full rebuild when possible */
    const root = document.getElementById('millBillets');
    if (root) {
      root.querySelectorAll('.mill-billet').forEach(el => {
        const id = Number(el.dataset.id);
        const b = millBillets.find(x => x.id === id);
        if (!b) return;
        el.classList.toggle('hot', now < b.hotUntil);
        el.classList.toggle('exit', !!b.exiting);
        el.style.left = b.leftPct + '%';
      });
    }
    if (dirty) paintMillBillets(null);
    const anyHot = millBillets.some(b => !b.exiting && now < b.hotUntil + 400)
      || HMD_STAGES.some(s => plcHmdBits[s.id]);
    document.getElementById('millTrack')?.classList.toggle('running', anyHot);
    millAnimRaf = requestAnimationFrame(tickMillAnim);
  }

  function ensureMillAnimLoop() {
    if (!millAnimRaf) millAnimRaf = requestAnimationFrame(tickMillAnim);
  }

  function updateMillPassAnim() {
    ensureMillPassline();
    ensureMillAnimLoop();
    const sensing = [];
    HMD_STAGES.forEach((s, i) => {
      const on = !!plcHmdBits[s.id];
      const was = !!prevHmdBits[s.id];
      const el = document.getElementById('millStand_' + s.id);
      if (el) {
        el.classList.toggle('sensing', on);
        if (on && !was) {
          el.classList.remove('pass');
          void el.offsetWidth;
          el.classList.add('pass');
        }
      }
      const cnt = document.getElementById('millCnt_' + s.id);
      if (cnt) cnt.textContent = String(hmdCounts[s.id] || 0);

      const countUp = (hmdCounts[s.id] || 0) > (prevHmdCounts[s.id] || 0);
      const rising = on && !was;
      /* Rising HMD edge preferred; count edge covers PLC without bool pulse */
      if (rising || (countUp && !rising)) {
        if (i === 0) spawnMillBillet(0, true);
        else moveMillBilletTo(i);
      }
      if (!on && was && i === HMD_STAGES.length - 1) {
        /* TMT clear — billet exits line */
        const last = [...millBillets].reverse().find(b => !b.exiting && b.stageIdx === i);
        if (last) {
          last.exiting = true;
          last.leftPct = Math.min(98, last.leftPct + 8);
          last.hotUntil = performance.now() + 450;
          paintMillBillets(null);
        }
      }
      if (on) sensing.push(s.label);
      prevHmdBits[s.id] = on;
      prevHmdCounts[s.id] = hmdCounts[s.id] || 0;
    });

    const meta = document.getElementById('millPassMeta');
    if (meta) {
      meta.innerHTML = sensing.length
        ? `<span class="on">HMD ON</span> · ${sensing.join(' · ')}`
        : (millBillets.some(b => !b.exiting) ? 'Billet in transit…' : 'Waiting for HMD…');
    }
  }

  /** Pulse a stand HMD bit briefly (demo / count-edge without PLC bool) */
  function pulseHmdBit(stageId, ms) {
    plcHmdBits[stageId] = true;
    updateMillPassAnim();
    renderHmdLineCountsOnly();
    setTimeout(() => {
      plcHmdBits[stageId] = false;
      updateMillPassAnim();
      renderHmdLineCountsOnly();
    }, ms || 700);
  }

  function renderHmdLineCountsOnly() {
    const loss = hmdLoss();
    const line = document.getElementById('hmdLine');
    if (!line) return;
    line.innerHTML = HMD_STAGES.map((s, i) => {
      const prev = i ? HMD_STAGES[i - 1] : null;
      const delta = prev ? (hmdCounts[prev.id] || 0) - (hmdCounts[s.id] || 0) : 0;
      const present = !!plcHmdBits[s.id];
      let cls = i === 0 ? '' : (delta > 0 ? 'loss' : 'ok');
      if (present) cls += ' live';
      const arrow = i ? `<div class="hmd-arrow">→</div>` : '';
      const absNote = plcHmdLive ? ` · Σ${plcAbsCounts[s.id] || 0}` : '';
      return `${arrow}<div class="hmd-node ${cls}">
        <div class="hmd-name">${s.label}${present ? ' ●' : ''}</div>
        <div class="hmd-count">${hmdCounts[s.id] || 0}</div>
        <div class="hmd-delta">${i ? (delta > 0 ? 'loss ' + delta : 'OK') : 'from CCM'}${absNote}</div>
      </div>`;
    }).join('');
    const formula = document.getElementById('hmdLossFormula');
    if (formula) {
      formula.textContent = loss.ok
        ? `No miss-roll: TMT (${loss.tmt}) = R3 (${loss.r3}). Stage path OK.${plcHmdLive ? ' · live DB8' : ''}`
        : `Miss-roll: R3 ${loss.r3} − TMT ${loss.tmt} = ${loss.miss} pcs. ${loss.stageLoss.join(' · ') || ''}`;
    }
  }

  window.renderHmdLine = function renderHmdLine() {
    renderHmdLineCountsOnly();
    updateMillPassAnim();
  };

  function getKwThresholds() {
    let startThr = n(document.getElementById('rmStartKw')?.value, 500);
    let onThr = n(document.getElementById('rmOnLoadKw')?.value, 1600);
    if (startThr < 0) startThr = 0;
    if (onThr <= startThr) onThr = startThr + 1;
    return { startThr, onThr };
  }

  /** Rising-edge guard: auto-start only when kW crosses above Mill start thr */
  let prevKwBelowStart = true;
  /** Auto mill band from HT kW — no START buttons */
  function millBandFromKw(kw) {
    const { startThr, onThr } = getKwThresholds();
    const w = Number(kw) || 0;
    if (w > onThr) return { mode: 'onload', label: 'ON LOAD', startThr, onThr };
    if (w > startThr) return { mode: 'idle', label: 'IDLE RUN', startThr, onThr };
    return { mode: 'stop', label: 'STOPPED', startThr, onThr };
  }
  function persistKwThresholds() {
    try {
      const { startThr, onThr } = getKwThresholds();
      localStorage.setItem('rm_kw_thr', JSON.stringify({ startThr, onThr }));
    } catch (e) { /* ignore */ }
    syncThresholdsToMes();
  }

  /** Keep MES server band thresholds aligned with HMD Production UI */
  function syncThresholdsToMes() {
    const { startThr, onThr } = getKwThresholds();
    try {
      fetch('/api/mes/thresholds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_kw: startThr, onload_kw: onThr }),
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  /** Live CCM strand counts — same source for CCM page + Smart EMS + HMD strip */
  function liveCcmStrands() {
    const s1 = ccmActive
      ? Math.max(0, (plcAbsCcm.s1 || 0) - (ccmBaseline?.s1 || 0))
      : (document.getElementById('ccmS1')
        ? Math.max(0, parseInt(document.getElementById('ccmS1').value, 10) || 0)
        : (plcAbsCcm.s1 || 0));
    const s2 = ccmActive
      ? Math.max(0, (plcAbsCcm.s2 || 0) - (ccmBaseline?.s2 || 0))
      : (document.getElementById('ccmS2')
        ? Math.max(0, parseInt(document.getElementById('ccmS2').value, 10) || 0)
        : (plcAbsCcm.s2 || 0));
    return { s1, s2 };
  }

  /**
   * ONE tag set for Smart EMS · CCM Production · HMD Production.
   * All screens must read these values — never diverge.
   */
  window.getSharedPlantTags = function getSharedPlantTags() {
    const timing = window.getRmTimingSnapshot();
    const loss = hmdLoss();
    const unitRm = rmUnitTon();
    const unitCcm = unitTonFromInputs('ccmBilletW', 'ccmBilletH', 'ccmBilletL', 'ccmDensity');
    const { s1, s2 } = liveCcmStrands();
    const ccmPcs = s1 + s2;
    const ccmTons = ccmPcs * unitCcm;
    const band = millBandFromKw(lastLiveKw);
    const goodTons = loss.tmt * unitRm;
    const kwhPerTon = goodTons > 0 ? (timing.total_kwh || 0) / goodTons : 0;
    return {
      ht_kw: Number(lastLiveKw) || 0,
      kwh_meter: lastLiveKwh,
      mill_mode: timing.mode,
      mill_label: band.label,
      start_kw: timing.start_kw,
      onload_kw: timing.onload_kw,
      on_load_sec: timing.on_load_sec,
      idle_sec: timing.idle_sec,
      stop_sec: timing.stop_sec,
      util_pct: timing.util_pct,
      availability_pct: timing.availability_pct,
      on_load_kwh: timing.on_load_kwh,
      idle_kwh: timing.idle_kwh,
      total_kwh: timing.total_kwh,
      ccm_s1: s1,
      ccm_s2: s2,
      ccm_billets: ccmPcs,
      ccm_tons: ccmTons,
      ccm_unit_ton: unitCcm,
      entry: hmdCounts.entry || 0,
      r3: loss.r3,
      tmt: loss.tmt,
      miss: loss.miss,
      miss_pct: loss.r3 > 0 ? (loss.miss / loss.r3) * 100 : 0,
      yield_pct: loss.r3 > 0 ? (loss.tmt / loss.r3) * 100 : 0,
      good_tons: goodTons,
      kwh_per_ton: kwhPerTon,
      unit_ton: unitRm,
      heat_rm: rmActive ? (rmHeat?.heatNo || null) : null,
      heat_ccm: ccmActive ? (ccmHeat?.heatNo || null) : null,
      plc_live: !!plcHmdLive,
    };
  };

  function sharedLiveStripHTML() {
    const t = window.getSharedPlantTags();
    return `
      <div class="oem-band" style="margin-top:0;">Live tags · same on Smart EMS / CCM / HMD</div>
      <div class="report-sum" style="margin:0 0 12px;grid-template-columns:repeat(6,1fr);border-radius:0 0 var(--r) var(--r);">
        <div class="rs"><div class="l">HT load</div><div class="v">${fmt(t.ht_kw, 1)}</div><div class="s">kW · ${t.mill_label}</div></div>
        <div class="rs"><div class="l">On-load time</div><div class="v">${fmtTime(t.on_load_sec)}</div><div class="s">&gt; ${t.onload_kw} kW</div></div>
        <div class="rs"><div class="l">Idle run</div><div class="v">${fmtTime(t.idle_sec)}</div><div class="s">${t.start_kw}–${t.onload_kw} kW</div></div>
        <div class="rs"><div class="l">Util / R3→TMT</div><div class="v">${fmt(t.util_pct, 1)}%</div><div class="s">${t.r3} / ${t.tmt} · miss ${t.miss}</div></div>
        <div class="rs"><div class="l">CCM S1 / S2</div><div class="v" style="font-size:18px;">${t.ccm_s1} / ${t.ccm_s2}</div><div class="s">${t.ccm_billets} pcs · ${fmt(t.ccm_tons, 3)} t</div></div>
        <div class="rs"><div class="l">Good tons</div><div class="v">${fmt(t.good_tons, 3)}</div><div class="s">TMT ${t.tmt} × ${fmt(t.unit_ton, 4)} t</div></div>
      </div>`;
  }

  window.renderSharedLiveStrips = function renderSharedLiveStrips() {
    ['sharedLiveStripMes', 'sharedLiveStripCcm', 'sharedLiveStripRm'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const view = id === 'sharedLiveStripMes' ? 'mes'
        : id === 'sharedLiveStripCcm' ? 'ccm' : 'rmmis';
      const active = document.getElementById('view-' + view)?.classList.contains('active');
      if (active) el.innerHTML = sharedLiveStripHTML();
    });
  };

  /**
   * Single timing snapshot used by HMD Production + Smart EMS.
   * Heat-open → rmHeat timers; else → rmSession (same numbers as RM MIS cards).
   */
  window.getRmTimingSnapshot = function getRmTimingSnapshot() {
    const src = (rmActive && rmHeat) ? rmHeat : rmSession;
    const { startThr, onThr } = getKwThresholds();
    const band = millBandFromKw(lastLiveKw);
    const onSec = src.onLoadSec || 0;
    const idleSec = src.idleSec || 0;
    const stopSec = src.stopSec || 0;
    const run = onSec + idleSec;
    return {
      mode: band.mode,
      kw: Number(lastLiveKw) || 0,
      start_kw: startThr,
      onload_kw: onThr,
      on_load_sec: onSec,
      idle_sec: idleSec,
      stop_sec: stopSec,
      run_sec: run,
      util_pct: run > 0 ? (onSec / run) * 100 : 0,
      on_load_kwh: src.onLoadKwh || 0,
      idle_kwh: src.idleKwh || 0,
      total_kwh: src.totalKwh || 0,
      availability_pct: (run + stopSec) > 0 ? (run / (run + stopSec) * 100) : 0,
      heat_open: !!rmActive,
      source: rmActive ? 'rm_heat' : 'rm_session',
    };
  };

  function summarizeCcmFloor(rows) {
    const heats = rows.length;
    const billets = rows.reduce((s, r) => s + (r.totalPcs || 0), 0);
    const tons = rows.reduce((s, r) => s + (r.tons || 0), 0);
    return {
      heats,
      billets,
      tons: Math.round(tons * 1000) / 1000,
      avg_per_heat: heats ? Math.round((tons / heats) * 1000) / 1000 : 0,
      billets_per_heat: heats ? Math.round((billets / heats) * 10) / 10 : 0,
    };
  }
  function summarizeRmFloor(rows) {
    const heats = rows.length;
    const good = rows.reduce((s, r) => s + (r.goodTon || 0), 0);
    const miss = rows.reduce((s, r) => s + (r.missPcs || 0), 0);
    const r3 = rows.reduce((s, r) => s + (r.r3 ?? r.r1 ?? 0), 0);
    const tmt = rows.reduce((s, r) => s + (r.tmt || 0), 0);
    const onSec = rows.reduce((s, r) => s + (r.onLoadSec || 0), 0);
    const idleSec = rows.reduce((s, r) => s + (r.idleSec || 0), 0);
    const kwh = rows.reduce((s, r) => s + (r.totalKwh || 0), 0);
    const run = onSec + idleSec;
    return {
      heats,
      received_r3: r3,
      finished: tmt,
      good_tons: Math.round(good * 1000) / 1000,
      miss_pcs: miss,
      miss_pct: r3 > 0 ? Math.round((miss / r3) * 10000) / 100 : 0,
      yield_pct: r3 > 0 ? Math.round((tmt / r3) * 10000) / 100 : 0,
      on_load_sec: onSec,
      idle_sec: idleSec,
      util_pct: run > 0 ? Math.round((onSec / run) * 10000) / 100 : 0,
      kwh: Math.round(kwh * 100) / 100,
      kwh_per_ton: good > 0 ? Math.round((kwh / good) * 100) / 100 : 0,
    };
  }

  /**
   * Full floor snapshot so Smart EMS tabs match CCM / RM EMS+MIS pages.
   */
  window.getFloorMesSnapshot = function getFloorMesSnapshot() {
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const ds = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const ms = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const ys = `${now.getFullYear()}`;
    const dayB = dayBounds(ds);
    const monthB = monthBounds(ms);
    const yearB = { start: `${ys}-01-01T00:00:00`, end: dayB.end };

    const ccmToday = filterByRange(ccmStore, dayB.start, dayB.end);
    const ccmMonth = filterByRange(ccmStore, monthB.start, monthB.end);
    const ccmYear = filterByRange(ccmStore, yearB.start, yearB.end);
    const rmToday = filterByRange(rmStore, dayB.start, dayB.end);
    const rmMonth = filterByRange(rmStore, monthB.start, monthB.end);
    const rmYear = filterByRange(rmStore, yearB.start, yearB.end);

    const timing = window.getRmTimingSnapshot();
    const loss = hmdLoss();
    const unit = rmUnitTon();
    const liveSrc = (rmActive && rmHeat) ? rmHeat : rmSession;
    const goodLive = loss.tmt * unit;
    const kwhLive = liveSrc.totalKwh || 0;
    const todayRm = summarizeRmFloor(rmToday);
    const secLive = goodLive > 0 ? kwhLive / goodLive : todayRm.kwh_per_ton;

    const { s1: ccmS1, s2: ccmS2 } = liveCcmStrands();
    const shared = window.getSharedPlantTags();

    const counts = {
      ccm_s1: ccmS1,
      ccm_s2: ccmS2,
      entry: hmdCounts.entry || 0,
      r3: hmdCounts.r3 || 0,
      ccs1: hmdCounts.ccs1 || 0,
      ccs2: hmdCounts.ccs2 || 0,
      dshear: hmdCounts.dd || 0,
      blk_in: hmdCounts.blkIn || 0,
      blk_out: hmdCounts.blkOut || 0,
      tmt: hmdCounts.tmt || 0,
    };
    const bits = {
      ccm_s1: !!plcCcmBits.s1,
      ccm_s2: !!plcCcmBits.s2,
      entry: !!plcHmdBits.entry,
      r3: !!plcHmdBits.r3,
      ccs1: !!plcHmdBits.ccs1,
      ccs2: !!plcHmdBits.ccs2,
      dshear: !!plcHmdBits.dd,
      blk_in: !!plcHmdBits.blkIn,
      blk_out: !!plcHmdBits.blkOut,
      tmt: !!plcHmdBits.tmt,
    };
    const idMap = { dd: 'dshear', blkIn: 'blk_in', blkOut: 'blk_out' };
    const losses = [];
    for (let i = 0; i < HMD_STAGES.length - 1; i++) {
      const a = HMD_STAGES[i], b = HMD_STAGES[i + 1];
      const gap = (hmdCounts[a.id] || 0) - (hmdCounts[b.id] || 0);
      if (gap > 0) {
        losses.push({
          from: idMap[a.id] || a.id,
          to: idMap[b.id] || b.id,
          from_label: a.label,
          to_label: b.label,
          lost: gap,
        });
      }
    }

    const ccmSum = summarizeCcmFloor(ccmToday);
    const hmd = {
      received: counts.entry,
      finished: counts.tmt,
      at_r3: counts.r3,
      miss_roll: loss.miss,
      miss_pct: loss.r3 > 0 ? Math.round((loss.miss / loss.r3) * 10000) / 100 : 0,
      yield_pct: loss.r3 > 0 ? Math.round((loss.tmt / loss.r3) * 10000) / 100 : 0,
      counts,
      bits,
      losses,
      ccm_s1: ccmS1,
      ccm_s2: ccmS2,
    };

    /* Live CCM pcs/tons (same as CCM Production) drive plant KPIs when heats not yet saved */
    const liveCcmPcs = shared.ccm_billets || 0;
    const liveCcmTons = Math.round((shared.ccm_tons || 0) * 1000) / 1000;
    const plantBasePcs = liveCcmPcs > 0 ? liveCcmPcs : ccmSum.billets;
    const plant = {
      ccm_billets: plantBasePcs,
      ccm_tons_live: liveCcmTons,
      rm_received: counts.entry || counts.r3,
      finished: counts.tmt,
      difference: Math.max(0, plantBasePcs - counts.tmt),
      production_loss: Math.max(0, plantBasePcs - counts.tmt),
      yield_pct: plantBasePcs > 0 ? Math.round((counts.tmt / plantBasePcs) * 10000) / 100 : 0,
      hot_charge_efficiency: plantBasePcs > 0
        ? Math.round(Math.min(100, ((counts.entry || counts.r3) / plantBasePcs) * 100) * 100) / 100
        : 0,
      plant_efficiency: plantBasePcs > 0
        ? Math.round((counts.tmt / plantBasePcs) * 10000) / 100
        : 0,
    };

    const ccmTodayLive = {
      ...ccmSum,
      /* Prefer live S1+S2 tons so Smart EMS matches CCM Production even with 0 saved heats */
      billets: liveCcmPcs > 0 ? liveCcmPcs : ccmSum.billets,
      tons: liveCcmTons > 0 ? liveCcmTons : ccmSum.tons,
      heats: ccmSum.heats,
      live_s1: shared.ccm_s1,
      live_s2: shared.ccm_s2,
      live_billets: liveCcmPcs,
      live_tons: liveCcmTons,
      saved_billets: ccmSum.billets,
      saved_tons: ccmSum.tons,
    };

    return {
      _floor: true,
      connected: true,
      unit_ton: unit,
      ccm_unit_ton: shared.ccm_unit_ton,
      session: timing,
      hmd,
      plant,
      shared_tags: shared,
      live_energy: {
        kw: shared.ht_kw,
        kwh: shared.kwh_meter,
        kwh_per_ton: shared.kwh_per_ton,
        productive_kwh: shared.on_load_kwh,
        idle_kwh: shared.idle_kwh,
      },
      ccm: {
        today: ccmTodayLive,
        month: summarizeCcmFloor(ccmMonth),
        year: summarizeCcmFloor(ccmYear),
        rows: ccmStore.slice(0, 100),
        live_s1: shared.ccm_s1,
        live_s2: shared.ccm_s2,
        live_billets: liveCcmPcs,
        live_tons: liveCcmTons,
        heat_open: !!ccmActive,
        heat_no: shared.heat_ccm,
      },
      rm: {
        today: {
          ...todayRm,
          /* Live util/SEC from open heat or session — same as HMD Production */
          util_pct: shared.util_pct,
          kwh_per_ton: shared.kwh_per_ton || secLive || todayRm.kwh_per_ton,
          good_tons: (shared.good_tons > 0 || !todayRm.good_tons)
            ? Math.round(shared.good_tons * 1000) / 1000
            : todayRm.good_tons,
          good_tons_live: Math.round(shared.good_tons * 1000) / 1000,
          received_r3: shared.r3,
          finished: shared.tmt,
          miss_pcs: shared.miss,
          miss_pct: shared.miss_pct,
          yield_pct: shared.yield_pct,
          on_load_sec: shared.on_load_sec,
          idle_sec: shared.idle_sec,
        },
        month: summarizeRmFloor(rmMonth),
        year: summarizeRmFloor(rmYear),
        rows: rmStore.slice(0, 100).map(h => ({
          heatNo: h.heatNo,
          endedAt: h.endedAt,
          r3: h.r3 ?? h.r1,
          tmt: h.tmt,
          missPcs: h.missPcs,
          goodTon: h.goodTon,
          onLoadSec: h.onLoadSec,
          idleSec: h.idleSec,
          utilPct: h.utilPct,
          totalKwh: h.totalKwh,
          kwhPerTon: h.kwhPerTon,
        })),
        live: hmd,
        heat_open: !!rmActive,
        heat_no: rmHeat?.heatNo || null,
      },
      charts: {
        heat_tons: ccmToday.slice(0, 12).reverse().map(r => ({ heat: r.heatNo, tons: r.tons || 0 })),
        miss_vs_yield: { miss_pct: hmd.miss_pct, yield_pct: hmd.yield_pct },
        run_idle: {
          on_load: timing.on_load_sec,
          idle: timing.idle_sec,
          stop: timing.stop_sec,
        },
      },
      thresholds: { start_kw: timing.start_kw, onload_kw: timing.onload_kw },
    };
  };
  function restoreKwThresholds() {
    try {
      const j = JSON.parse(localStorage.getItem('rm_kw_thr') || 'null');
      if (!j) return;
      if (document.getElementById('rmStartKw') && j.startThr != null) document.getElementById('rmStartKw').value = j.startThr;
      if (document.getElementById('rmOnLoadKw') && j.onThr != null) document.getElementById('rmOnLoadKw').value = j.onThr;
    } catch (e) { /* ignore */ }
  }

  function updateMillPill() {
    const band = millBandFromKw(lastLiveKw);
    millStartOn = band.mode !== 'stop';
    const pill = document.getElementById('rmMillPill');
    if (!pill) return;
    if (band.mode === 'stop') {
      pill.className = 'prod-status stop'; pill.textContent = 'STOPPED';
    } else if (band.mode === 'onload') {
      pill.className = 'prod-status run'; pill.textContent = 'ON LOAD';
    } else {
      pill.className = 'prod-status idle'; pill.textContent = 'IDLE RUN';
    }
    const hint = document.getElementById('rmBandHint');
    if (hint) {
      hint.textContent = `Now ${fmt(lastLiveKw, 1)} kW · stop ≤ ${band.startThr} · idle ${band.startThr}–${band.onThr} · on-load > ${band.onThr}` +
        (rmActive ? ' · heat open' : ' · auto-start when kW > ' + band.startThr);
    }
  }

  /** Advance on-load / idle / energy from HT kW bands */
  function tickRmTiming(dt) {
    if (!(dt > 0) || dt > 10) return;
    const band = millBandFromKw(lastLiveKw);
    millStartOn = band.mode !== 'stop';
    const dKwh = Math.max(0, lastLiveKw) * dt / 3600;

    const apply = (bag, integrateAlways) => {
      if (!bag) return;
      if (band.mode === 'stop') {
        bag.stopSec = (bag.stopSec || 0) + dt;
      } else if (band.mode === 'onload') {
        bag.onLoadSec = (bag.onLoadSec || 0) + dt;
        bag.onLoadKwh = (bag.onLoadKwh || 0) + dKwh;
      } else {
        bag.idleSec = (bag.idleSec || 0) + dt;
        bag.idleKwh = (bag.idleKwh || 0) + dKwh;
      }
      // Energy for SEC: while mill running (start band+) — and whole heat if open
      if (integrateAlways || band.mode !== 'stop') {
        bag.integKwh = (bag.integKwh || 0) + dKwh;
      }
      let meterKwh = bag.integKwh || 0;
      if (lastLiveKwh != null && bag.kwhMeterStart != null && Number.isFinite(lastLiveKwh)) {
        const delta = lastLiveKwh - bag.kwhMeterStart;
        if (delta >= 0) meterKwh = Math.max(meterKwh, delta);
      }
      bag.totalKwh = meterKwh > 0 ? meterKwh : ((bag.onLoadKwh || 0) + (bag.idleKwh || 0));
    };

    if (rmActive && rmHeat) apply(rmHeat, true);
    else apply(rmSession, false);
  }

  function ensureRmTick() {
    if (rmTickTimer) return;
    lastMisTs = performance.now();
    rmTickTimer = setInterval(() => {
      const now = performance.now();
      if (lastMisTs == null) lastMisTs = now;
      const dt = Math.min(2.5, (now - lastMisTs) / 1000);
      lastMisTs = now;
      tickRmTiming(dt);
      updateMillPill();
      maybeAutoStartRmHeat();
      maybeAutoCcmHeat();
      if (document.getElementById('view-rmmis')?.classList.contains('active')) renderRmPanels();
      if (document.getElementById('view-ccm')?.classList.contains('active') && typeof refreshCcmFormula === 'function') {
        refreshCcmFormula();
      }
      if (typeof window.renderSharedLiveStrips === 'function') window.renderSharedLiveStrips();
      if (typeof updatePlantOverviewMis === 'function') updatePlantOverviewMis();
      if (typeof repaintMesFromFloor === 'function') repaintMesFromFloor();
    }, 500);
  }

  window.renderRmPanels = function renderRmPanels() {
    const unit = rmUnitTon();
    const loss = hmdLoss();
    const goodT = loss.tmt * unit;
    const missT = loss.miss * unit;
    refreshRmBilletFormula();
    const src = (rmActive && rmHeat) ? rmHeat : rmSession;
    const onSec = src.onLoadSec || 0;
    const idleSec = src.idleSec || 0;
    const stopSec = src.stopSec || 0;
    const runWindow = onSec + idleSec;
    const util = runWindow > 0 ? (onSec / runWindow) * 100 : 0;
    const totalKwh = src.totalKwh || 0;
    const idleKwh = src.idleKwh || 0;
    const sec = goodT > 0 ? totalKwh / goodT : 0;
    const band = millBandFromKw(lastLiveKw);

    document.getElementById('rmMisKpis').innerHTML = [
      kpiHTML({ label: 'R3 count', value: String(loss.r3), unit: 'pcs', sub: 'R3_COUNTS ref', barPct: pct(loss.r3, 0, 80), lo: '0', hi: '80' }),
      kpiHTML({ label: 'TMT count', value: String(loss.tmt), unit: 'pcs', sub: 'TMT_COUNTS good', barPct: pct(loss.tmt, 0, 80), lo: '0', hi: '80' }),
      kpiHTML({ label: 'Miss-roll', value: String(loss.miss), unit: 'pcs', sub: `${missT.toFixed(3)} t · R3−TMT`, state: loss.miss ? 'alarm' : '', barPct: pct(loss.miss, 0, 20), lo: '0', hi: '20' }),
      kpiHTML({ label: 'Good tons', value: fmt(goodT, 3), unit: 't', sub: `Unit ${unit.toFixed(4)} t · L ${rmBilletDims().L} mm`, barPct: pct(goodT, 0, 50), lo: '0', hi: '50' }),
    ].join('');

    document.getElementById('rmMisLossCards').innerHTML = `
      <div class="rs"><div class="l">On-load time</div><div class="v">${fmtTime(onSec)}</div><div class="s">HT kW &gt; ${band.onThr}</div></div>
      <div class="rs"><div class="l">Idle running</div><div class="v">${fmtTime(idleSec)}</div><div class="s">${band.startThr} &lt; kW ≤ ${band.onThr}</div></div>
      <div class="rs"><div class="l">Utilization</div><div class="v">${fmt(util, 1)}%</div><div class="s">On-load ÷ (on-load+idle)</div></div>
      <div class="rs"><div class="l">Unit / ton</div><div class="v">${goodT > 0 ? fmt(sec, 2) : '—'}</div><div class="s">${fmt(totalKwh, 2)} kWh ÷ ${fmt(goodT, 3)} t · idle ${fmt(idleKwh, 2)} kWh</div></div>`;

    document.getElementById('rmStateCards').innerHTML = `
      <div class="rs"><div class="l">HT load now</div><div class="v">${fmt(lastLiveKw, 1)}</div><div class="s">kW · ${band.label}</div></div>
      <div class="rs"><div class="l">Mill start thr</div><div class="v">${band.startThr}</div><div class="s">kW · customize per bar</div></div>
      <div class="rs"><div class="l">On-load thr</div><div class="v">${band.onThr}</div><div class="s">kW · customize per bar</div></div>`;
    updateMillPill();
    if (typeof window.renderSharedLiveStrips === 'function') window.renderSharedLiveStrips();
  };

  window.renderRmTable = function renderRmTable() {
    const body = document.getElementById('rmHeatBody');
    if (!rmStore.length) {
      body.innerHTML = `<tr><td colspan="13" class="empty">No RM heats saved</td></tr>`;
      return;
    }
    body.innerHTML = rmStore.map(h => {
      const L = h.billetL ?? h.billet?.L ?? '—';
      const ut = h.unitTon != null ? Number(h.unitTon).toFixed(4) : '—';
      return `<tr>
      <td>${h.heatNo}</td><td>${(h.endedAt || '').replace('T', ' ').slice(0, 19)}</td>
      <td>${L}</td><td>${ut}</td>
      <td>${h.r3 ?? h.r1}</td><td>${h.tmt}</td><td>${h.missPcs}</td><td>${Number(h.goodTon).toFixed(3)}</td>
      <td>${fmtTime(h.onLoadSec)}</td><td>${fmtTime(h.idleSec)}</td>
      <td>${Number(h.utilPct).toFixed(1)}</td><td>${Number(h.kwhPerTon).toFixed(2)}</td><td>${Number(h.idleKwh || 0).toFixed(2)}</td>
    </tr>`;
    }).join('');
  };

  function summarizeRm(rows) {
    const heats = rows.length;
    const goodT = rows.reduce((s, r) => s + (r.goodTon || 0), 0);
    const miss = rows.reduce((s, r) => s + (r.missPcs || 0), 0);
    const kwh = rows.reduce((s, r) => s + (r.totalKwh || 0), 0);
    document.getElementById('rmDayCards').innerHTML = `
      <div class="rs"><div class="l">Heats</div><div class="v">${heats}</div><div class="s">Period</div></div>
      <div class="rs"><div class="l">Good tons</div><div class="v">${goodT.toFixed(3)}</div><div class="s">TMT basis</div></div>
      <div class="rs"><div class="l">Miss pcs</div><div class="v">${miss}</div><div class="s">R3−TMT sum</div></div>
      <div class="rs"><div class="l">Energy</div><div class="v">${kwh.toFixed(1)}</div><div class="s">kWh · SEC ${goodT > 0 ? (kwh / goodT).toFixed(2) : '—'} kWh/t</div></div>`;
  }

  document.getElementById('rmStartKw')?.addEventListener('input', () => { persistKwThresholds(); updateMillPill(); renderRmPanels(); });
  document.getElementById('rmOnLoadKw')?.addEventListener('input', () => { persistKwThresholds(); updateMillPill(); renderRmPanels(); });

  function nextAutoHeatNo() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    return `H-AUTO-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  /** Start RM heat (manual button or auto when kW > Mill start thr) */
  function startRmHeat({ auto = false } = {}) {
    if (rmActive) return false;
    let heatNo = (document.getElementById('rmHeatNo').value || '').trim();
    if (!heatNo) {
      /* Prefer CCM heat number (same plant heat) */
      try {
        const sh = JSON.parse(localStorage.getItem('steel_ems_shared_heat') || 'null');
        if (sh && sh.heatNo) heatNo = String(sh.heatNo);
      } catch (e) { /* ignore */ }
      if (!heatNo && ccmActive && ccmHeat?.heatNo) heatNo = String(ccmHeat.heatNo);
    }
    if (!heatNo) {
      if (auto) {
        heatNo = nextAutoHeatNo();
        document.getElementById('rmHeatNo').value = heatNo;
      } else {
        alert('Enter Heat Number');
        return false;
      }
    }
    document.getElementById('rmHeatNo').value = heatNo;
    syncRmLengthUI(false);
    const dims = rmBilletDims();
    const unit = billetUnitTon(dims.w, dims.h, dims.L, dims.density);
    rmBaseline = { ...plcAbsCounts };
    hmdCounts = heatRel(plcAbsCounts, rmBaseline);
    rmHeat = {
      heatNo,
      startedAt: new Date().toISOString(),
      unitTon: unit,
      billet: { w: dims.w, h: dims.h, L: dims.L, density: dims.density },
      billetL: dims.L,
      productSize: `${dims.w}×${dims.h}×${dims.L}`,
      hmd: { ...hmdCounts },
      baseline: { ...rmBaseline },
      source: auto ? (plcHmdLive ? 'DB8+auto-kW' : 'auto-kW') : (plcHmdLive ? 'DB8' : 'manual'),
      autoStarted: !!auto,
      onLoadSec: 0, idleSec: 0, stopSec: 0,
      onLoadKwh: 0, idleKwh: 0, totalKwh: 0, integKwh: 0,
      kwhMeterStart: lastLiveKwh,
    };
    rmActive = true;
    lastMisTs = performance.now();
    ensureRmTick();
    document.getElementById('rmStartBtn').disabled = true;
    document.getElementById('rmEndBtn').disabled = false;
    const pill = document.getElementById('rmHeatPill');
    pill.className = 'prod-status run';
    pill.textContent = auto ? 'AUTO HEAT' : 'HEAT ACTIVE';
    updateMillPill();
    renderHmdLine();
    renderRmPanels();
    return true;
  }

  /** Auto Start RM heat when HT kW crosses above Mill start threshold */
  function maybeAutoStartRmHeat() {
    const { startThr } = getKwThresholds();
    const above = (Number(lastLiveKw) || 0) > startThr;
    if (above && prevKwBelowStart && !rmActive) {
      startRmHeat({ auto: true });
    }
    prevKwBelowStart = !above;
  }

  document.getElementById('rmStartBtn').addEventListener('click', () => {
    startRmHeat({ auto: false });
  });

  document.getElementById('rmEndBtn').addEventListener('click', async () => {
    if (!rmActive || !rmHeat) return;
    if (plcHmdLive && rmBaseline) hmdCounts = heatRel(plcAbsCounts, rmBaseline);
    const loss = hmdLoss();
    // Use current length selection at end so operator can correct cut length before save
    syncRmLengthUI(false);
    const dims = rmBilletDims();
    const unit = billetUnitTon(dims.w, dims.h, dims.L, dims.density);
    // Final energy: integrated kW and/or meter delta
    let totalKwh = rmHeat.integKwh || (rmHeat.onLoadKwh + rmHeat.idleKwh);
    if (lastLiveKwh != null && rmHeat.kwhMeterStart != null && Number.isFinite(lastLiveKwh)) {
      const delta = lastLiveKwh - rmHeat.kwhMeterStart;
      if (delta >= 0) totalKwh = Math.max(totalKwh, delta);
    }
    rmHeat.totalKwh = totalKwh;
    const goodTon = loss.tmt * unit;
    const runWindow = rmHeat.onLoadSec + rmHeat.idleSec;
    const row = {
      ...rmHeat,
      endedAt: new Date().toISOString(),
      unitTon: unit,
      billet: { w: dims.w, h: dims.h, L: dims.L, density: dims.density },
      billetL: dims.L,
      productSize: `${dims.w}×${dims.h}×${dims.L}`,
      r3: loss.r3,
      r1: loss.r3,
      tmt: loss.tmt,
      missPcs: loss.miss,
      missTon: loss.miss * unit,
      goodTon,
      utilPct: runWindow > 0 ? (rmHeat.onLoadSec / runWindow) * 100 : 0,
      kwhPerTon: goodTon > 0 ? rmHeat.totalKwh / goodTon : 0,
      hmd: { ...hmdCounts },
      plcAbs: { ...plcAbsCounts },
      stageLoss: loss.stageLoss,
      auto: !!rmHeat.autoStarted,
      /* Freeze heat totals here — live HMD reset after End must not change this row */
      frozen: true,
    };
    const diskOk = await persistHeat('rm_heats', row);
    rmActive = false;
    document.getElementById('rmStartBtn').disabled = false;
    document.getElementById('rmEndBtn').disabled = true;
    const pill = document.getElementById('rmHeatPill');
    pill.className = 'prod-status stop'; pill.textContent = 'SAVED';
    renderRmTable();
    if (document.getElementById('view-prodreport')?.classList.contains('active')) {
      try { generateCombinedReport(); } catch (e) { /* ignore */ }
    }
    alert(
      `RM heat ${row.heatNo}\n` +
      `Billet ${dims.w}×${dims.h}×${dims.L} mm · unit ${unit.toFixed(4)} t\n` +
      `Good ${row.goodTon.toFixed(3)} t (= ${row.tmt} × ${unit.toFixed(4)}) · Miss ${row.missPcs} pcs\n` +
      `On-load ${fmtTime(row.onLoadSec)} · Idle ${fmtTime(row.idleSec)} · Util ${row.utilPct.toFixed(1)}%\n` +
      `SEC ${row.kwhPerTon.toFixed(2)} kWh/t (${row.totalKwh.toFixed(2)} kWh)` +
      (diskOk ? '\n(saved to disk)' : '\n(browser only — start bridge for disk)')
    );
    rmHeat = null;
    rmBaseline = null;
    if (plcHmdLive) hmdCounts = { ...plcAbsCounts };
    else hmdCounts = emptyStageMap();
    // session continues from HT kW bands after heat save
    rmSession = { onLoadSec: 0, idleSec: 0, stopSec: 0, onLoadKwh: 0, idleKwh: 0, totalKwh: 0, integKwh: 0 };
    renderHmdLine();
    renderRmPanels();
    if (typeof updatePlantOverviewMis === 'function') updatePlantOverviewMis();
  });

  document.getElementById('rmPrintBtn').addEventListener('click', () => window.print());
  document.getElementById('rmDayBtn').addEventListener('click', () => {
    const d = document.getElementById('rmDayDate').value; if (!d) return;
    const b = dayBounds(d); summarizeRm(filterByRange(rmStore, b.start, b.end));
  });
  document.getElementById('rmMonthBtn').addEventListener('click', () => {
    const m = document.getElementById('rmMonth').value; if (!m) return;
    const b = monthBounds(m); summarizeRm(filterByRange(rmStore, b.start, b.end));
  });
  document.getElementById('rmExportBtn').addEventListener('click', () => {
    if (!rmStore.length) { alert('No RM heats'); return; }
    const hdr = ['heatNo', 'endedAt', 'billetL', 'unitTon', 'r3', 'tmt', 'missPcs', 'goodTon', 'onLoadSec', 'idleSec', 'utilPct', 'totalKwh', 'kwhPerTon', 'idleKwh'];
    const lines = [hdr.join(',')].concat(rmStore.map(r => hdr.map(k => {
      if (k === 'r3') return r.r3 ?? r.r1;
      if (k === 'billetL') return r.billetL ?? r.billet?.L ?? '';
      return r[k];
    }).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'rm_heats.csv'; a.click();
  });
  document.getElementById('rmReloadBtn').addEventListener('click', async () => {
    await refreshStores(); renderRmTable(); alert('RM heats reloaded');
  });

  document.getElementById('rmAutoDemo').addEventListener('change', (e) => {
    if (rmAutoTimer) { clearInterval(rmAutoTimer); rmAutoTimer = null; }
    if (!e.target.checked) return;
    if (plcHmdLive && !document.getElementById('rmManualHmd')?.checked) {
      alert('Live DB8 HMD is active — enable “Manual HMD” to use auto demo counts.');
      e.target.checked = false;
      return;
    }
    rmAutoTimer = setInterval(() => {
      const order = HMD_STAGES.map(s => s.id);
      for (let i = 0; i < order.length; i++) {
        if (i === 0 || (hmdCounts[order[i - 1]] || 0) > (hmdCounts[order[i]] || 0)) {
          if (Math.random() > 0.35) {
            hmdCounts[order[i]] = (hmdCounts[order[i]] || 0) + 1;
            plcAbsCounts[order[i]] = (plcAbsCounts[order[i]] || 0) + 1;
            /* Simulate real HMD beam pulse so billet animates through the stand */
            pulseHmdBit(order[i], 750);
            break;
          }
        }
      }
      if (rmActive && rmHeat) rmHeat.hmd = { ...hmdCounts };
      renderRmPanels();
    }, 2500);
  });

  window.updateProductionMis = function updateProductionMis(d) {
    window.latestPlcData = d || {};
    lastLiveKw = kW(d['Total Active Power_2']);
    lastLiveKwh = n(d['I_KWH_']);

    const parsed = readPlcAbsFromData(d);
    /* Always apply CCM HMD bits when tags are present (even if counts are 0) */
    if (d && (d[CCM_HMD_TAGS.s1] != null || d[CCM_HMD_TAGS.s2] != null || parsed.any)) {
      plcCcmBits = {
        s1: ccmHmdTagHigh(CCM_HMD_TAGS.s1, parsed.ccmBits?.s1),
        s2: ccmHmdTagHigh(CCM_HMD_TAGS.s2, parsed.ccmBits?.s2),
      };
    }
    if (parsed.any) {
      plcHmdLive = true;
      plcAbsCounts = parsed.abs;
      plcAbsCcm = parsed.ccm;
      plcHmdBits = parsed.bits;
      plcCcmBits = parsed.ccmBits || plcCcmBits;

      const manualRm = document.getElementById('rmManualHmd')?.checked;
      if (!manualRm) {
        hmdCounts = rmActive && rmBaseline ? heatRel(plcAbsCounts, rmBaseline) : { ...plcAbsCounts };
        if (rmActive && rmHeat) rmHeat.hmd = { ...hmdCounts };
      }

      const manualCcm = document.getElementById('ccmManualHmd')?.checked;
      if (!manualCcm) {
        const rel = ccmActive && ccmBaseline ? ccmHeatRel(plcAbsCcm, ccmBaseline) : plcAbsCcm;
        document.getElementById('ccmS1').value = rel.s1;
        document.getElementById('ccmS2').value = rel.s2;
        refreshCcmFormula();
      }

      const meta = document.getElementById('sourceMeta');
      if (meta) meta.textContent = `DB4 PAC3200 · DB8 BILLETS_COUNTS${parsed.billetsOk ? '' : ' (partial)'}`;
    } else if (d._billets_ok === false) {
      plcHmdLive = false;
    }

    updateMillPill();
    maybeAutoStartRmHeat();
    maybeAutoCcmHeat();
    ensureRmTick();

    if (document.getElementById('view-rmmis').classList.contains('active')) {
      renderHmdLine();
      renderRmPanels();
    }
    if (document.getElementById('view-ccm')?.classList.contains('active')) {
      refreshCcmFormula();
      window.renderCcmPassAnimation();
      window.renderCcmTimingPanel();
    }
    updatePlantOverviewMis();
  };

  // init
  restoreKwThresholds();
  syncThresholdsToMes();
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ds = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const ms = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
  document.getElementById('ccmDayDate').value = ds;
  document.getElementById('rmDayDate').value = ds;
  document.getElementById('ccmMonth').value = ms;
  document.getElementById('rmMonth').value = ms;
  document.getElementById('ccmDayCards').innerHTML = `<div class="rs"><div class="l">Day / month</div><div class="v">—</div><div class="s">Pick date and calculate</div></div>`;
  document.getElementById('rmDayCards').innerHTML = `<div class="rs"><div class="l">Day / month</div><div class="v">—</div><div class="s">Pick date and calculate</div></div>`;

  refreshStores().then(() => {
    refreshCcmFormula();
    renderCcmTable();
    renderHmdLine();
    renderRmPanels();
    renderRmTable();
    ensureRmTick();
    updatePlantOverviewMis();
  });

  /* ——— Combined Production Report ——— */
  function fmtTimeReport(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  window.prepareProdReport = function prepareProdReport() {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ds = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    if (!document.getElementById('prFrom').value) document.getElementById('prFrom').value = ds;
    if (!document.getElementById('prTo').value) document.getElementById('prTo').value = ds;
  };

  function generateCombinedReport() {
    const from = document.getElementById('prFrom').value;
    const to = document.getElementById('prTo').value;
    if (!from || !to) { alert('Select From and To dates'); return; }
    const start = from + 'T00:00:00';
    const end = to + 'T23:59:59';
    const ccmRows = filterByRange(ccmStore, start, end);
    const rmRows = filterByRange(rmStore, start, end);

    document.getElementById('prEmpty').style.display = 'none';
    document.getElementById('prContent').style.display = 'block';
    document.getElementById('prodReportPrintMeta').textContent =
      `Period: ${from} → ${to} · Generated ${new Date().toLocaleString('en-GB')}`;
    document.getElementById('prodReportBannerSub').textContent = `Period ${from} → ${to}`;
    document.getElementById('prodReportBannerRight').textContent =
      `${ccmRows.length} CCM heats · ${rmRows.length} RM heats`;

    const mega = (lbl, val, sub, accent) =>
      `<div class="mega ${accent || ''}"><div class="m-lbl">${lbl}</div><div class="m-val">${val}</div><div class="m-sub">${sub}</div></div>`;

    const ccmPcs = ccmRows.reduce((s, r) => s + (r.totalPcs || 0), 0);
    const ccmTons = ccmRows.reduce((s, r) => s + (r.tons || 0), 0);
    const ccmS1 = ccmRows.reduce((s, r) => s + (r.s1 || 0), 0);
    const ccmS2 = ccmRows.reduce((s, r) => s + (r.s2 || 0), 0);
    document.getElementById('prCcmCards').innerHTML = [
      mega('CCM heats', String(ccmRows.length), `${from} → ${to}`, 'accent-teal'),
      mega('Strand 1 billets', String(ccmS1), 'HMD S1', 'accent-teal'),
      mega('Strand 2 billets', String(ccmS2), 'HMD S2', 'accent-teal'),
      mega('CCM production', ccmTons.toFixed(3) + ' t', `${ccmPcs} billets total`, 'accent-ok'),
    ].join('');
    document.getElementById('prCcmBody').innerHTML = ccmRows.length
      ? ccmRows.map(h => `<tr><td>${h.heatNo}</td><td>${(h.endedAt || '').replace('T', ' ').slice(0, 19)}</td><td>${h.s1}</td><td>${h.s2}</td><td>${h.totalPcs}</td><td>${Number(h.tons).toFixed(3)}</td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">No CCM heats in range</td></tr>`;

    /* Saved RM heats only — never live HMD line (those counters reset each heat) */
    const openRm = openRmHeatReportRow();
    const rmHeatRows = openRm ? [openRm, ...rmRows] : rmRows.slice();
    const billetsR3 = rmRows.reduce((s, r) => s + (r.r3 ?? r.r1 ?? 0), 0);
    const billetsTmt = rmRows.reduce((s, r) => s + (r.tmt || 0), 0);
    const goodT = rmRows.reduce((s, r) => s + (r.goodTon || 0), 0);
    const miss = rmRows.reduce((s, r) => s + (r.missPcs || 0), 0);
    const missT = rmRows.reduce((s, r) => s + (r.missTon || (r.missPcs || 0) * (r.unitTon || 0)), 0);
    const onSec = rmRows.reduce((s, r) => s + (r.onLoadSec || 0), 0);
    const idleSec = rmRows.reduce((s, r) => s + (r.idleSec || 0), 0);
    const runSec = onSec + idleSec;
    const kwh = rmRows.reduce((s, r) => s + (r.totalKwh || 0), 0);
    const idleKwh = rmRows.reduce((s, r) => s + (r.idleKwh || 0), 0);
    const util = runSec > 0 ? (onSec / runSec) * 100 : 0;
    const sec = goodT > 0 ? kwh / goodT : 0;
    const yieldPct = billetsR3 > 0 ? (billetsTmt / billetsR3) * 100 : 0;

    document.getElementById('prRmProdCards').innerHTML = [
      mega('RM heats', String(rmRows.length) + (openRm ? ' +1 open' : ''), 'Saved heats · not live HMD', 'accent-info'),
      mega('Billets at R3', String(billetsR3), 'Sum of saved heats', 'accent-info'),
      mega('Billets passed (TMT)', String(billetsTmt), 'Sum of saved heats', 'accent-ok'),
      mega('Total production', goodT.toFixed(3) + ' t', 'Heat-wise TMT × unit wt', 'accent-ok'),
    ].join('');

    const rmHeatBody = document.getElementById('prRmHeatBody');
    if (rmHeatBody) {
      rmHeatBody.innerHTML = rmHeatRows.length
        ? rmHeatRows.map(h => `<tr${h.open ? ' style="background:rgba(13,148,136,.08)"' : ''}>
            <td>${h.heatNo}${h.open ? ' · OPEN' : ''}</td>
            <td>${(h.startedAt || '').replace('T', ' ').slice(0, 19) || '—'}</td>
            <td>${h.open ? 'in progress' : (h.endedAt || '').replace('T', ' ').slice(0, 19)}</td>
            <td>${h.r3 ?? h.r1 ?? 0}</td>
            <td>${h.tmt ?? 0}</td>
            <td>${h.missPcs ?? 0}</td>
            <td>${Number(h.goodTon || 0).toFixed(3)}</td>
            <td>${h.open ? 'OPEN' : (h.auto ? 'AUTO' : (h.source || 'saved'))}</td>
          </tr>`).join('')
        : `<tr><td colspan="8" class="empty">No saved RM heats in range — End &amp; save on HMD · Production to record a heat</td></tr>`;
    }

    document.getElementById('prRmYieldCards').innerHTML = [
      mega('Miss-roll', String(miss) + ' pcs', `Saved heats · ${missT.toFixed(3)} t`, miss ? 'accent-warn' : 'accent-ok'),
      mega('Yield', yieldPct.toFixed(1) + ' %', 'Saved TMT ÷ R3', yieldPct >= 98 ? 'accent-ok' : 'accent-warn'),
      mega('CCM vs RM', (ccmTons - goodT).toFixed(3) + ' t', 'CCM tons − RM good tons', 'accent-info'),
      mega('Energy used', kwh.toFixed(1) + ' kWh', `Idle loss ${idleKwh.toFixed(1)} kWh`, 'accent-info'),
    ].join('');

    document.getElementById('prRmTimeCards').innerHTML = [
      mega('Running time', fmtTimeReport(runSec), 'Saved heats · On-load + Idle', 'accent-info'),
      mega('On-load time', fmtTimeReport(onSec), 'From saved RM heats', 'accent-ok'),
      mega('Idle time', fmtTimeReport(idleSec), 'From saved RM heats', 'accent-warn'),
      mega('Utilization', util.toFixed(1) + ' %', 'On-load ÷ Running', util >= 75 ? 'accent-ok' : 'accent-warn'),
      mega('Unit / ton (SEC)', sec.toFixed(2), 'kWh / production tonne', 'accent-info'),
      mega('Idle energy loss', idleKwh.toFixed(2), 'kWh during idle running', 'accent-warn'),
      mega('Avg kWh / heat', rmRows.length ? (kwh / rmRows.length).toFixed(1) : '0', 'Energy intensity', 'accent-info'),
      mega('Avg t / heat', rmRows.length ? (goodT / rmRows.length).toFixed(3) : '0', 'Production per heat', 'accent-ok'),
    ].join('');

    document.getElementById('prRmBody').innerHTML = rmHeatRows.length
      ? rmHeatRows.map(h => {
          const run = (h.onLoadSec || 0) + (h.idleSec || 0);
          return `<tr${h.open ? ' style="background:rgba(13,148,136,.08)"' : ''}>
            <td>${h.heatNo}${h.open ? ' · OPEN' : ''}</td>
            <td>${h.open ? 'in progress' : (h.endedAt || '').replace('T', ' ').slice(0, 19)}</td>
            <td>${h.r3 ?? h.r1 ?? 0}</td><td>${h.tmt ?? 0}</td><td>${h.missPcs ?? 0}</td>
            <td>${Number(h.goodTon || 0).toFixed(3)}</td>
            <td>${fmtTimeReport(h.onLoadSec)}</td><td>${fmtTimeReport(h.idleSec)}</td><td>${fmtTimeReport(run)}</td>
            <td>${Number(h.utilPct || 0).toFixed(1)}</td>
            <td>${Number(h.kwhPerTon || 0).toFixed(2)}</td>
            <td>${Number(h.idleKwh || 0).toFixed(2)}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="12" class="empty">No RM heats in range</td></tr>`;

    window._lastProdReport = {
      from, to, ccmRows, rmRows, rmHeatRows,
      summary: {
        ccmTons, ccmPcs, goodT, miss, missT, onSec, idleSec, runSec, util, sec,
        kwh, idleKwh, billetsR3, billetsR1: billetsR3, billetsTmt, yieldPct, ccmS1, ccmS2,
        rmHeatsSaved: rmRows.length, rmOpen: !!openRm,
      },
    };
    buildSinglePagePrintSheet(window._lastProdReport);
  }

  function buildSinglePagePrintSheet(rep) {
    const { from, to, ccmRows, rmRows, summary: s } = rep;
    const kpi = (l, v, sub) => `<div class="ps-kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub || ''}</div></div>`;
    const maxRows = 6;
    const ccmShow = ccmRows.slice(0, maxRows);
    const rmShow = rmRows.slice(0, maxRows);
    const ccmMore = ccmRows.length > maxRows ? `<tr><td colspan="6">… and ${ccmRows.length - maxRows} more heats (see screen / CSV)</td></tr>` : '';

    document.getElementById('prPrintSheet').innerHTML = `
      <div class="ps-head">
        <div>
          <h1>PLANT PRODUCTION REPORT — CCM &amp; ROLLING MILL</h1>
          <p>Period: ${from} → ${to} · Printed ${new Date().toLocaleString('en-GB')}</p>
        </div>
        <div>
          <p style="text-align:right;">${ccmRows.length} CCM heats · ${rmRows.length} RM heats</p>
        </div>
      </div>

      <div class="ps-sec">1 · CCM production</div>
      <div class="ps-grid">
        ${kpi('CCM heats', ccmRows.length, from + ' → ' + to)}
        ${kpi('Strand 1 billets', s.ccmS1, 'HMD S1')}
        ${kpi('Strand 2 billets', s.ccmS2, 'HMD S2')}
        ${kpi('CCM production', s.ccmTons.toFixed(3) + ' t', s.ccmPcs + ' billets')}
      </div>
      <table>
        <thead><tr><th>Heat No</th><th>Ended</th><th>S1</th><th>S2</th><th>Billets</th><th>Tons</th></tr></thead>
        <tbody>
          ${ccmShow.length ? ccmShow.map(h => `<tr><td>${h.heatNo}</td><td>${(h.endedAt || '').replace('T', ' ').slice(0, 16)}</td><td>${h.s1}</td><td>${h.s2}</td><td>${h.totalPcs}</td><td>${Number(h.tons).toFixed(3)}</td></tr>`).join('') : '<tr><td colspan="6">No CCM heats</td></tr>'}
          ${ccmMore}
        </tbody>
      </table>

      <div class="ps-sec">2 · Rolling mill — heat-wise (saved heats, not live HMD)</div>
      <div class="ps-grid">
        ${kpi('RM heats', s.rmHeatsSaved ?? rmRows.length, 'Saved heats in period')}
        ${kpi('Billets at R3', s.billetsR3 ?? s.billetsR1, 'Sum of saved heats')}
        ${kpi('Billets passed (TMT)', s.billetsTmt, 'Sum of saved heats')}
        ${kpi('Total production', s.goodT.toFixed(3) + ' t', 'Heat-wise tons')}
        ${kpi('Miss-roll', s.miss + ' pcs', (s.missT || 0).toFixed(3) + ' t · R3−TMT')}
        ${kpi('Yield', (s.yieldPct || 0).toFixed(1) + ' %', 'TMT ÷ R3')}
        ${kpi('Energy used', s.kwh.toFixed(1) + ' kWh', 'Idle loss ' + s.idleKwh.toFixed(1))}
        ${kpi('Unit / ton (SEC)', s.sec.toFixed(2), 'kWh / tonne')}
      </div>
      <table>
        <thead><tr><th>Heat No</th><th>Started</th><th>Ended</th><th>R3</th><th>TMT</th><th>Miss</th><th>Prod t</th><th>How</th></tr></thead>
        <tbody>
          ${(rep.rmHeatRows || rmRows).slice(0, maxRows).length
            ? (rep.rmHeatRows || rmRows).slice(0, maxRows).map(h => `<tr>
              <td>${h.heatNo}${h.open ? ' · OPEN' : ''}</td>
              <td>${(h.startedAt || '').replace('T', ' ').slice(0, 16) || '—'}</td>
              <td>${h.open ? 'in progress' : (h.endedAt || '').replace('T', ' ').slice(0, 16)}</td>
              <td>${h.r3 ?? h.r1 ?? 0}</td><td>${h.tmt ?? 0}</td><td>${h.missPcs ?? 0}</td>
              <td>${Number(h.goodTon || 0).toFixed(3)}</td>
              <td>${h.open ? 'OPEN' : (h.auto ? 'AUTO' : 'saved')}</td>
            </tr>`).join('')
            : '<tr><td colspan="8">No RM heats</td></tr>'}
          ${(rep.rmHeatRows || rmRows).length > maxRows ? `<tr><td colspan="8">… and ${(rep.rmHeatRows || rmRows).length - maxRows} more heats</td></tr>` : ''}
        </tbody>
      </table>

      <div class="ps-sec">3 · Running / on-load / idle time (saved heats)</div>
      <div class="ps-grid">
        ${kpi('Running time', fmtTimeReport(s.runSec), 'On-load + Idle')}
        ${kpi('On-load time', fmtTimeReport(s.onSec), 'From saved RM heats')}
        ${kpi('Idle time', fmtTimeReport(s.idleSec), 'From saved RM heats')}
        ${kpi('Utilization', s.util.toFixed(1) + ' %', 'On-load ÷ Running')}
      </div>

      <div class="ps-sec">4 · RM heat-wise timing &amp; SEC</div>
      <table>
        <thead><tr><th>Heat</th><th>Ended</th><th>R3</th><th>TMT</th><th>Miss</th><th>Prod t</th><th>On-load</th><th>Idle</th><th>Run</th><th>Util%</th><th>kWh/t</th></tr></thead>
        <tbody>
          ${rmShow.length ? rmShow.map(h => {
            const run = (h.onLoadSec || 0) + (h.idleSec || 0);
            return `<tr>
              <td>${h.heatNo}</td><td>${(h.endedAt || '').replace('T', ' ').slice(0, 16)}</td>
              <td>${h.r3 ?? h.r1}</td><td>${h.tmt}</td><td>${h.missPcs}</td><td>${Number(h.goodTon).toFixed(3)}</td>
              <td>${fmtTimeReport(h.onLoadSec)}</td><td>${fmtTimeReport(h.idleSec)}</td><td>${fmtTimeReport(run)}</td>
              <td>${Number(h.utilPct).toFixed(1)}</td><td>${Number(h.kwhPerTon).toFixed(2)}</td>
            </tr>`;
          }).join('') : '<tr><td colspan="11">No RM heats</td></tr>'}
          ${rmRows.length > maxRows ? `<tr><td colspan="11">… and ${rmRows.length - maxRows} more heats (full list on screen / CSV)</td></tr>` : ''}
        </tbody>
      </table>
      <div class="ps-foot">RM report = saved heats only (like CCM) · Live HMD billet reset does not clear these rows · Miss-roll = R3 − TMT · Single A4 page</div>
    `;
  }

  window.updatePlantOverviewMis = function updatePlantOverviewMis() {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ds = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const b = dayBounds(ds);
    const ccmToday = filterByRange(ccmStore, b.start, b.end);
    const rmToday = filterByRange(rmStore, b.start, b.end);
    const ccmTons = ccmToday.reduce((s, r) => s + (r.tons || 0), 0);
    const ccmPcs = ccmToday.reduce((s, r) => s + (r.totalPcs || 0), 0);
    const goodTSaved = rmToday.reduce((s, r) => s + (r.goodTon || 0), 0);
    const missSaved = rmToday.reduce((s, r) => s + (r.missPcs || 0), 0);
    const onSecSaved = rmToday.reduce((s, r) => s + (r.onLoadSec || 0), 0);
    const idleSecSaved = rmToday.reduce((s, r) => s + (r.idleSec || 0), 0);
    const kwhSaved = rmToday.reduce((s, r) => s + (r.totalKwh || 0), 0);

    const liveSrc = (rmActive && rmHeat) ? rmHeat : rmSession;
    const onSecLive = liveSrc.onLoadSec || 0;
    const idleSecLive = liveSrc.idleSec || 0;
    const runLive = onSecLive + idleSecLive;
    const utilLive = runLive > 0 ? (onSecLive / runLive) * 100 : 0;
    const unit = rmUnitTon();
    const loss = hmdLoss();
    const goodLive = loss.tmt * unit;
    const kwhLive = liveSrc.totalKwh || 0;
    const secLive = goodLive > 0 ? kwhLive / goodLive : (goodTSaved > 0 ? kwhSaved / goodTSaved : 0);
    const band = millBandFromKw(lastLiveKw);
    const tmtLive = hmdCounts.tmt || 0;
    const r3Live = hmdCounts.r3 || hmdCounts.r1 || 0;
    const ccmS1Live = ccmActive
      ? Math.max(0, (plcAbsCcm.s1 || 0) - (ccmBaseline?.s1 || 0))
      : (plcAbsCcm.s1 || 0);
    const ccmS2Live = ccmActive
      ? Math.max(0, (plcAbsCcm.s2 || 0) - (ccmBaseline?.s2 || 0))
      : (plcAbsCcm.s2 || 0);

    const ccmM = document.getElementById('ovCcmMetrics');
    const rmM = document.getElementById('ovRmMetrics');
    const strip = document.getElementById('plantStrip');
    if (!ccmM || !rmM || !strip) return;

    ccmM.innerHTML = `
      <div><div class="pam-lbl">Today heats</div><div class="pam-val">${ccmToday.length}</div></div>
      <div><div class="pam-lbl">Today billets</div><div class="pam-val">${ccmPcs}</div></div>
      <div><div class="pam-lbl">Today tons</div><div class="pam-val">${ccmTons.toFixed(2)}<span class="pam-unit">t</span></div></div>
      <div><div class="pam-lbl">Live S1 / S2</div><div class="pam-val" style="font-size:15px">${ccmS1Live} / ${ccmS2Live}</div></div>`;

    rmM.innerHTML = `
      <div><div class="pam-lbl">Mill state</div><div class="pam-val" style="font-size:15px">${band.label}</div></div>
      <div><div class="pam-lbl">Live prod</div><div class="pam-val">${goodLive.toFixed(2)}<span class="pam-unit">t</span></div></div>
      <div><div class="pam-lbl">Util now</div><div class="pam-val">${utilLive.toFixed(0)}<span class="pam-unit">%</span></div></div>
      <div><div class="pam-lbl">Unit/ton</div><div class="pam-val">${goodLive > 0 || goodTSaved > 0 ? secLive.toFixed(1) : '—'}<span class="pam-unit">kWh/t</span></div></div>`;

    strip.innerHTML = [
      ['HT load', fmt(lastLiveKw, 1) + ' kW', band.label],
      ['R3 / TMT', `${r3Live} / ${tmtLive}`, plcHmdLive ? 'DB8' : 'count'],
      ['Miss now', Math.max(0, r3Live - tmtLive), 'R3−TMT'],
      ['On-load', fmtTime(onSecLive), `> ${band.onThr} kW`],
      ['Idle run', fmtTime(idleSecLive), `${band.startThr}–${band.onThr} kW`],
      ['Today RM', `${goodTSaved.toFixed(2)} t`, `${missSaved} miss · ${rmToday.length} heats`],
    ].map(([lbl, val, sub]) =>
      `<div class="plant-chip"><div class="c-lbl">${lbl}</div><div class="c-val">${val}</div><div class="c-sub">${sub}</div></div>`
    ).join('');
  };

  document.getElementById('prTodayBtn').addEventListener('click', () => {
    prepareProdReport();
    const d = document.getElementById('prFrom').value;
    document.getElementById('prTo').value = d;
    generateCombinedReport();
  });
  document.getElementById('prMonthBtn').addEventListener('click', () => {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const y = today.getFullYear(), m = pad(today.getMonth() + 1);
    const last = new Date(y, today.getMonth() + 1, 0).getDate();
    document.getElementById('prFrom').value = `${y}-${m}-01`;
    document.getElementById('prTo').value = `${y}-${m}-${pad(last)}`;
    generateCombinedReport();
  });
  async function resetProductionHeats(kind) {
    const labels = { ccm: 'CCM heats', rm: 'Rolling Mill heats', both: 'CCM + Rolling Mill heats' };
    const label = labels[kind] || kind;
    if (!confirm(`Reset ${label}?\n\nThis deletes saved heat history from browser + disk.\nLive HMD billet counters are not cleared by this.`)) {
      return;
    }
    try {
      const res = await fetch(`${BRIDGE_ORIGIN}/api/production/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        alert('Reset failed: ' + (j.error || res.status) + '\n(Is bridge_server.py running?)');
        return;
      }
    } catch (e) {
      alert('Reset failed — start bridge_server.py\n' + (e.message || e));
      return;
    }
    if (kind === 'ccm' || kind === 'both') {
      ccmStore = [];
      saveLocal('ccm_heats', []);
      ccmActive = false;
      ccmHeat = null;
      ccmBaseline = null;
      ccmLastStartedAt = null;
      try { localStorage.removeItem('ccm_last_started_at'); } catch (e) { /* ignore */ }
      const pill = document.getElementById('ccmHeatPill');
      if (pill) { pill.className = 'prod-status stop'; pill.textContent = 'NO HEAT'; }
      const sBtn = document.getElementById('ccmStartBtn');
      const eBtn = document.getElementById('ccmEndBtn');
      if (sBtn) sBtn.disabled = false;
      if (eBtn) eBtn.disabled = true;
      if (typeof renderCcmTable === 'function') renderCcmTable();
    }
    if (kind === 'rm' || kind === 'both') {
      rmStore = [];
      saveLocal('rm_heats', []);
      rmActive = false;
      rmHeat = null;
      rmBaseline = null;
      const pill = document.getElementById('rmHeatPill');
      if (pill) { pill.className = 'prod-status stop'; pill.textContent = 'NO HEAT'; }
      const sBtn = document.getElementById('rmStartBtn');
      const eBtn = document.getElementById('rmEndBtn');
      if (sBtn) sBtn.disabled = false;
      if (eBtn) eBtn.disabled = true;
      if (typeof renderRmTable === 'function') renderRmTable();
    }
    if (typeof updatePlantOverviewMis === 'function') updatePlantOverviewMis();
    try { generateCombinedReport(); } catch (e) { /* ignore */ }
    alert(`${label} reset complete.`);
  }

  document.getElementById('prResetCcmBtn')?.addEventListener('click', () => resetProductionHeats('ccm'));
  document.getElementById('prResetRmBtn')?.addEventListener('click', () => resetProductionHeats('rm'));
  document.getElementById('prResetAllBtn')?.addEventListener('click', () => resetProductionHeats('both'));
  document.getElementById('prGenBtn').addEventListener('click', generateCombinedReport);
  document.getElementById('prPrintBtn').addEventListener('click', () => {
    if (!window._lastProdReport) { alert('Generate report first'); return; }
    buildSinglePagePrintSheet(window._lastProdReport);
    document.body.classList.add('print-prod');
    const cleanup = () => {
      document.body.classList.remove('print-prod');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => window.print(), 50);
  });
  document.getElementById('prCsvBtn').addEventListener('click', () => {
    if (!window._lastProdReport) { alert('Generate report first'); return; }
    const { from, to, ccmRows, rmRows } = window._lastProdReport;
    const lines = [
      `Plant Production Report,${from},${to}`,
      '',
      'CCM Heats',
      'heatNo,endedAt,s1,s2,totalPcs,tons',
      ...ccmRows.map(h => [h.heatNo, h.endedAt, h.s1, h.s2, h.totalPcs, h.tons].join(',')),
      '',
      'Rolling Mill Heats',
      'heatNo,endedAt,r3,tmt,missPcs,goodTon,onLoadSec,idleSec,runSec,utilPct,kwhPerTon,idleKwh,totalKwh',
      ...rmRows.map(h => {
        const run = (h.onLoadSec || 0) + (h.idleSec || 0);
        return [h.heatNo, h.endedAt, h.r3 ?? h.r1, h.tmt, h.missPcs, h.goodTon, h.onLoadSec, h.idleSec, run, h.utilPct, h.kwhPerTon, h.idleKwh, h.totalKwh].join(',');
      }),
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `production_report_${from}_${to}.csv`;
    a.click();
  });

  // Billet length catalog 5600–9000 mm + dimension persistence
  fillLengthSelect(document.getElementById('ccmBilletL'), 6000);
  fillLengthSelect(document.getElementById('rmBilletL'), 6000);
  loadRmBilletDims();
  syncRmLengthUI(false);
  refreshRmBilletFormula();

  ['rmBilletW', 'rmBilletH', 'rmDensity'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      persistRmBilletDims();
      refreshRmBilletFormula();
      if (typeof renderRmPanels === 'function') renderRmPanels();
    });
  });
  document.getElementById('rmBilletL')?.addEventListener('change', () => {
    syncRmLengthUI(false);
    persistRmBilletDims();
    refreshRmBilletFormula();
    if (typeof renderRmPanels === 'function') renderRmPanels();
  });
  document.getElementById('rmBilletLCustom')?.addEventListener('change', () => {
    syncRmLengthUI(true);
    persistRmBilletDims();
    refreshRmBilletFormula();
    if (typeof renderRmPanels === 'function') renderRmPanels();
  });
  document.getElementById('rmSyncCcmSizeBtn')?.addEventListener('click', syncRmSizeFromCcm);
  document.getElementById('ccmBilletL')?.addEventListener('change', () => {
    if (typeof refreshCcmFormula === 'function') refreshCcmFormula();
  });

  prepareProdReport();
})();
