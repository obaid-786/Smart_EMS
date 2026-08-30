# Smart Steel Plant MES

Industrial Manufacturing Execution System for **CCM + Rolling Mill + Energy**, built on the existing Snap7 / Flask / HTML stack.

## Run

```powershell
cd C:\Users\amzad\Projects\plc-live-monitor
pip install -r requirements.txt
python bridge_server.py
```

Open **http://localhost:5000/** → sidebar **Plant MES**

Default users: `admin/admin123` · `prod/prod123` · `maint/maint123` · `mgmt/mgmt123`

## Architecture

```
mes/
  plc/           # Snap7 wrapper (pac3200_reader)
  database/      # SQLite plant_mes.sqlite3
  production/    # HMD tracker + KPIs
  energy/        # SEC + HT band integrator
  ai/            # Rule / statistical advisories
  reports/       # CSV / Excel export
  auth/          # Role login
  api/           # /api/mes/*
```

PLC: **DB4** PAC3200 energy · **DB8** BILLETS_COUNTS HMD (Optimized Access OFF).

## Plant MES tabs

| Tab | Contents |
|-----|----------|
| Plant | Overall KPIs, HMD flow, hourly kW, run/idle |
| CCM | Day/month/year tons, heat chart, heat table |
| Rolling Mill | Live HMD cascade, miss-roll, yield, util |
| Energy | kW/kVA/PF, kWh/t, idle vs productive, thresholds |
| AI | Miss-roll / bottleneck / energy / PF advisories |
| Reports | Shift / day / week / month / year → JSON/CSV/Excel/Print |
| Alarms | Process HMD alarms + acknowledge |

## Key APIs

- `GET /api/mes/dashboard` — full UI payload  
- `GET /api/mes/overview` — compact overview  
- `GET /api/mes/report/shift|period` — reports (`format=csv|xlsx`)  
- `POST /api/mes/heats/ccm|rm` — persist heats  
- `POST /api/mes/thresholds` — mill start / on-load kW bands  

## HT load bands (no START buttons)

- `kW ≤ start` → STOPPED  
- `start < kW ≤ on-load` → IDLE RUN  
- `kW > on-load` → ON LOAD  

Customize per bar size on Energy tab or RM MIS page.

## Notes

- End CCM / RM heats from their pages so SQLite fills Plant MES charts.  
- Dual-write: heats go to JSONL + `/api/mes/heats/*`.  
- AI is online heuristic advisory — retrain offline for site accuracy.  
