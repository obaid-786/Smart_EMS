"""AI analytics engine — rule + statistical anomaly detection for plant MES.

Industrial note: these models are online heuristics suitable for operator
advisory. Retrain offline with site historical data for higher accuracy.
"""
from __future__ import annotations

from datetime import datetime
from statistics import mean, pstdev
from typing import Any, Optional

from mes.database import db as database


def _recent_energy(limit: int = 120) -> list[dict]:
    try:
        return database.query_rows(
            "SELECT kw,pf,kwh,ts FROM energy_samples ORDER BY id DESC LIMIT ?",
            (limit,),
        )
    except Exception:
        return []


def analyze(live: dict, hmd_kpis: Optional[dict] = None, rm_live: Optional[dict] = None) -> list[dict]:
    """Return AI insights / recommendations for the dashboard."""
    insights: list[dict] = []
    hmd_kpis = hmd_kpis or {}
    rm_live = rm_live or {}
    now = datetime.now().isoformat(timespec="seconds")

    # Miss-roll risk from yield
    miss_pct = float(hmd_kpis.get("miss_pct") or 0)
    yield_pct = float(hmd_kpis.get("yield_pct") or 100)
    if miss_pct >= 3:
        insights.append({
            "kind": "miss_roll_risk",
            "score": min(1.0, miss_pct / 10.0),
            "title": "Elevated miss-roll risk",
            "detail": f"Current miss-roll {miss_pct:.1f}% (yield {yield_pct:.1f}%). Check guides between worst HMD gap.",
            "action": "Inspect stand guides / shear timing on highest-loss segment",
        })

    losses = hmd_kpis.get("losses") or []
    if losses:
        worst = max(losses, key=lambda x: x.get("lost", 0))
        if worst.get("lost", 0) >= 3:
            insights.append({
                "kind": "bottleneck",
                "score": min(1.0, worst["lost"] / 20.0),
                "title": f"Bottleneck {worst.get('from_label')} → {worst.get('to_label')}",
                "detail": f"{worst['lost']} pcs lost in segment — likely delay, jam, or sensor miss.",
                "action": "Verify HMD alignment and material flow in that zone",
            })

    # Energy anomaly vs recent mean
    hist = _recent_energy()
    kw_now = float(live.get("kw") or 0)
    if not kw_now and live.get("Total Active Power_2") is not None:
        try:
            kw_now = float(live["Total Active Power_2"]) / 1000.0
        except Exception:
            kw_now = 0
    if len(hist) >= 20:
        series = []
        for r in hist:
            try:
                series.append(float(r["kw"] or 0))
            except Exception:
                pass
        if series:
            mu, sd = mean(series), pstdev(series) or 1.0
            z = abs(kw_now - mu) / sd
            if z >= 2.5 and kw_now > mu:
                insights.append({
                    "kind": "energy_anomaly",
                    "score": min(1.0, z / 5.0),
                    "title": "Abnormal energy consumption",
                    "detail": f"HT load {kw_now:.0f} kW is {z:.1f}σ above recent mean {mu:.0f} kW.",
                    "action": "Check idle rolling, water pumps, and PF correction",
                })

    pf = float(live.get("pf") or live.get("Total Power Factor_2") or 0)
    if 0 < pf < 0.85:
        insights.append({
            "kind": "pf_health",
            "score": 0.7,
            "title": "Low power factor",
            "detail": f"PF={pf:.2f}. Energy cost and transformer loading will rise.",
            "action": "Engage capacitor banks / check harmonic filters",
        })

    util = float(rm_live.get("util_pct") or 0)
    if 0 < util < 55:
        insights.append({
            "kind": "utilization",
            "score": 0.55,
            "title": "Low mill utilization",
            "detail": f"Utilization {util:.0f}%. High idle share vs on-load band.",
            "action": "Review billet pacing from CCM and on-load threshold for bar size",
        })

    # Equipment health heuristic from alarm density
    alarms = hmd_kpis.get("alarms") or []
    if len(alarms) >= 3:
        insights.append({
            "kind": "equipment_health",
            "score": min(1.0, len(alarms) / 8.0),
            "title": "Sensor / equipment attention",
            "detail": f"{len(alarms)} active HMD/process advisories in last sample.",
            "action": "Schedule preventive check on flagged HMDs",
        })

    if not insights:
        insights.append({
            "kind": "ok",
            "score": 0.1,
            "title": "Process within normal envelope",
            "detail": "No high-severity anomalies detected from live rules.",
            "action": "Continue monitoring",
        })

    # Persist only high-value advisories, throttled by kind (avoid DB flood)
    for ins in insights:
        if ins.get("kind") == "ok":
            continue
        try:
            recent = database.query_rows(
                "SELECT kind,ts FROM ai_insights WHERE kind=? ORDER BY id DESC LIMIT 1",
                (ins["kind"],),
            )
            if recent:
                try:
                    last = datetime.fromisoformat(recent[0]["ts"])
                    if (datetime.now() - last).total_seconds() < 300:
                        continue
                except Exception:
                    pass
            database.insert_ai_insight(
                ins["kind"], ins["title"], ins.get("detail", ""),
                float(ins.get("score") or 0), {"action": ins.get("action")},
            )
        except Exception:
            pass
    return insights
