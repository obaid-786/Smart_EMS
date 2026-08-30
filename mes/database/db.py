"""SQLite persistence for Smart Steel Plant MES."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from mes import config as mes_config

_lock = threading.Lock()
_initialized = False

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','production','maintenance','management')),
  full_name TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kwh REAL, kvah REAL, kvarh REAL,
  kw REAL, kva REAL, kvar REAL,
  pf REAL, freq REAL, volt REAL, amp REAL,
  UNIQUE(ts)
);
CREATE INDEX IF NOT EXISTS idx_energy_ts ON energy_samples(ts);

CREATE TABLE IF NOT EXISTS hmd_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  bits_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hmd_ts ON hmd_samples(ts);

CREATE TABLE IF NOT EXISTS ccm_heats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  heat_no TEXT NOT NULL,
  started_at TEXT, ended_at TEXT,
  s1 INTEGER, s2 INTEGER, total_pcs INTEGER,
  tons REAL, unit_ton REAL,
  billet_w REAL, billet_h REAL, billet_l REAL, density REAL,
  shift_id TEXT, operator TEXT,
  casting_speed REAL, run_sec REAL, down_sec REAL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ccm_ended ON ccm_heats(ended_at);

CREATE TABLE IF NOT EXISTS rm_heats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  heat_no TEXT NOT NULL,
  started_at TEXT, ended_at TEXT,
  r3 INTEGER, tmt INTEGER, miss_pcs INTEGER,
  good_ton REAL, miss_ton REAL, yield_pct REAL,
  on_load_sec REAL, idle_sec REAL, stop_sec REAL, util_pct REAL,
  total_kwh REAL, idle_kwh REAL, kwh_per_ton REAL,
  shift_id TEXT, operator TEXT, product_size TEXT,
  hmd_json TEXT, stage_loss_json TEXT, payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rm_ended ON rm_heats(ended_at);

CREATE TABLE IF NOT EXISTS alarms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  severity TEXT NOT NULL,
  area TEXT,
  code TEXT,
  message TEXT NOT NULL,
  value TEXT, limit_val TEXT,
  acked INTEGER DEFAULT 0,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_alarms_ts ON alarms(ts);

CREATE TABLE IF NOT EXISTS ai_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  score REAL,
  title TEXT,
  detail TEXT,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS shift_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  ccm_tons REAL, rm_tons REAL, miss_pcs INTEGER,
  kwh REAL, util_pct REAL, yield_pct REAL,
  payload_json TEXT,
  UNIQUE(date, shift_id)
);
"""


def _ensure_dirs():
    mes_config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    mes_config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def connect() -> sqlite3.Connection:
    _ensure_dirs()
    conn = sqlite3.connect(str(mes_config.DB_PATH), check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


@contextmanager
def db_session():
    with _lock:
        conn = connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init_db(seed_users: bool = True):
    global _initialized
    with db_session() as conn:
        conn.executescript(SCHEMA)
        if seed_users:
            cur = conn.execute("SELECT COUNT(*) AS c FROM users")
            if cur.fetchone()["c"] == 0:
                from mes.auth.users import hash_password
                now = datetime.now().isoformat(timespec="seconds")
                defaults = [
                    ("admin", "admin123", "admin", "Plant Admin"),
                    ("prod", "prod123", "production", "Production Supervisor"),
                    ("maint", "maint123", "maintenance", "Maintenance Engineer"),
                    ("mgmt", "mgmt123", "management", "Plant Manager"),
                ]
                for u, p, role, name in defaults:
                    conn.execute(
                        "INSERT INTO users(username,password_hash,role,full_name,created_at) VALUES(?,?,?,?,?)",
                        (u, hash_password(p), role, name, now),
                    )
    _initialized = True
    return str(mes_config.DB_PATH)


def insert_energy(ts: str, sample: dict):
    with db_session() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO energy_samples
               (ts,kwh,kvah,kvarh,kw,kva,kvar,pf,freq,volt,amp)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (
                ts,
                sample.get("kwh"), sample.get("kvah"), sample.get("kvarh"),
                sample.get("kw"), sample.get("kva"), sample.get("kvar"),
                sample.get("pf"), sample.get("freq"), sample.get("volt"), sample.get("amp"),
            ),
        )


def insert_hmd(ts: str, counts: dict, bits: dict):
    with db_session() as conn:
        conn.execute(
            "INSERT INTO hmd_samples(ts,counts_json,bits_json) VALUES(?,?,?)",
            (ts, json.dumps(counts), json.dumps(bits)),
        )


def insert_alarm(severity: str, message: str, area: str = "plant", code: str = "",
                 value: Any = None, limit_val: Any = None, meta: Optional[dict] = None):
    with db_session() as conn:
        conn.execute(
            """INSERT INTO alarms(ts,severity,area,code,message,value,limit_val,meta_json)
               VALUES(?,?,?,?,?,?,?,?)""",
            (
                datetime.now().isoformat(timespec="seconds"),
                severity, area, code, message,
                str(value) if value is not None else None,
                str(limit_val) if limit_val is not None else None,
                json.dumps(meta or {}),
            ),
        )


def save_ccm_heat(row: dict) -> int:
    with db_session() as conn:
        cur = conn.execute(
            """INSERT INTO ccm_heats(
                 heat_no,started_at,ended_at,s1,s2,total_pcs,tons,unit_ton,
                 billet_w,billet_h,billet_l,density,shift_id,operator,
                 casting_speed,run_sec,down_sec,payload_json,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                row.get("heatNo") or row.get("heat_no"),
                row.get("startedAt"), row.get("endedAt"),
                row.get("s1"), row.get("s2"), row.get("totalPcs"),
                row.get("tons"), row.get("unitTon"),
                (row.get("billet") or {}).get("w"),
                (row.get("billet") or {}).get("h"),
                (row.get("billet") or {}).get("L"),
                (row.get("billet") or {}).get("density"),
                row.get("shift_id") or row.get("shiftId"),
                row.get("operator"),
                row.get("casting_speed"), row.get("run_sec"), row.get("down_sec"),
                json.dumps(row), datetime.now().isoformat(timespec="seconds"),
            ),
        )
        return int(cur.lastrowid)


def clear_production_heats(kind: str = "both") -> dict:
    """Clear saved CCM / RM heats from SQLite (kind: ccm | rm | both)."""
    cleared = {"ccm": 0, "rm": 0}
    with db_session() as conn:
        if kind in ("ccm", "both"):
            cur = conn.execute("DELETE FROM ccm_heats")
            cleared["ccm"] = int(cur.rowcount or 0)
        if kind in ("rm", "both"):
            cur = conn.execute("DELETE FROM rm_heats")
            cleared["rm"] = int(cur.rowcount or 0)
    return cleared


def save_rm_heat(row: dict) -> int:
    with db_session() as conn:
        cur = conn.execute(
            """INSERT INTO rm_heats(
                 heat_no,started_at,ended_at,r3,tmt,miss_pcs,good_ton,miss_ton,yield_pct,
                 on_load_sec,idle_sec,stop_sec,util_pct,total_kwh,idle_kwh,kwh_per_ton,
                 shift_id,operator,product_size,hmd_json,stage_loss_json,payload_json,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                row.get("heatNo") or row.get("heat_no"),
                row.get("startedAt"), row.get("endedAt"),
                row.get("r3") if row.get("r3") is not None else row.get("r1"),
                row.get("tmt"), row.get("missPcs"),
                row.get("goodTon"), row.get("missTon"), row.get("yieldPct"),
                row.get("onLoadSec"), row.get("idleSec"), row.get("stopSec"), row.get("utilPct"),
                row.get("totalKwh"), row.get("idleKwh"), row.get("kwhPerTon"),
                row.get("shift_id") or row.get("shiftId"),
                row.get("operator"), row.get("product_size") or row.get("productSize"),
                json.dumps(row.get("hmd") or {}),
                json.dumps(row.get("stageLoss") or []),
                json.dumps(row), datetime.now().isoformat(timespec="seconds"),
            ),
        )
        return int(cur.lastrowid)


def insert_ai_insight(kind: str, title: str, detail: str, score: float = 0, meta: Optional[dict] = None):
    with db_session() as conn:
        conn.execute(
            "INSERT INTO ai_insights(ts,kind,score,title,detail,meta_json) VALUES(?,?,?,?,?,?)",
            (
                datetime.now().isoformat(timespec="seconds"),
                kind, score, title, detail, json.dumps(meta or {}),
            ),
        )


def recent_alarms(limit: int = 50) -> list[dict]:
    return query_rows("SELECT * FROM alarms ORDER BY id DESC LIMIT ?", (limit,))


def recent_insights(limit: int = 20) -> list[dict]:
    return query_rows("SELECT * FROM ai_insights ORDER BY id DESC LIMIT ?", (limit,))


def query_rows(sql: str, params: Iterable[Any] = ()) -> list[dict]:
    """Run a SELECT and return list of plain dict rows."""
    with _lock:
        conn = connect()
        try:
            cur = conn.execute(sql, tuple(params))
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    """Run a write statement; return lastrowid."""
    with db_session() as conn:
        cur = conn.execute(sql, tuple(params))
        return int(cur.lastrowid or 0)


def ack_alarm(alarm_id: int) -> bool:
    with db_session() as conn:
        cur = conn.execute("UPDATE alarms SET acked=1 WHERE id=?", (alarm_id,))
        return cur.rowcount > 0


def save_shift_summary(date: str, shift_id: str, payload: dict) -> int:
    with db_session() as conn:
        cur = conn.execute(
            """INSERT INTO shift_summaries(
                 date,shift_id,ccm_tons,rm_tons,miss_pcs,kwh,util_pct,yield_pct,payload_json)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(date,shift_id) DO UPDATE SET
                 ccm_tons=excluded.ccm_tons, rm_tons=excluded.rm_tons,
                 miss_pcs=excluded.miss_pcs, kwh=excluded.kwh,
                 util_pct=excluded.util_pct, yield_pct=excluded.yield_pct,
                 payload_json=excluded.payload_json""",
            (
                date, shift_id,
                (payload.get("ccm") or {}).get("tons"),
                (payload.get("rm") or {}).get("good_tons"),
                (payload.get("rm") or {}).get("miss_pcs"),
                (payload.get("energy") or {}).get("kwh"),
                (payload.get("rm") or {}).get("util_pct"),
                (payload.get("rm") or {}).get("yield_pct"),
                json.dumps(payload),
            ),
        )
        return int(cur.lastrowid or 0)