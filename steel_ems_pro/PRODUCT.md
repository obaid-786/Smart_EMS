# Steel EMS Pro — Product Edition

Market-facing plant EMS/MIS product built **beside** the classic HMI.

| Edition | URL | Code location |
|---------|-----|----------------|
| **Classic (previous)** | http://localhost:5000/ | `plc_live_monitor.html`, `plant_mis.js`, `mes_dashboard.js` |
| **Steel EMS Pro (new)** | http://localhost:5000/pro/ | `steel_ems_pro/` |
| **Safe freeze** | — | `SAFE_PREVIOUS_CODE_*` |

## Product promise
Cast → Roll → Finish **production + energy**, heat-wise, with one live truth and frozen saved heats.

## Design principles
1. Role-first navigation (Operator / Supervisor / Engineer)
2. First viewport = decision KPIs only
3. Same tag numbers on every screen
4. Guided heat timeline (Ready → Casting → Gap)
5. Classic HMI always one click away (no lock-in during migration)

## What stays unchanged
- PLC poll / Snap7 reader
- Bridge APIs (`/api/live`, `/api/mes/*`, production heats)
- Plant_Data logging
- Classic dashboard at `/`

## Roadmap (Pro)
- Phase A: Product shell + live KPI home (this folder)
- Phase B: CCM / HMD operator workspaces wired to floor MIS
- Phase C: Installer, plant recipe config, branded PDF MIS
