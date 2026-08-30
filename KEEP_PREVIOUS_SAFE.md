# Previous code is safe

## Frozen copy
`SAFE_PREVIOUS_CODE_20260802_112614/` (and any newer `SAFE_PREVIOUS_CODE_*`)

Contains the previous working classic HMI + bridge + `mes/` at freeze time.

## Two products, one bridge

| Product | URL | Files |
|---------|-----|--------|
| **Classic (previous)** | http://localhost:5000/ | `plc_live_monitor.html`, `plant_mis.js`, `mes_dashboard.js` |
| **Steel EMS Pro (new)** | http://localhost:5000/pro/ | `steel_ems_pro/` |

Classic files were **not replaced**. Pro is additive.

## Restore classic if needed
Copy files from `SAFE_PREVIOUS_CODE_*` back over the project root (and `mes/`), then restart `bridge_server.py`.

## Restart required
Restart `python bridge_server.py` once so `/pro/` routes load.
