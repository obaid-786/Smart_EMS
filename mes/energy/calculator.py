"""Energy management — SEC, idle/productive split, cost, demand."""
from __future__ import annotations

from typing import Any, Optional

from mes.config import ACTIVE_POWER_DIV, ENERGY_COST_PER_KWH
from mes.database import db as database


def plc_to_energy_sample(data: dict) -> dict:
    kw = float(data.get("Total Active Power_2") or 0) / ACTIVE_POWER_DIV
    kva = float(data.get("Total Apparent Power_2") or 0) / ACTIVE_POWER_DIV
    return {
        "kwh": float(data.get("I_KWH_") or 0),
        "kvah": float(data.get("I_KVAH_2") or 0),
        "kvarh": float(data.get("I_KVARH_2") or 0),
        "kw": kw,
        "kva": kva,
        "kvar": float(data.get("Total Reac Power_2") or 0) / ACTIVE_POWER_DIV,
        "pf": float(data.get("Total Power Factor_2") or 0),
        "freq": float(data.get("Line Frequency_2") or 0),
        "volt": float(data.get("3-Ph Average Volt L-N_2") or 0),
        "amp": float(data.get("3-Ph Average Curr_2") or 0),
    }


def summarize_energy(rows: list[dict], good_tons: float = 0.0, billets: int = 0) -> dict[str, Any]:
    if not rows:
        return {
            "readings": 0, "kwh": 0, "kvah": 0, "avg_kw": 0, "avg_pf": 0,
            "max_demand_kw": 0, "kwh_per_ton": 0, "energy_per_billet": 0,
            "cost": 0, "cost_per_ton": 0,
        }

    def num(r, *keys):
        for k in keys:
            if r.get(k) is not None:
                try:
                    return float(r[k])
                except (TypeError, ValueError):
                    pass
        return 0.0

    first, last = rows[0], rows[-1]
    kwh = num(last, "kwh", "I_KWH_") - num(first, "kwh", "I_KWH_")
    kvah = num(last, "kvah", "I_KVAH_2") - num(first, "kvah", "I_KVAH_2")
    kws = [num(r, "kw", "Total Active Power_2") for r in rows]
    # If raw W-scale slipped in
    if kws and max(kws) > 20000:
        kws = [k / ACTIVE_POWER_DIV for k in kws]
    pfs = [num(r, "pf", "Total Power Factor_2") for r in rows]
    avg_kw = sum(kws) / len(kws)
    max_kw = max(kws) if kws else 0
    avg_pf = sum(pfs) / len(pfs) if pfs else 0
    cost = kwh * ENERGY_COST_PER_KWH
    return {
        "readings": len(rows),
        "kwh": round(kwh, 3),
        "kvah": round(kvah, 3),
        "avg_kw": round(avg_kw, 2),
        "avg_pf": round(avg_pf, 3),
        "max_demand_kw": round(max_kw, 2),
        "kwh_per_ton": round(kwh / good_tons, 2) if good_tons > 0 else 0,
        "energy_per_billet": round(kwh / billets, 3) if billets > 0 else 0,
        "cost": round(cost, 2),
        "cost_per_ton": round(cost / good_tons, 2) if good_tons > 0 else 0,
        "tariff": ENERGY_COST_PER_KWH,
        "start": first.get("ts") or first.get("timestamp"),
        "end": last.get("ts") or last.get("timestamp"),
    }


def split_productive_idle(on_load_kwh: float, idle_kwh: float) -> dict:
    total = on_load_kwh + idle_kwh
    return {
        "productive_kwh": round(on_load_kwh, 3),
        "idle_kwh": round(idle_kwh, 3),
        "loss_pct": round(idle_kwh / total * 100.0, 2) if total > 0 else 0,
    }


def query_energy(start: str, end: str) -> list[dict]:
    try:
        return database.query_rows(
            "SELECT * FROM energy_samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC",
            (start, end),
        )
    except Exception:
        return []
