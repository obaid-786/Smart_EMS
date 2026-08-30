"""MES configuration — environment-aware industrial defaults."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
# Default plant data folder — changeable at runtime via /api/log-config
_DEFAULT_DATA = os.environ.get("MES_DATA_DIR", r"D:\Smart EMS and MIS Project\Plant_Data")
DATA_DIR = Path(_DEFAULT_DATA)
DB_PATH = Path(os.environ.get("MES_DB_PATH", DATA_DIR / "plant_mes.sqlite3"))
CSV_LOG = DATA_DIR / "pac3200_log.csv"


def set_data_dir(folder) -> Path:
    """Point all plant persistence (CSV, heats JSONL, SQLite) at one folder."""
    global DATA_DIR, DB_PATH, CSV_LOG
    DATA_DIR = Path(folder)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH = DATA_DIR / "plant_mes.sqlite3"
    CSV_LOG = DATA_DIR / "pac3200_log.csv"
    return DATA_DIR


def get_data_dir() -> Path:
    return DATA_DIR


def get_db_path() -> Path:
    return DB_PATH

PLC_IP = os.environ.get("PLC_IP", "192.168.0.1")
PLC_RACK = int(os.environ.get("PLC_RACK", "0"))
PLC_SLOT = int(os.environ.get("PLC_SLOT", "1"))

# HT kW bands (bar-size dependent — overridable via API / UI)
DEFAULT_MILL_START_KW = float(os.environ.get("MILL_START_KW", "500"))
DEFAULT_ON_LOAD_KW = float(os.environ.get("ON_LOAD_KW", "1600"))

# Energy cost INR/kWh (site tariff — customize)
ENERGY_COST_PER_KWH = float(os.environ.get("ENERGY_COST_PER_KWH", "8.5"))

# Billet defaults (mm, t/m³)
BILLET_W_MM = 110
BILLET_H_MM = 110
BILLET_L_MM = 6000  # typical; plant uses 5600–9000 mm per heat
STEEL_DENSITY = 7.85

# Shift windows (local plant time, 24h)
SHIFTS = (
    {"id": "A", "name": "Shift A", "start": "06:00", "end": "14:00"},
    {"id": "B", "name": "Shift B", "start": "14:00", "end": "22:00"},
    {"id": "C", "name": "Shift C", "start": "22:00", "end": "06:00"},
)

# HMD cascade (DB8) — order for miss-roll localization
HMD_LINE = (
    {"id": "ccm_s1", "label": "CCM Strand 1", "count": "CCM_STAND1_COUNTS", "hmd": "CCM_STAND1_HMD", "area": "ccm"},
    {"id": "ccm_s2", "label": "CCM Strand 2", "count": "CCM_STAND2_COUNTS", "hmd": "CCM_STAND2_HMD", "area": "ccm"},
    {"id": "entry", "label": "RM Entry", "count": "CCM_RM_ENTRY_COUNTS", "hmd": "CCM_RM_ENTRY_HMD", "area": "rm"},
    {"id": "r3", "label": "R3 Stand", "count": "R3_COUNTS", "hmd": "R3_HMD", "area": "rm"},
    {"id": "ccs1", "label": "CCS1 / PCS1", "count": "CCS1_COUNTS", "hmd": "CCS1_HMD", "area": "rm"},
    {"id": "ccs2", "label": "CCS2", "count": "CCS2_COUNTS", "hmd": "CCS2_HMD", "area": "rm"},
    {"id": "dshear", "label": "Drum / DD Shear", "count": "DSHEAR_COUNTS", "hmd": "DSHEAR_HMD", "area": "rm"},
    {"id": "blk_in", "label": "Block Entry", "count": "BLOCK_ENTRY_COUNTS", "hmd": "BLOCK_ENTRY_HMD", "area": "rm"},
    {"id": "blk_out", "label": "Block Exit", "count": "BLOCK_EXIT_COUNTS", "hmd": "BLOCK_EXIT_HMD", "area": "rm"},
    {"id": "tmt", "label": "TMT Finished", "count": "TMT_COUNTS", "hmd": "TMT_HMD", "area": "rm"},
)

ACTIVE_POWER_DIV = 1.0  # PLC power tags already in kW / kVA / kVAR
