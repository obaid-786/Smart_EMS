/* Smart Steel Plant MES — full industrial command center
   Tabs: Plant | CCM | Rolling Mill | Energy | AI | Reports | Alarms
   Backend: /api/mes/dashboard (+ reports, auth, thresholds)
*/
(function () {
  const MES = {
    token: localStorage.getItem('mes_token') || '',
    theme: localStorage.getItem('mes_theme') || 'dark',
    tab: 'plant',
    data: null,
    charts: {},
  };

  function mesUrl(path) {
    const base = (typeof BRIDGE_ORIGIN !== 'undefined') ? BRIDGE_ORIGIN : 'http://localhost:5000';
    return base + path;
  }
  function fmt(v, d = 1) {
    const x = Number(v);
    return Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  async function mesFetch(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (MES.token) headers.Authorization = 'Bearer ' + MES.token;
    const res = await fetch(mesUrl(path), Object.assign({}, opts, { headers, cache: 'no-store' }));
    const j = await res.json().catch(() => ({}));
    return { res, j };
  }

  function applyTheme(theme) {
    MES.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mes_theme', theme);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }

  function destroyCharts() {
    Object.keys(MES.charts).forEach(k => { try { MES.charts[k].destroy(); } catch (e) {} delete MES.charts[k]; });
  }

  function chart(id, cfg) {
    const el = document.getElementById(id);
    if (!el || typeof Chart === 'undefined') return null;
    if (MES.charts[id]) { try { MES.charts[id].destroy(); } catch (e) {} }
    const dark = MES.theme === 'dark';
    Chart.defaults.color = dark ? '#b8c2d4' : '#3a4252';
    Chart.defaults.borderColor = dark ? '#2c3648' : '#d0d5de';
    MES.charts[id] = new Chart(el, cfg);
    return MES.charts[id];
  }

  function kpi(label, value, sub, accent) {
    return `<div class="mega ${accent || ''}"><div class="m-lbl">${label}</div><div class="m-val">${value}</div><div class="m-sub">${sub || ''}</div></div>`;
  }

  /** Prefer HMD Production (plant_mis) timers so Smart EMS matches floor MIS */
  function floorSession(sess) {
    const base = sess || {};
    if (typeof window.getRmTimingSnapshot === 'function') {
      try {
        const snap = window.getRmTimingSnapshot();
        if (snap) {
          return Object.assign({}, base, snap, {
            _from_floor: true,
            _label: snap.heat_open ? 'RM heat open' : 'RM session',
          });
        }
      } catch (e) { /* fall through */ }
    }
    return base;
  }

  /** Overlay CCM / RM MIS + HMD Production values onto MES API payload */
  function withFloorData(d) {
    const out = Object.assign({}, d || {});
    if (typeof window.getFloorMesSnapshot !== 'function') {
      out.session = floorSession(out.session);
      return out;
    }
    let floor;
    try { floor = window.getFloorMesSnapshot(); } catch (e) { floor = null; }
    if (!floor) {
      out.session = floorSession(out.session);
      return out;
    }
    out._floor = true;
    out.unit_ton = floor.unit_ton != null ? floor.unit_ton : out.unit_ton;
    /* Floor wins completely for live tags — same numbers as CCM / HMD screens */
    out.session = Object.assign({}, floor.session || {}, {
      _from_floor: true,
      _label: floor.session?.heat_open ? 'RM heat open' : 'RM session',
    });
    out.hmd = floor.hmd || {};
    out.plant = Object.assign({}, out.plant || {}, floor.plant || {});
    out.thresholds = Object.assign({}, out.thresholds || {}, floor.thresholds || {});
    out.shared_tags = floor.shared_tags || null;
    if (floor.live_energy) {
      out.live_energy = Object.assign({}, out.live_energy || {}, floor.live_energy, {
        kw: floor.live_energy.kw,
        kwh: floor.live_energy.kwh != null ? floor.live_energy.kwh : out.live_energy?.kwh,
      });
    }
    if (floor.ccm_unit_ton != null) out.ccm_unit_ton = floor.ccm_unit_ton;
    out.ccm = Object.assign({}, out.ccm || {}, {
      today: floor.ccm.today,
      month: floor.ccm.month,
      year: floor.ccm.year,
      rows: (floor.ccm.rows && floor.ccm.rows.length) ? floor.ccm.rows : (out.ccm?.rows || []),
      live_s1: floor.ccm.live_s1,
      live_s2: floor.ccm.live_s2,
      heat_open: floor.ccm.heat_open,
      heat_no: floor.ccm.heat_no,
    });
    out.rm = Object.assign({}, out.rm || {}, {
      today: floor.rm.today,
      month: floor.rm.month,
      year: floor.rm.year,
      rows: (floor.rm.rows && floor.rm.rows.length) ? floor.rm.rows : (out.rm?.rows || []),
      live: floor.rm.live,
      heat_open: floor.rm.heat_open,
      heat_no: floor.rm.heat_no,
    });
    out.charts = Object.assign({}, out.charts || {}, {
      heat_tons: (floor.charts.heat_tons && floor.charts.heat_tons.length)
        ? floor.charts.heat_tons : (out.charts?.heat_tons || []),
      miss_vs_yield: floor.charts.miss_vs_yield || out.charts?.miss_vs_yield,
      run_idle: floor.charts.run_idle || out.charts?.run_idle,
      hourly_kw: out.charts?.hourly_kw || [],
    });
    return out;
  }

  function renderShell() {
    const root = document.getElementById('mesOverviewRoot');
    if (!root) return;
    root.innerHTML = `
      <div class="mes-tabs no-print" id="mesTabs">
        <button type="button" data-mes-tab="plant" class="active">Plant</button>
        <button type="button" data-mes-tab="ccm">CCM</button>
        <button type="button" data-mes-tab="rm">Rolling Mill</button>
        <button type="button" data-mes-tab="energy">Energy</button>
        <button type="button" data-mes-tab="ai">AI Analytics</button>
        <button type="button" data-mes-tab="reports">Reports</button>
        <button type="button" data-mes-tab="alarms">Alarms</button>
      </div>
      <div id="mesTabBody"><div class="empty">Loading Smart Steel MES…</div></div>`;
    document.querySelectorAll('[data-mes-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        MES.tab = btn.getAttribute('data-mes-tab');
        document.querySelectorAll('[data-mes-tab]').forEach(b => b.classList.toggle('active', b === btn));
        paint();
      });
    });
  }

  function hmdFlow(hmd) {
    const counts = hmd.counts || {};
    const bits = hmd.bits || {};
    const losses = hmd.losses || [];
    const lossMap = {};
    losses.forEach(L => { lossMap[L.to] = L.lost; });
    const stages = (hmd.line || []).length
      ? hmd.line
      : [
        { id: 'ccm_s1', label: 'CCM S1', area: 'ccm' }, { id: 'ccm_s2', label: 'CCM S2', area: 'ccm' },
        { id: 'entry', label: 'RM Entry', area: 'rm' }, { id: 'r3', label: 'R3', area: 'rm' },
        { id: 'ccs1', label: 'PCS1', area: 'rm' }, { id: 'ccs2', label: 'CCS2', area: 'rm' },
        { id: 'dshear', label: 'Shear', area: 'rm' }, { id: 'blk_in', label: 'Blk In', area: 'rm' },
        { id: 'blk_out', label: 'Blk Out', area: 'rm' }, { id: 'tmt', label: 'TMT', area: 'rm' },
      ];
    return `<div class="hmd-line mes-flow">${stages.map((s, i) => {
      const lost = lossMap[s.id] || 0;
      const on = !!bits[s.id];
      let cls = lost > 0 ? 'loss' : 'ok';
      if (on) cls += ' live';
      return `${i ? '<div class="hmd-arrow">→</div>' : ''}
        <div class="hmd-node ${cls}">
          <div class="hmd-name">${s.label}${on ? ' ●' : ''}</div>
          <div class="hmd-count">${counts[s.id] || 0}</div>
          <div class="hmd-delta">${lost ? 'loss ' + lost : (s.area || '')}</div>
        </div>`;
    }).join('')}</div>`;
  }

  function paintPlant(d) {
    const plant = d.plant || {}, ccm = d.ccm?.today || {}, rm = d.rm?.today || {};
    const sess = floorSession(d.session || {}), en = d.live_energy || {}, hmd = d.hmd || {};
    const shift = d.shift || {};
    const tags = d.shared_tags || {};
    const s1 = d.ccm?.live_s1 ?? tags.ccm_s1 ?? 0;
    const s2 = d.ccm?.live_s2 ?? tags.ccm_s2 ?? 0;
    const ccmTons = ccm.live_tons ?? tags.ccm_tons ?? ccm.tons ?? 0;
    const ccmPcs = ccm.live_billets ?? tags.ccm_billets ?? ccm.billets ?? (s1 + s2);
    const rmTons = rm.good_tons_live ?? tags.good_tons ?? rm.good_tons ?? 0;
    const tmt = hmd.finished ?? tags.tmt ?? 0;
    const r3 = hmd.at_r3 ?? tags.r3 ?? 0;
    const miss = hmd.miss_roll ?? tags.miss ?? 0;
    const sec = rm.kwh_per_ton ?? tags.kwh_per_ton ?? en.kwh_per_ton ?? 0;
    return `
      <div class="mes-hero">
        <div>
          <div class="mes-kicker">Smart EMS · same live tags as CCM + HMD Production</div>
          <h2>Plant command center</h2>
          <p class="muted">${shift.name || 'Shift'} · Mill ${String(sess.mode || '—').toUpperCase()} · HT ${fmt(en.kw ?? tags.ht_kw, 1)} kW · Unit ${fmt(d.unit_ton ?? tags.unit_ton, 4)} t/billet</p>
        </div>
        <div class="mes-badge">${d._floor ? 'FLOOR SYNC' : (d.connected ? 'LIVE MES' : 'PLC OFFLINE')}</div>
      </div>
      <div class="mega-grid">
        ${kpi('CCM today', fmt(ccmTons, 2) + ' t', `${ccmPcs} billets · S1/S2 ${s1}/${s2} · saved heats ${ccm.heats || 0}`, 'accent-teal')}
        ${kpi('RM finished', fmt(rmTons, 2) + ' t', `TMT ${tmt} · R3 ${r3} · Yield ${fmt(hmd.yield_pct ?? tags.yield_pct, 1)}% · Miss ${miss}`, 'accent-ok')}
        ${kpi('Plant efficiency', fmt(plant.plant_efficiency, 1) + '%', `Hot charge ${fmt(plant.hot_charge_efficiency, 0)}% · CCM→TMT loss ${plant.difference || 0} pcs`, 'accent-info')}
        ${kpi('Unit / ton', fmt(sec, 2), `Util ${fmt(sess.util_pct ?? tags.util_pct, 1)}% · On-load ${fmtTime(sess.on_load_sec)} · Idle ${fmtTime(sess.idle_sec)}`, 'accent-warn')}
      </div>
      <div class="sec"><h2>Billet flow · CCM → TMT (DB8)</h2></div>
      ${hmdFlow(hmd)}
      <div class="hero-grid" style="margin-top:14px;">
        <div class="card"><div class="card-hd"><h3>HT load · hourly</h3></div>
          <div class="card-bd"><div class="chart-box" style="height:220px;"><canvas id="mesChartHourly"></canvas></div></div></div>
        <div class="card">
          <div class="card-hd">
            <h3>Running vs idle (HMD setpoints)</h3>
            <span class="muted" style="font-size:10px;">stop ≤ ${sess.start_kw} · idle ${sess.start_kw}–${sess.onload_kw} · on-load &gt; ${sess.onload_kw} kW</span>
          </div>
          <div class="card-bd">
            <div class="chart-box" style="height:180px;"><canvas id="mesChartRunIdle"></canvas></div>
            <div class="report-sum" style="margin-top:10px;grid-template-columns:1fr 1fr 1fr;" id="mesRunIdleLegend"></div>
          </div>
        </div>
      </div>
      <div class="report-sum" style="margin-top:12px;">
        <div class="rs"><div class="l">On-load</div><div class="v">${fmtTime(sess.on_load_sec)}</div><div class="s">&gt; ${sess.onload_kw} kW · ${sess._label || 'session'}</div></div>
        <div class="rs"><div class="l">Idle run</div><div class="v">${fmtTime(sess.idle_sec)}</div><div class="s">${sess.start_kw}–${sess.onload_kw} kW · same as HMD</div></div>
        <div class="rs"><div class="l">Utilization</div><div class="v">${fmt(sess.util_pct, 1)}%</div><div class="s">Availability ${fmt(sess.availability_pct, 1)}%</div></div>
        <div class="rs"><div class="l">CCM→Finished loss</div><div class="v">${plant.difference || 0}</div><div class="s">pcs</div></div>
      </div>`;
  }

  function paintCcm(d) {
    const t = d.ccm?.today || {}, m = d.ccm?.month || {}, y = d.ccm?.year || {};
    const rows = d.ccm?.rows || [];
    const ut = d.unit_ton || 0;
    const shift = d.shift || {};
    const last = rows[0] || {};
    const openNo = d.ccm?.heat_open ? d.ccm.heat_no : null;
    const sess = floorSession(d.session || {});
    const hmd = d.hmd || {};
    return `
      <div class="mes-hero"><div><div class="mes-kicker">CCM dashboard · matches CCM MIS</div><h2>Continuous casting</h2>
        <p class="muted">Live S1 ${d.ccm?.live_s1 || 0} · S2 ${d.ccm?.live_s2 || 0} · Unit ${fmt(ut, 4)} t · Shift ${shift.name || shift.id || '—'}${openNo ? ' · Heat ' + openNo : ''}</p></div>
        <div class="mes-badge">${d.ccm?.heat_open ? 'HEAT OPEN' : (d.connected ? 'LIVE' : 'OFFLINE')}</div></div>
      <div class="report-sum" style="margin-bottom:12px;grid-template-columns:repeat(4,1fr);">
        <div class="rs"><div class="l">On-load time</div><div class="v">${fmtTime(sess.on_load_sec)}</div><div class="s">&gt; ${sess.onload_kw} kW · same as HMD</div></div>
        <div class="rs"><div class="l">Idle run</div><div class="v">${fmtTime(sess.idle_sec)}</div><div class="s">${sess.start_kw}–${sess.onload_kw} kW</div></div>
        <div class="rs"><div class="l">R3 / TMT</div><div class="v">${hmd.at_r3 || 0} / ${hmd.finished || 0}</div><div class="s">Miss ${hmd.miss_roll || 0}</div></div>
        <div class="rs"><div class="l">Util</div><div class="v">${fmt(sess.util_pct, 1)}%</div><div class="s">HT ${fmt(d.live_energy?.kw, 1)} kW</div></div>
      </div>
      <div class="mega-grid">
        ${kpi('Heat number', openNo || last.heatNo || '—', openNo ? 'Active CCM heat' : (last.endedAt ? ('Ended ' + String(last.endedAt).replace('T',' ').slice(0,16)) : 'Latest saved heat'), 'accent-info')}
        ${kpi('Live CCM tons', fmt(t.live_tons ?? t.tons, 3) + ' t', `S1 ${d.ccm?.live_s1 || 0} + S2 ${d.ccm?.live_s2 || 0} = ${(t.live_billets ?? t.billets) || 0} pcs · same as CCM Production`, 'accent-teal')}
        ${kpi('Saved today', fmt(t.saved_tons ?? 0, 3) + ' t', `${t.saved_billets ?? 0} billets · ${t.heats || 0} ended heats`, 'accent-info')}
        ${kpi('Month / Year', fmt(m.tons, 2) + ' / ' + fmt(y.tons, 2) + ' t', `${m.heats || 0} / ${y.heats || 0} heats`, 'accent-ok')}
      </div>
      <div class="mega-grid">
        ${kpi('Billets / heat', fmt(t.billets_per_heat, 1), `Avg ${fmt(t.avg_per_heat, 3)} t/heat (saved)`, 'accent-warn')}
        ${kpi('Billet weight', fmt(d.ccm_unit_ton ?? ut, 4) + ' t', 'CCM section · same as CCM Production', 'accent-info')}
        ${kpi('Live S1 / S2', `${d.ccm?.live_s1 || 0} / ${d.ccm?.live_s2 || 0}`, 'DB8 STAND*_COUNTS', 'accent-teal')}
        ${kpi('Shift context', shift.name || shift.id || '—', `${shift.start || ''}–${shift.end || ''}`, 'accent-ok')}
      </div>
      <div class="hero-grid">
        <div class="card"><div class="card-hd"><h3>Heat-wise production</h3></div>
          <div class="card-bd"><div class="chart-box" style="height:240px;"><canvas id="mesChartHeat"></canvas></div></div></div>
        <div class="card"><div class="card-hd"><h3>Recent heats</h3></div>
          <div class="card-bd" style="padding:0;"><div class="tbl-wrap" style="border:none;max-height:260px;">
            <table><thead><tr><th>Heat</th><th>Ended</th><th>S1</th><th>S2</th><th>Pcs</th><th>Tons</th></tr></thead>
            <tbody>${rows.length ? rows.slice(0, 15).map(r => `<tr>
              <td>${r.heatNo || '—'}</td><td>${(r.endedAt || '').replace('T', ' ').slice(0, 16)}</td>
              <td>${r.s1 ?? '—'}</td><td>${r.s2 ?? '—'}</td><td>${r.totalPcs ?? '—'}</td>
              <td>${fmt(r.tons, 3)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No CCM heats in SQLite yet — end a heat on CCM page</td></tr>'}
            </tbody></table></div></div></div>
      </div>`;
  }

  function paintRm(d) {
    const t = d.rm?.today || {}, m = d.rm?.month || {};
    const hmd = d.hmd || {}, sess = floorSession(d.session || {});
    const rows = d.rm?.rows || [];
    const tags = d.shared_tags || {};
    const liveT = t.good_tons_live ?? tags.good_tons ?? t.good_tons ?? 0;
    const entry = hmd.received ?? tags.entry ?? 0;
    const tmt = hmd.finished ?? tags.tmt ?? 0;
    const r3 = hmd.at_r3 ?? tags.r3 ?? 0;
    const miss = hmd.miss_roll ?? tags.miss ?? 0;
    return `
      <div class="mes-hero"><div><div class="mes-kicker">Rolling mill · same tags as HMD Production</div><h2>HMD production &amp; yield</h2>
        <p class="muted">Miss-roll = R3 − TMT · On-load kW &gt; ${sess.onload_kw} · same counters as HMD · Production</p></div>
        <div class="mes-badge">${d.rm?.heat_open ? 'HEAT ' + (d.rm.heat_no || '') : String(sess.mode || 'stop').toUpperCase()}</div></div>
      <div class="mega-grid">
        ${kpi('Received (Entry)', String(entry), 'same as HMD line', 'accent-info')}
        ${kpi('Finished (TMT)', String(tmt), `R3 ${r3}`, 'accent-ok')}
        ${kpi('Miss-roll', String(miss), `${fmt(hmd.miss_pct ?? tags.miss_pct, 1)}% · Yield ${fmt(hmd.yield_pct ?? tags.yield_pct, 1)}%`, miss ? 'accent-warn' : 'accent-ok')}
        ${kpi('Good tons', fmt(liveT, 3) + ' t', `Util ${fmt(sess.util_pct ?? tags.util_pct, 1)}% · SEC ${fmt(t.kwh_per_ton ?? tags.kwh_per_ton, 2)} · On-load ${fmtTime(sess.on_load_sec)}`, 'accent-teal')}
      </div>
      <div class="sec"><h2>Material flow animation</h2></div>
      ${hmdFlow(hmd)}
      ${(hmd.losses || []).length ? `<p class="prod-formula" style="margin-top:8px;">Loss segments: ${hmd.losses.map(L => `${L.from_label}→${L.to_label}: −${L.lost}`).join(' · ')}</p>` : ''}
      <div class="hero-grid" style="margin-top:12px;">
        <div class="card"><div class="card-hd"><h3>Yield vs miss-roll (today)</h3></div>
          <div class="card-bd"><div class="chart-box" style="height:220px;"><canvas id="mesChartYield"></canvas></div></div></div>
        <div class="card"><div class="card-hd"><h3>RM heats today</h3></div>
          <div class="card-bd" style="padding:0;"><div class="tbl-wrap" style="border:none;max-height:240px;">
            <table><thead><tr><th>Heat</th><th>R3</th><th>TMT</th><th>Miss</th><th>t</th><th>Util%</th><th>kWh/t</th></tr></thead>
            <tbody>${rows.length ? rows.slice(0, 12).map(r => `<tr>
              <td>${r.heatNo}</td><td>${r.r3}</td><td>${r.tmt}</td><td>${r.missPcs}</td>
              <td>${fmt(r.goodTon, 3)}</td><td>${fmt(r.utilPct, 1)}</td><td>${fmt(r.kwhPerTon, 2)}</td>
            </tr>`).join('') : '<tr><td colspan="7" class="empty">No RM heats saved yet</td></tr>'}
            </tbody></table></div></div></div>
      </div>
      <div class="report-sum">
        ${kpi('Month tons', fmt(m.good_tons, 2) + ' t', `${m.heats || 0} heats`, 'accent-info')}
        ${kpi('On-load time', fmtTime(sess.on_load_sec), sess._label || 'HMD Production', 'accent-ok')}
        ${kpi('Idle time', fmtTime(sess.idle_sec), sess._label || 'HMD Production', 'accent-warn')}
        ${kpi('Availability', fmt(sess.availability_pct, 1) + '%', 'run ÷ (run+stop)', 'accent-info')}
      </div>`;
  }

  function paintEnergy(d) {
    const e = d.energy || {}, live = d.live_energy || {}, sess = floorSession(d.session || {});
    const tags = d.shared_tags || {};
    const prodKwh = sess.on_load_kwh ?? tags.on_load_kwh ?? e.productive_kwh ?? live.productive_kwh ?? 0;
    const idleKwh = sess.idle_kwh ?? tags.idle_kwh ?? e.idle_kwh ?? live.idle_kwh ?? 0;
    const sec = tags.kwh_per_ton ?? live.kwh_per_ton ?? e.kwh_per_ton ?? 0;
    return `
      <div class="mes-hero"><div><div class="mes-kicker">Energy · same HT / on-load / idle as HMD Production</div><h2>Energy &amp; demand</h2>
        <p class="muted">HT ${fmt(live.kw ?? tags.ht_kw, 1)} kW · ${tags.mill_label || sess.mode || '—'} · thresholds ${sess.start_kw}/${sess.onload_kw} kW</p></div>
        <div class="mes-badge">${fmt(live.kw ?? tags.ht_kw, 1)} kW</div></div>
      <div class="mega-grid">
        ${kpi('Active power', fmt(live.kw ?? tags.ht_kw, 1) + ' kW', `kVA ${fmt(live.kva, 1)} · PF ${fmt(live.pf, 2)} · same HT tag`, 'accent-info')}
        ${kpi('Session kWh', fmt(sess.total_kwh ?? tags.total_kwh, 2), `Meter ${fmt(live.kwh ?? tags.kwh_meter, 1)} · same as HMD`, 'accent-ok')}
        ${kpi('kWh / ton', fmt(sec, 2), `Good tons ${fmt(tags.good_tons, 3)} t · TMT ${tags.tmt || 0}`, 'accent-warn')}
        ${kpi('Util / On-load', fmt(sess.util_pct ?? tags.util_pct, 1) + '%', `${fmtTime(sess.on_load_sec)} on · ${fmtTime(sess.idle_sec)} idle`, 'accent-teal')}
      </div>
      <div class="mega-grid">
        ${kpi('Productive kWh', fmt(prodKwh, 2), 'On-load band · same as HMD', 'accent-ok')}
        ${kpi('Idle kWh', fmt(idleKwh, 2), `Loss ${fmt(e.loss_pct, 1)}%`, 'accent-warn')}
        ${kpi('Voltage', fmt(live.volt, 1) + ' V', `I ${fmt(live.amp, 1)} A · ${fmt(live.freq, 2)} Hz`, 'accent-info')}
        ${kpi('Today log kWh', fmt(e.kwh, 1), `Cost ₹${fmt(e.cost, 0)} · max ${fmt(e.max_demand_kw, 1)} kW`, 'accent-info')}
      </div>
      <div class="card"><div class="card-hd"><h3>Power trend (hourly avg)</h3>
        <div class="ctrl-row" style="margin:0;padding:0;border:none;background:transparent;">
          <div class="field"><label>Mill start kW &gt;</label><input type="number" id="mesThrStart" value="${d.thresholds?.start_kw || 50}" style="min-width:80px;"></div>
          <div class="field"><label>On-load kW &gt;</label><input type="number" id="mesThrOn" value="${d.thresholds?.onload_kw || 1600}" style="min-width:80px;"></div>
          <button class="btn btn-pri" type="button" id="mesThrSave">Save thresholds</button>
          <button class="btn" type="button" id="mesSessReset">Reset session timers</button>
        </div></div>
        <div class="card-bd"><div class="chart-box" style="height:260px;"><canvas id="mesChartEnergy"></canvas></div></div>
      </div>`;
  }

  function paintAi(d) {
    const ai = d.ai || [];
    const tags = d.shared_tags || {};
    const sess = floorSession(d.session || {});
    return `
      <div class="mes-hero"><div><div class="mes-kicker">AI analytics · live floor context</div><h2>Advisories &amp; predictions</h2>
        <p class="muted">Inputs match CCM / HMD Production tags</p></div></div>
      <div class="report-sum" style="margin-bottom:12px;grid-template-columns:repeat(4,1fr);">
        <div class="rs"><div class="l">CCM S1/S2</div><div class="v" style="font-size:18px;">${tags.ccm_s1 ?? 0}/${tags.ccm_s2 ?? 0}</div><div class="s">${fmt(tags.ccm_tons, 3)} t live</div></div>
        <div class="rs"><div class="l">R3 → TMT</div><div class="v">${tags.r3 ?? 0} / ${tags.tmt ?? 0}</div><div class="s">Miss ${tags.miss ?? 0} · Yield ${fmt(tags.yield_pct, 1)}%</div></div>
        <div class="rs"><div class="l">On-load / Idle</div><div class="v" style="font-size:16px;">${fmtTime(sess.on_load_sec)} / ${fmtTime(sess.idle_sec)}</div><div class="s">Util ${fmt(sess.util_pct, 1)}%</div></div>
        <div class="rs"><div class="l">HT / SEC</div><div class="v">${fmt(tags.ht_kw, 1)}</div><div class="s">kW · ${fmt(tags.kwh_per_ton, 2)} kWh/t</div></div>
      </div>
      <div class="mes-ai">${(ai.length ? ai : [{ kind: 'live', score: 1, title: 'Floor tags synced', detail: 'Using CCM + HMD Production live counters', action: 'Watch miss-roll and util vs setpoints' }]).map(a => `
        <div class="mes-ai-card">
          <div class="m-lbl">${a.kind} · score ${fmt(a.score, 2)}</div>
          <div class="m-val" style="font-size:16px">${a.title}</div>
          <div class="m-sub">${a.detail || ''}</div>
          <div class="prod-formula">${a.action || ''}</div>
        </div>`).join('')}</div>
      <div class="sec"><h2>What the engine watches</h2></div>
      <p class="prod-formula">Miss-roll risk · HMD bottleneck · Energy z-score anomaly · Low PF · Low utilization · Stuck/delay/sensor alarms · Shift comparison via reports</p>`;
  }

  function paintReports(d) {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ds = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const tags = d.shared_tags || {};
    const sess = floorSession(d.session || {});
    return `
      <div class="mes-hero"><div><div class="mes-kicker">Reports · live preview matches floor</div><h2>Shift · Day · Week · Month · Year</h2>
        <p class="muted">Export CSV / Excel · Print from browser for PDF</p></div></div>
      <div class="report-sum" style="margin-bottom:12px;grid-template-columns:repeat(4,1fr);">
        <div class="rs"><div class="l">Live CCM</div><div class="v">${fmt(tags.ccm_tons, 3)} t</div><div class="s">S1/S2 ${tags.ccm_s1 ?? 0}/${tags.ccm_s2 ?? 0}</div></div>
        <div class="rs"><div class="l">Live good tons</div><div class="v">${fmt(tags.good_tons, 3)} t</div><div class="s">TMT ${tags.tmt ?? 0} · Miss ${tags.miss ?? 0}</div></div>
        <div class="rs"><div class="l">On-load</div><div class="v">${fmtTime(sess.on_load_sec)}</div><div class="s">Idle ${fmtTime(sess.idle_sec)}</div></div>
        <div class="rs"><div class="l">Session kWh</div><div class="v">${fmt(sess.total_kwh ?? tags.total_kwh, 1)}</div><div class="s">${fmt(tags.kwh_per_ton, 2)} kWh/t</div></div>
      </div>
      <div class="ctrl-row">
        <div class="field"><label>Date</label><input type="date" id="mesRptDate" value="${ds}"></div>
        <div class="field"><label>Kind</label>
          <select id="mesRptKind"><option value="day">Daily</option><option value="week">Weekly</option>
          <option value="month">Monthly</option><option value="year">Yearly</option>
          <option value="shift">Shift</option></select>
        </div>
        <div class="field"><label>Shift</label>
          <select id="mesRptShift"><option value="A">A</option><option value="B">B</option><option value="C">C</option></select>
        </div>
        <button class="btn btn-pri" type="button" id="mesRptGen">Generate</button>
        <button class="btn" type="button" id="mesRptCsv">CSV</button>
        <button class="btn" type="button" id="mesRptXlsx">Excel</button>
        <button class="btn btn-dark" type="button" id="mesRptPrint">Print / PDF</button>
      </div>
      <pre class="mes-report" id="mesRptOut">Select options and Generate.</pre>`;
  }

  function paintAlarms(d) {
    const rows = d.alarms || [];
    const tags = d.shared_tags || {};
    const liveMiss = Number(tags.miss || 0);
    return `
      <div class="mes-hero"><div><div class="mes-kicker">Alarm center · live HMD miss</div><h2>Process &amp; HMD alarms</h2>
        <p class="muted">Miss-roll · Delay · Stuck · Sensor · Loss segment · live miss ${liveMiss} (R3 ${tags.r3 ?? 0} − TMT ${tags.tmt ?? 0})</p></div>
        <div class="mes-badge">${rows.filter(r => !r.acked).length} open</div></div>
      <div class="report-sum" style="margin-bottom:12px;grid-template-columns:repeat(3,1fr);">
        <div class="rs"><div class="l">Live miss-roll</div><div class="v">${liveMiss}</div><div class="s">same as HMD Production</div></div>
        <div class="rs"><div class="l">Yield</div><div class="v">${fmt(tags.yield_pct, 1)}%</div><div class="s">TMT ÷ R3</div></div>
        <div class="rs"><div class="l">Mill mode</div><div class="v" style="font-size:16px;">${String(tags.mill_label || tags.mill_mode || '—').toUpperCase()}</div><div class="s">HT ${fmt(tags.ht_kw, 1)} kW</div></div>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Sev</th><th>Time</th><th>Code</th><th>Area</th><th>Message</th><th>Ack</th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `<tr>
          <td><span class="sev sev-${r.severity === 'alarm' ? 'alarm' : r.severity === 'caution' ? 'caution' : 'info'}">${r.severity || '—'}</span></td>
          <td>${(r.ts || '').replace('T', ' ').slice(0, 19)}</td>
          <td>${r.code || '—'}</td><td>${r.area || '—'}</td>
          <td>${r.message || ''}</td>
          <td>${r.acked ? 'ACK' : `<button class="btn" type="button" data-ack="${r.id}">Ack</button>`}</td>
        </tr>`).join('') : '<tr><td colspan="6" class="empty">No MES alarms stored</td></tr>'}
        </tbody></table></div>`;
  }

  function bindTabActions() {
    document.getElementById('mesThrSave')?.addEventListener('click', async () => {
      const start_kw = Number(document.getElementById('mesThrStart').value);
      const onload_kw = Number(document.getElementById('mesThrOn').value);
      await mesFetch('/api/mes/thresholds', { method: 'POST', body: JSON.stringify({ start_kw, onload_kw }) });
      // sync RM MIS inputs if present
      const a = document.getElementById('rmStartKw'), b = document.getElementById('rmOnLoadKw');
      if (a) a.value = start_kw; if (b) b.value = onload_kw;
      refreshMes();
    });
    document.getElementById('mesSessReset')?.addEventListener('click', async () => {
      await mesFetch('/api/mes/session/reset', { method: 'POST', body: '{}' });
      refreshMes();
    });
    document.querySelectorAll('[data-ack]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await mesFetch(`/api/mes/alarms/${btn.getAttribute('data-ack')}/ack`, { method: 'POST', body: '{}' });
        refreshMes();
      });
    });
    const gen = async (fmt) => {
      const date = document.getElementById('mesRptDate')?.value;
      const kind = document.getElementById('mesRptKind')?.value || 'day';
      const shift = document.getElementById('mesRptShift')?.value || 'A';
      if (kind === 'shift') {
        if (fmt === 'csv') {
          window.open(mesUrl(`/api/mes/report/shift?date=${date}&shift=${shift}&format=csv`), '_blank');
          return;
        }
        const { j } = await mesFetch(`/api/mes/report/shift?date=${date}&shift=${shift}`);
        document.getElementById('mesRptOut').textContent = JSON.stringify(j.report || j, null, 2);
        return;
      }
      if (fmt === 'csv' || fmt === 'xlsx') {
        window.open(mesUrl(`/api/mes/report/period?kind=${kind}&date=${date}&format=${fmt}`), '_blank');
        return;
      }
      const { j } = await mesFetch(`/api/mes/report/period?kind=${kind}&date=${date}`);
      document.getElementById('mesRptOut').textContent = JSON.stringify(j.report || j, null, 2);
    };
    document.getElementById('mesRptGen')?.addEventListener('click', () => gen('json'));
    document.getElementById('mesRptCsv')?.addEventListener('click', () => gen('csv'));
    document.getElementById('mesRptXlsx')?.addEventListener('click', () => gen('xlsx'));
    document.getElementById('mesRptPrint')?.addEventListener('click', () => window.print());
  }

  function paintCharts(d) {
    const hourly = d.charts?.hourly_kw || [];
    /* Same HMD Production timers + Mill start / On-load setpoints */
    const floor = floorSession(d.session || {});
    const onSec = Number(floor.on_load_sec ?? d.charts?.run_idle?.on_load ?? 0) || 0;
    const idleSec = Number(floor.idle_sec ?? d.charts?.run_idle?.idle ?? 0) || 0;
    const stopSec = Number(floor.stop_sec ?? d.charts?.run_idle?.stop ?? 0) || 0;
    const totalSec = onSec + idleSec + stopSec;
    const pct = (sec) => totalSec > 0 ? (sec / totalSec) * 100 : 0;
    const onPct = pct(onSec), idlePct = pct(idleSec), stopPct = pct(stopSec);
    const startKw = floor.start_kw ?? d.thresholds?.start_kw ?? 500;
    const onKw = floor.onload_kw ?? d.thresholds?.onload_kw ?? 1600;
    const heats = d.charts?.heat_tons || [];
    const my = d.charts?.miss_vs_yield || {};

    const legend = document.getElementById('mesRunIdleLegend');
    if (legend) {
      legend.innerHTML = `
        <div class="rs" style="box-shadow:inset 3px 0 0 #1f6b3a,var(--shadow);">
          <div class="l">On-load</div>
          <div class="v">${fmt(onPct, 1)}%</div>
          <div class="s">${fmtTime(onSec)} · kW &gt; ${onKw}</div>
        </div>
        <div class="rs" style="box-shadow:inset 3px 0 0 #a85705,var(--shadow);">
          <div class="l">Idle run</div>
          <div class="v">${fmt(idlePct, 1)}%</div>
          <div class="s">${fmtTime(idleSec)} · ${startKw}–${onKw} kW</div>
        </div>
        <div class="rs" style="box-shadow:inset 3px 0 0 #6b7382,var(--shadow);">
          <div class="l">Stopped</div>
          <div class="v">${fmt(stopPct, 1)}%</div>
          <div class="s">${fmtTime(stopSec)} · kW ≤ ${startKw}</div>
        </div>`;
    }

    if (document.getElementById('mesChartHourly') || document.getElementById('mesChartEnergy')) {
      const id = document.getElementById('mesChartEnergy') ? 'mesChartEnergy' : 'mesChartHourly';
      chart(id, {
        type: 'line',
        data: {
          labels: hourly.map(p => p.hour),
          datasets: [{ label: 'Avg kW', data: hourly.map(p => p.avg_kw), borderColor: '#1a4f7c', tension: 0.25, fill: false }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true } } },
      });
    }
    if (document.getElementById('mesChartRunIdle')) {
      const vals = [onSec, idleSec, stopSec];
      const labels = [
        `On-load ${fmt(onPct, 1)}%`,
        `Idle ${fmt(idlePct, 1)}%`,
        `Stopped ${fmt(stopPct, 1)}%`,
      ];
      chart('mesChartRunIdle', {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            data: totalSec > 0 ? vals : [0, 0, 1],
            backgroundColor: ['#22c55e', '#f59e0b', '#64748b'],
            borderWidth: 2,
            borderColor: '#1a2029',
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '58%',
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: {
                boxWidth: 10,
                font: { family: 'IBM Plex Mono', size: 10 },
                generateLabels(chartInst) {
                  const ds = chartInst.data.datasets[0];
                  return chartInst.data.labels.map((label, i) => ({
                    text: `${label} · ${fmtTime(vals[i])}`,
                    fillStyle: ds.backgroundColor[i],
                    strokeStyle: ds.borderColor,
                    lineWidth: 1,
                    hidden: false,
                    index: i,
                  }));
                },
              },
            },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const i = ctx.dataIndex;
                  const names = ['On-load', 'Idle run', 'Stopped'];
                  const bands = [`kW > ${onKw}`, `${startKw} < kW ≤ ${onKw}`, `kW ≤ ${startKw}`];
                  const p = [onPct, idlePct, stopPct][i];
                  return `${names[i]}: ${fmt(p, 1)}% · ${fmtTime(vals[i])} (${bands[i]})`;
                },
              },
            },
          },
        },
      });
    }
    if (document.getElementById('mesChartHeat')) {
      chart('mesChartHeat', {
        type: 'bar',
        data: {
          labels: heats.map(h => h.heat || ''),
          datasets: [{ label: 'Tons', data: heats.map(h => h.tons), backgroundColor: '#0d6e66' }],
        },
        options: { responsive: true, maintainAspectRatio: false },
      });
    }
    if (document.getElementById('mesChartYield')) {
      chart('mesChartYield', {
        type: 'bar',
        data: {
          labels: ['Yield %', 'Miss %'],
          datasets: [{ data: [my.yield_pct || 0, my.miss_pct || 0], backgroundColor: ['#1f6b3a', '#b91c1c'] }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, max: 100 } } },
      });
    }
  }

  function paint() {
    const body = document.getElementById('mesTabBody');
    if (!body || !MES.data) return;
    destroyCharts();
    const d = withFloorData(MES.data);
    const map = { plant: paintPlant, ccm: paintCcm, rm: paintRm, energy: paintEnergy, ai: paintAi, reports: paintReports, alarms: paintAlarms };
    body.innerHTML = (map[MES.tab] || paintPlant)(d);
    bindTabActions();
    requestAnimationFrame(() => paintCharts(d));
    if (typeof window.renderSharedLiveStrips === 'function') window.renderSharedLiveStrips();
  }

  async function refreshMes() {
    const root = document.getElementById('mesOverviewRoot');
    try {
      const { res, j } = await mesFetch('/api/mes/dashboard');
      if (res.ok && j.ok) {
        MES.data = j;
        if (!document.getElementById('mesTabs')) renderShell();
        paint();
        return;
      }
      // fallback overview
      const o = await mesFetch('/api/mes/overview');
      if (o.res.ok && o.j.ok) {
        MES.data = {
          ...o.j,
          ccm: { today: o.j.ccm_today, month: o.j.ccm_today, year: o.j.ccm_today, rows: [], live_s1: o.j.hmd?.ccm_s1, live_s2: o.j.hmd?.ccm_s2 },
          rm: { today: o.j.rm_today, month: o.j.rm_today, year: o.j.rm_today, rows: [], live: o.j.hmd },
          energy: o.j.live_energy || {},
          session: o.j.session || o.j.mill_band || {},
          charts: { hourly_kw: [], heat_tons: [], miss_vs_yield: {}, run_idle: {} },
        };
        if (!document.getElementById('mesTabs')) renderShell();
        paint();
        return;
      }
      if (root) root.innerHTML = `<div class="empty">MES error: ${(j && j.error) || res.status}<br><span class="muted">python bridge_server.py → http://localhost:5000/</span></div>`;
    } catch (e) {
      if (root) root.innerHTML = `<div class="empty">MES API offline — start <b>bridge_server.py</b><br>
        <span class="muted">cd plc-live-monitor → python bridge_server.py</span></div>`;
    }
  }

  async function tryLogin() {
    const u = document.getElementById('mesUser')?.value;
    const p = document.getElementById('mesPass')?.value;
    if (!u) return;
    const { j } = await mesFetch('/api/mes/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
    if (j.ok) {
      MES.token = j.token;
      localStorage.setItem('mes_token', j.token);
      document.getElementById('mesAuthStatus').textContent = `${j.full_name} · ${j.role}`;
      refreshMes();
    } else alert(j.error || 'Login failed');
  }

  window.initMesDashboard = function initMesDashboard() {
    applyTheme(MES.theme);
    document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
      applyTheme(MES.theme === 'dark' ? 'light' : 'dark');
      paint();
    });
    document.getElementById('mesLoginBtn')?.addEventListener('click', tryLogin);
    document.getElementById('mesLogoutBtn')?.addEventListener('click', async () => {
      await mesFetch('/api/mes/logout', { method: 'POST', body: '{}' });
      MES.token = '';
      localStorage.removeItem('mes_token');
      document.getElementById('mesAuthStatus').textContent = 'Guest';
    });
    renderShell();
    refreshMes();
    setInterval(refreshMes, 4000);
  };
  window.refreshMesDashboard = refreshMes;
  let _mesFloorPaintAt = 0;
  /** Repaint Smart EMS from live CCM/RM MIS (throttled) */
  window.repaintMesFromFloor = function repaintMesFromFloor() {
    if (!MES.data) return;
    if (!document.getElementById('view-mes')?.classList.contains('active')) return;
    if (!['plant', 'ccm', 'rm', 'energy'].includes(MES.tab)) return;
    const now = performance.now();
    if (now - _mesFloorPaintAt < 1000) return;
    _mesFloorPaintAt = now;
    paint();
  };

  try { window.initMesDashboard(); } catch (e) { console.error('MES init', e); }
})();
