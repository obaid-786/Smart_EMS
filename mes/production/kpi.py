"""Production KPIs — CCM, Rolling Mill, plant balance, shifts."""
from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any, Optional

from mes.config import BILLET_H_MM, BILLET_L_MM, BILLET_W_MM, SHIFTS, STEEL_DENSITY
from mes.database import db as database


def unit_ton(w_mm=BILLET_W_MM, h_mm=BILLET_H_MM, l_mm=BILLET_L_MM, density=STEEL_DENSITY) -> float:
    return (w_mm / 1000.0) * (h_mm / 1000.0) * (l_mm / 1000.0) * density


def current_shift(now: Optional[datetime] = None) -> dict:
    now = now or datetime.now()
    t = now.time()
    for s in SHIFTS:
        start = time.fromisoformat(s["start"])
        end = time.fromisoformat(s["end"])
        if start < end:
            if start <= t < end:
                return s
        else:  # overnight C
            if t >= start or t < end:
                return s
    return SHIFTS[0]


def shift_window(date_str: str, shift_id: str) -> tuple[datetime, datetime]:
    day = datetime.fromisoformat(date_str)
    s = next((x for x in SHIFTS if x["id"] == shift_id), SHIFTS[0])
    start_t = time.fromisoformat(s["start"])
    end_t = time.fromisoformat(s["end"])
    start = datetime.combine(day.date(), start_t)
    end = datetime.combine(day.date(), end_t)
    if end <= start:
        end += timedelta(days=1)
    return start, end


def ccm_summary(rows: list[dict]) -> dict[str, Any]:
    heats = len(rows)
    pcs = sum(int(r.get("totalPcs") or r.get("total_pcs") or 0) for r in rows)
    tons = sum(float(r.get("tons") or 0) for r in rows)
    return {
        "heats": heats,
        "billets": pcs,
        "tons": round(tons, 3),
        "avg_per_heat": round(tons / heats, 3) if heats else 0,
        "billets_per_heat": round(pcs / heats, 1) if heats else 0,
    }


def rm_summary(rows: list[dict]) -> dict[str, Any]:
    heats = len(rows)
    good = sum(float(r.get("goodTon") or r.get("good_ton") or 0) for r in rows)
    miss = sum(int(r.get("missPcs") or r.get("miss_pcs") or 0) for r in rows)
    r3 = sum(int(r.get("r3") or r.get("r1") or 0) for r in rows)
    tmt = sum(int(r.get("tmt") or 0) for r in rows)
    on_sec = sum(float(r.get("onLoadSec") or r.get("on_load_sec") or 0) for r in rows)
    idle_sec = sum(float(r.get("idleSec") or r.get("idle_sec") or 0) for r in rows)
    kwh = sum(float(r.get("totalKwh") or r.get("total_kwh") or 0) for r in rows)
    run = on_sec + idle_sec
    util = (on_sec / run * 100.0) if run > 0 else 0.0
    yield_pct = (tmt / r3 * 100.0) if r3 > 0 else 0.0
    return {
        "heats": heats,
        "received_r3": r3,
        "finished": tmt,
        "good_tons": round(good, 3),
        "miss_pcs": miss,
        "miss_pct": round(miss / r3 * 100.0, 2) if r3 else 0,
        "yield_pct": round(yield_pct, 2),
        "on_load_sec": on_sec,
        "idle_sec": idle_sec,
        "util_pct": round(util, 2),
        "kwh": round(kwh, 2),
        "kwh_per_ton": round(kwh / good, 2) if good > 0 else 0,
    }


def plant_balance(ccm: dict, rm: dict, hmd_live: Optional[dict] = None) -> dict[str, Any]:
    ccm_pcs = ccm.get("billets", 0)
    rm_recv = (hmd_live or {}).get("received") or rm.get("received_r3", 0)
    finished = (hmd_live or {}).get("finished") or rm.get("finished", 0)
    diff = max(0, ccm_pcs - finished)
    yield_pct = (finished / ccm_pcs * 100.0) if ccm_pcs > 0 else 0.0
    return {
        "ccm_billets": ccm_pcs,
        "rm_received": rm_recv,
        "finished": finished,
        "difference": diff,
        "yield_pct": round(yield_pct, 2),
        "production_loss": diff,
        "hot_charge_efficiency": round(min(100.0, (rm_recv / ccm_pcs * 100.0) if ccm_pcs else 0), 2),
        "plant_efficiency": round(yield_pct, 2),
    }


def load_heats_from_db(kind: str, start: Optional[str] = None, end: Optional[str] = None) -> list[dict]:
    table = "ccm_heats" if kind == "ccm" else "rm_heats"
    sql = f"SELECT * FROM {table} WHERE 1=1"
    params: list[Any] = []
    if start:
        sql += " AND ended_at >= ?"
        params.append(start)
    if end:
        sql += " AND ended_at <= ?"
        params.append(end)
    sql += " ORDER BY ended_at DESC LIMIT 2000"
    try:
        return database.query_rows(sql, params)
    except Exception:
        return []
