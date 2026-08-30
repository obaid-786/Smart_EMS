# Smart Steel Plant MES — PLC Live Monitor

Industrial MES / EMS for CCM + Rolling Mill on Siemens S7-1200 (Snap7).

## Architecture

```
mes/
  api/           Flask /api/mes/* blueprint
  auth/          Role-based login (admin/prod/maint/mgmt)
  database/      SQLite (heats, energy, HMD, alarms, AI)
  production/    HMD tracker + KPIs + plant balance
  energy/        SEC, demand, cost
  ai/            Miss-roll / energy / bottleneck advisories
  reports/       Shift CSV / Excel helpers
plc_live_monitor.html   WinCC-style HMI + MES view
plant_mis.js            CCM / RM heat MIS (existing)
mes_dashboard.js        MES command center UI
bridge_server.py        Live poll + MES mount
pac3200_reader.py       DB4 energy + DB8 HMD
```

## Run

```powershell
cd C:\Users\amzad\Projects\plc-live-monitor
pip install -r requirements.txt
# Set PLC_IP in pac3200_reader.py (and disable Optimized access on DB4 + DB8)
python bridge_server.py
```

Open http://localhost:5000/

## Default MES users

| User  | Password  | Role         |
|-------|-----------|--------------|
| admin | admin123  | admin        |
| prod  | prod123   | production   |
| maint | maint123  | maintenance  |
| mgmt  | mgmt123   | management   |

## Plant MES UI

Open **Plant MES** in the sidebar for tabs: Plant · CCM · Rolling Mill · Energy · AI · Reports · Alarms.

See [MES_README.md](MES_README.md) for full module map.

## Key APIs

- `GET /api/live` — PLC tags
- `GET /api/mes/health`
- `GET /api/mes/dashboard` — full UI payload (CCM/RM/energy/charts/AI)
- `GET /api/mes/overview` — compact overview
- `GET /api/mes/hmd` — cascade + miss segments
- `GET /api/mes/ai/insights`
- `GET /api/mes/report/shift?date=YYYY-MM-DD&shift=A&format=csv`
- `GET /api/mes/report/period?kind=day|week|month|year&format=csv|xlsx`
- `POST /api/mes/heats/ccm|rm` — persist heats (floor HMI, no login required)
- `POST /api/mes/login` `{username,password}`

## Notes

- HT mill state uses dual kW thresholds (start / on-load) — no START buttons.
- Heats dual-write to JSONL + SQLite MES.
- PDF reports: use Print / PDF in Reports tab (browser print).
- AI layer is rule/statistical advisory — retrain with site history for production ML.
