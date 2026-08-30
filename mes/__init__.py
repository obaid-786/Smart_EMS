"""
Smart Steel Plant MES — modular Manufacturing Execution System.

Layers:
  plc/          Snap7 S7-1200 readers (DB4 energy, DB8 HMD)
  database/     SQLite persistence for heats, energy, alarms, shifts
  production/   CCM + Rolling Mill KPIs, HMD loss detection
  energy/       SEC, idle/productive energy, demand
  ai/           Rule-based anomaly & miss-roll risk analytics
  reports/      Shift/day/month export helpers
  auth/         Role-based login (Admin / Production / Maintenance / Management)
  api/          Flask blueprints mounted by bridge_server / mes_server
"""

__version__ = "1.0.0"
