"""Flask API blueprint — Smart Steel Plant MES endpoints."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from functools import wraps
from typing import Callable, Optional

from flask import Blueprint, Response, jsonify, request

from mes.ai import analytics as ai_engine
from mes.auth import users as auth
from mes.config import (
    DEFAULT_MILL_START_KW, DEFAULT_ON_LOAD_KW, ENERGY_COST_PER_KWH, HMD_LINE, SHIFTS,
)
from mes import config as mes_config
from mes.database import db as database
from mes.energy import calculator as energy_calc
from mes.energy.band_integrator import BandIntegrator
from mes.production import kpi as prod_kpi
from mes.production.hmd_tracker import HmdTracker
from mes.reports import export as report_export

mes_bp = Blueprint("mes", __name__, url_prefix="/api/mes")

# Shared runtime state (set by bridge poll loop)
_runtime = {
    "live": {},
    "connected": False,
    "hmd": None,
    "tracker": HmdTracker(),
    "band": BandIntegrator(DEFAULT_MILL_START_KW, DEFAULT_ON_LOAD_KW),
    "kw_start": DEFAULT_MILL_START_KW,
    "kw_onload": DEFAULT_ON_LOAD_KW,
    "_last_energy_persist": 0.0,
}


def set_live(data: dict, connected: bool = True):
    _runtime["live"] = data or {}
    _runtime["connected"] = connected
    if not data:
        return
    snap = _runtime["tracker"].ingest(data)
    _runtime["hmd"] = snap
    try:
        sample = energy_calc.plc_to_energy_sample(data)
        _runtime["band"].set_thresholds(_runtime["kw_start"], _runtime["kw_onload"])
        _runtime["band"].tick(sample.get("kw") or 0)
        # Persist energy ~every 5s
        import time as _time
        now = _time.time()
        if now - float(_runtime.get("_last_energy_persist") or 0) >= 5:
            database.insert_energy(datetime.now().isoformat(timespec="seconds"), sample)
            _runtime["_last_energy_persist"] = now
    except Exception:
        pass


def _token() -> Optional[str]:
    h = request.headers.get("Authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return request.headers.get("X-MES-Token") or request.cookies.get("mes_token")


# Floor HMI may POST heats without login; sensitive writes still need a session.
_OPEN_WRITE_PREFIXES = ("/api/mes/heats/",)


def require_auth(fn: Callable):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = auth.session_user(_token())
        path = request.path or ""
        open_write = any(path.startswith(p) for p in _OPEN_WRITE_PREFIXES)
        if not user:
            # Allow GET without login for plant-floor HMI; protect most writes
            if request.method in ("POST", "PUT", "DELETE", "PATCH") and not open_write:
                return jsonify({"ok": False, "error": "login required"}), 401
        request.mes_user = user  # type: ignore[attr-defined]
        return fn(*args, **kwargs)
    return wrapper


def require_role(*roles: str):
    """Require login with one of the given roles (admin always included)."""
    allowed = set(roles) | {"admin"}

    def deco(fn: Callable):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = auth.session_user(_token())
            if not user:
                return jsonify({"ok": False, "error": "login required"}), 401
            if user.get("role") not in allowed:
                return jsonify({"ok": False, "error": "forbidden", "role": user.get("role")}), 403
            request.mes_user = user  # type: ignore[attr-defined]
            return fn(*args, **kwargs)
        return wrapper
    return deco


@mes_bp.route("/health")
def health():
    return jsonify({
        "ok": True,
        "mes": "Smart Steel Plant MES",
        "version": "1.0.0",
        "connected": _runtime["connected"],
        "db": str(mes_config.DB_PATH),
        "data_dir": str(mes_config.DATA_DIR),
    })


@mes_bp.route("/login", methods=["POST"])
def login():
    body = request.get_json(silent=True) or {}
    res = auth.login((body.get("username") or "").strip(), body.get("password") or "")
    if not res:
        return jsonify({"ok": False, "error": "invalid credentials"}), 401
    return jsonify({"ok": True, **res})


@mes_bp.route("/logout", methods=["POST"])
def logout():
    auth.logout(_token() or "")
    return jsonify({"ok": True})


@mes_bp.route("/me")
def me():
    user = auth.session_user(_token())
    if not user:
        return jsonify({"ok": False, "anonymous": True})
    return jsonify({"ok": True, "user": {
        "username": user["username"], "role": user["role"], "full_name": user["full_name"],
    }})


@mes_bp.route("/overview")
@require_auth
def overview():
    live = _runtime["live"]
    hmd = _runtime["tracker"].kpis()
    energy = energy_calc.plc_to_energy_sample(live) if live else {}
    band = _mill_band(energy.get("kw") or 0)
    today = datetime.now().strftime("%Y-%m-%d")
    ccm_rows = database.query_rows(
        "SELECT * FROM ccm_heats WHERE ended_at LIKE ? ORDER BY id DESC LIMIT 500",
        (today + "%",),
    )
    rm_rows = database.query_rows(
        "SELECT * FROM rm_heats WHERE ended_at LIKE ? ORDER BY id DESC LIMIT 500",
        (today + "%",),
    )
    # Map DB rows to KPI helpers
    ccm_mapped = [{
        "totalPcs": r.get("total_pcs"), "tons": r.get("tons"),
    } for r in ccm_rows]
    rm_mapped = [{
        "goodTon": r.get("good_ton"), "missPcs": r.get("miss_pcs"),
        "r3": r.get("r3"), "tmt": r.get("tmt"),
        "onLoadSec": r.get("on_load_sec"), "idleSec": r.get("idle_sec"),
        "totalKwh": r.get("total_kwh"),
    } for r in rm_rows]
    ccm = prod_kpi.ccm_summary(ccm_mapped)
    rm = prod_kpi.rm_summary(rm_mapped)
    plant = prod_kpi.plant_balance(ccm, rm, hmd)
    band_live = _runtime["band"].snapshot()
    insights = ai_engine.analyze(energy or live, hmd, {**rm, "util_pct": band_live.get("util_pct")})
    return jsonify({
        "ok": True,
        "shift": prod_kpi.current_shift(),
        "mill_band": {**band, **band_live},
        "thresholds": {"start_kw": _runtime["kw_start"], "onload_kw": _runtime["kw_onload"]},
        "live_energy": energy,
        "session": band_live,
        "hmd": hmd,
        "ccm_today": ccm,
        "rm_today": rm,
        "plant": plant,
        "ai": insights,
        "alarms": database.recent_alarms(30),
        "connected": _runtime["connected"],
        "unit_ton": prod_kpi.unit_ton(),
    })


def _mill_band(kw: float) -> dict:
    start, onl = _runtime["kw_start"], _runtime["kw_onload"]
    if kw > onl:
        mode = "onload"
    elif kw > start:
        mode = "idle"
    else:
        mode = "stop"
    return {"mode": mode, "kw": kw, "start_kw": start, "onload_kw": onl}


@mes_bp.route("/thresholds", methods=["GET", "POST"])
def thresholds():
    if request.method == "POST":
        user = auth.session_user(_token())
        if not user or user.get("role") not in ("admin", "production", "maintenance"):
            return jsonify({"ok": False, "error": "login required (admin/production/maintenance)"}), 401
        body = request.get_json(silent=True) or {}
        if body.get("start_kw") is not None:
            _runtime["kw_start"] = float(body["start_kw"])
        if body.get("onload_kw") is not None:
            _runtime["kw_onload"] = float(body["onload_kw"])
        if _runtime["kw_onload"] <= _runtime["kw_start"]:
            _runtime["kw_onload"] = _runtime["kw_start"] + 1
        _runtime["band"].set_thresholds(_runtime["kw_start"], _runtime["kw_onload"])
    return jsonify({
        "ok": True,
        "start_kw": _runtime["kw_start"],
        "onload_kw": _runtime["kw_onload"],
        "energy_cost_per_kwh": ENERGY_COST_PER_KWH,
        "session": _runtime["band"].snapshot(),
    })


@mes_bp.route("/hmd")
@require_auth
def hmd_status():
    return jsonify({
        "ok": True,
        "line": HMD_LINE,
        "kpis": _runtime["tracker"].kpis(),
    })


@mes_bp.route("/ccm/kpis")
@require_auth
def ccm_kpis():
    start = request.args.get("start")
    end = request.args.get("end")
    rows = prod_kpi.load_heats_from_db("ccm", start, end)
    mapped = [{"totalPcs": r.get("total_pcs"), "tons": r.get("tons"), "heatNo": r.get("heat_no"),
               "endedAt": r.get("ended_at"), "s1": r.get("s1"), "s2": r.get("s2")} for r in rows]
    return jsonify({"ok": True, "summary": prod_kpi.ccm_summary(mapped), "rows": mapped[:200]})


@mes_bp.route("/rm/kpis")
@require_auth
def rm_kpis():
    start = request.args.get("start")
    end = request.args.get("end")
    rows = prod_kpi.load_heats_from_db("rm", start, end)
    mapped = [{
        "heatNo": r.get("heat_no"), "endedAt": r.get("ended_at"),
        "r3": r.get("r3"), "tmt": r.get("tmt"), "missPcs": r.get("miss_pcs"),
        "goodTon": r.get("good_ton"), "onLoadSec": r.get("on_load_sec"),
        "idleSec": r.get("idle_sec"), "utilPct": r.get("util_pct"),
        "totalKwh": r.get("total_kwh"), "kwhPerTon": r.get("kwh_per_ton"),
    } for r in rows]
    return jsonify({"ok": True, "summary": prod_kpi.rm_summary(mapped), "rows": mapped[:200],
                    "live_hmd": _runtime["tracker"].kpis()})


@mes_bp.route("/energy/summary")
@require_auth
def energy_summary():
    start = request.args.get("start") or datetime.now().strftime("%Y-%m-%dT00:00:00")
    end = request.args.get("end") or datetime.now().strftime("%Y-%m-%dT23:59:59")
    rows = energy_calc.query_energy(start, end)
    tons = float(request.args.get("tons") or 0)
    billets = int(request.args.get("billets") or 0)
    return jsonify({"ok": True, "summary": energy_calc.summarize_energy(rows, tons, billets), "points": len(rows)})


@mes_bp.route("/ai/insights")
@require_auth
def ai_insights():
    live = _runtime["live"]
    energy = energy_calc.plc_to_energy_sample(live) if live else {}
    hmd = _runtime["tracker"].kpis()
    return jsonify({"ok": True, "insights": ai_engine.analyze(energy or live, hmd),
                    "stored": database.recent_insights(20)})


@mes_bp.route("/heats/ccm", methods=["POST"])
@require_auth
def post_ccm_heat():
    body = request.get_json(silent=True) or {}
    body.setdefault("shift_id", prod_kpi.current_shift()["id"])
    rid = database.save_ccm_heat(body)
    return jsonify({"ok": True, "id": rid})


@mes_bp.route("/heats/rm", methods=["POST"])
@require_auth
def post_rm_heat():
    body = request.get_json(silent=True) or {}
    body.setdefault("shift_id", prod_kpi.current_shift()["id"])
    # yield
    r3 = int(body.get("r3") or body.get("r1") or 0)
    tmt = int(body.get("tmt") or 0)
    body["yieldPct"] = (tmt / r3 * 100.0) if r3 else 0
    rid = database.save_rm_heat(body)
    return jsonify({"ok": True, "id": rid})


@mes_bp.route("/report/shift")
@require_auth
def shift_report():
    date = request.args.get("date") or datetime.now().strftime("%Y-%m-%d")
    shift_id = request.args.get("shift") or prod_kpi.current_shift()["id"]
    start, end = prod_kpi.shift_window(date, shift_id)
    ccm_rows = database.query_rows(
        "SELECT * FROM ccm_heats WHERE ended_at >= ? AND ended_at <= ?",
        (start.isoformat(), end.isoformat()),
    )
    rm_rows = database.query_rows(
        "SELECT * FROM rm_heats WHERE ended_at >= ? AND ended_at <= ?",
        (start.isoformat(), end.isoformat()),
    )
    ccm = prod_kpi.ccm_summary([{"totalPcs": r["total_pcs"], "tons": r["tons"]} for r in ccm_rows])
    rm = prod_kpi.rm_summary([{
        "goodTon": r["good_ton"], "missPcs": r["miss_pcs"], "r3": r["r3"], "tmt": r["tmt"],
        "onLoadSec": r["on_load_sec"], "idleSec": r["idle_sec"], "totalKwh": r["total_kwh"],
    } for r in rm_rows])
    erows = energy_calc.query_energy(start.isoformat(), end.isoformat())
    energy = energy_calc.summarize_energy(erows, rm.get("good_tons", 0), rm.get("finished", 0))
    plant = prod_kpi.plant_balance(ccm, rm, _runtime["tracker"].kpis())
    payload = report_export.shift_report_payload(date, shift_id, ccm, rm, energy, plant)
    fmt = (request.args.get("format") or "json").lower()
    if fmt == "csv":
        flat = [{
            "date": date, "shift": shift_id,
            "ccm_tons": ccm["tons"], "rm_tons": rm["good_tons"],
            "miss": rm["miss_pcs"], "yield": rm["yield_pct"],
            "kwh": energy["kwh"], "kwh_per_ton": energy["kwh_per_ton"],
            "util": rm["util_pct"], "plant_eff": plant["plant_efficiency"],
        }]
        csv_text = report_export.to_csv(flat)
        return Response(csv_text, mimetype="text/csv",
                        headers={"Content-Disposition": f"attachment; filename=shift_{date}_{shift_id}.csv"})
    return jsonify({"ok": True, "report": payload, "shifts": SHIFTS})


@mes_bp.route("/alarms")
@require_auth
def alarms():
    return jsonify({"ok": True, "rows": database.recent_alarms(int(request.args.get("limit") or 50))})


@mes_bp.route("/alarms/<int:alarm_id>/ack", methods=["POST"])
@require_auth
def ack_alarm(alarm_id: int):
    ok = database.ack_alarm(alarm_id)
    return jsonify({"ok": ok})


@mes_bp.route("/dashboard")
@require_auth
def dashboard():
    """Full MES payload for Plant / CCM / RM / Energy / AI tabs."""
    live = _runtime["live"]
    energy = energy_calc.plc_to_energy_sample(live) if live else {}
    hmd = _runtime["tracker"].kpis()
    session = _runtime["band"].snapshot()
    today = datetime.now().strftime("%Y-%m-%d")
    month = datetime.now().strftime("%Y-%m")
    year = datetime.now().strftime("%Y")

    def _period(kind: str, start: str, end: str):
        rows = prod_kpi.load_heats_from_db(kind, start, end)
        if kind == "ccm":
            mapped = [{"totalPcs": r.get("total_pcs"), "tons": r.get("tons"),
                       "heatNo": r.get("heat_no"), "endedAt": r.get("ended_at"),
                       "s1": r.get("s1"), "s2": r.get("s2"),
                       "startedAt": r.get("started_at")} for r in rows]
            return prod_kpi.ccm_summary(mapped), mapped[:100]
        mapped = [{
            "heatNo": r.get("heat_no"), "endedAt": r.get("ended_at"),
            "r3": r.get("r3"), "tmt": r.get("tmt"), "missPcs": r.get("miss_pcs"),
            "goodTon": r.get("good_ton"), "onLoadSec": r.get("on_load_sec"),
            "idleSec": r.get("idle_sec"), "utilPct": r.get("util_pct"),
            "totalKwh": r.get("total_kwh"), "kwhPerTon": r.get("kwh_per_ton"),
        } for r in rows]
        return prod_kpi.rm_summary(mapped), mapped[:100]

    ccm_d, ccm_rows = _period("ccm", today + "T00:00:00", today + "T23:59:59")
    rm_d, rm_rows = _period("rm", today + "T00:00:00", today + "T23:59:59")
    ccm_m, _ = _period("ccm", month + "-01T00:00:00", today + "T23:59:59")
    rm_m, _ = _period("rm", month + "-01T00:00:00", today + "T23:59:59")
    ccm_y, _ = _period("ccm", year + "-01-01T00:00:00", today + "T23:59:59")
    rm_y, _ = _period("rm", year + "-01-01T00:00:00", today + "T23:59:59")

    erows = energy_calc.query_energy(today + "T00:00:00", today + "T23:59:59")
    esum = energy_calc.summarize_energy(erows, rm_d.get("good_tons", 0), rm_d.get("finished", 0))
    split = energy_calc.split_productive_idle(session.get("on_load_kwh", 0), session.get("idle_kwh", 0))
    plant = prod_kpi.plant_balance(ccm_d, rm_d, hmd)
    insights = ai_engine.analyze(energy or live, hmd, {**rm_d, "util_pct": session.get("util_pct")})

    # Hourly energy trend for charts (bucket by hour)
    hourly = {}
    for r in erows:
        ts = (r.get("ts") or "")[:13]  # YYYY-MM-DDTHH
        if not ts:
            continue
        hourly.setdefault(ts, {"kw": [], "kwh": None})
        try:
            hourly[ts]["kw"].append(float(r.get("kw") or 0))
            hourly[ts]["kwh"] = float(r.get("kwh") or 0)
        except Exception:
            pass
    hourly_pts = []
    for k in sorted(hourly.keys())[-24:]:
        kws = hourly[k]["kw"]
        hourly_pts.append({
            "hour": k[-2:] + ":00",
            "avg_kw": round(sum(kws) / len(kws), 1) if kws else 0,
        })

    heat_chart = [{"heat": r.get("heatNo"), "tons": r.get("tons") or r.get("goodTon") or 0}
                  for r in (ccm_rows[:12][::-1] if ccm_rows else [])]

    return jsonify({
        "ok": True,
        "connected": _runtime["connected"],
        "shift": prod_kpi.current_shift(),
        "unit_ton": prod_kpi.unit_ton(),
        "live_energy": energy,
        "session": session,
        "hmd": hmd,
        "plant": plant,
        "ai": insights,
        "alarms": database.recent_alarms(40),
        "ccm": {
            "today": ccm_d, "month": ccm_m, "year": ccm_y,
            "rows": ccm_rows, "live_s1": hmd.get("ccm_s1", 0), "live_s2": hmd.get("ccm_s2", 0),
        },
        "rm": {
            "today": rm_d, "month": rm_m, "year": rm_y,
            "rows": rm_rows, "live": hmd,
        },
        "energy": {**esum, **split, "session_kwh": session.get("total_kwh")},
        "charts": {
            "hourly_kw": hourly_pts,
            "heat_tons": heat_chart,
            "miss_vs_yield": {
                "miss_pct": rm_d.get("miss_pct", 0),
                "yield_pct": rm_d.get("yield_pct", 0),
            },
            "run_idle": {
                "on_load": session.get("on_load_sec", 0),
                "idle": session.get("idle_sec", 0),
                "stop": session.get("stop_sec", 0),
            },
        },
        "thresholds": {"start_kw": _runtime["kw_start"], "onload_kw": _runtime["kw_onload"]},
        "hmd_line": HMD_LINE,
    })


@mes_bp.route("/report/period")
@require_auth
def period_report():
    """Day / week / month / year production+energy report."""
    kind = (request.args.get("kind") or "day").lower()
    date = request.args.get("date") or datetime.now().strftime("%Y-%m-%d")
    day = datetime.fromisoformat(date)
    if kind == "year":
        start = day.replace(month=1, day=1, hour=0, minute=0, second=0)
        end = day.replace(hour=23, minute=59, second=59)
    elif kind == "month":
        start = day.replace(day=1, hour=0, minute=0, second=0)
        end = day.replace(hour=23, minute=59, second=59)
    elif kind == "week":
        start = (day - timedelta(days=day.weekday())).replace(hour=0, minute=0, second=0)
        end = day.replace(hour=23, minute=59, second=59)
    else:
        start = day.replace(hour=0, minute=0, second=0)
        end = day.replace(hour=23, minute=59, second=59)

    ccm_rows = database.query_rows(
        "SELECT * FROM ccm_heats WHERE ended_at >= ? AND ended_at <= ?",
        (start.isoformat(), end.isoformat()),
    )
    rm_rows = database.query_rows(
        "SELECT * FROM rm_heats WHERE ended_at >= ? AND ended_at <= ?",
        (start.isoformat(), end.isoformat()),
    )
    ccm = prod_kpi.ccm_summary([{"totalPcs": r["total_pcs"], "tons": r["tons"]} for r in ccm_rows])
    rm = prod_kpi.rm_summary([{
        "goodTon": r["good_ton"], "missPcs": r["miss_pcs"], "r3": r["r3"], "tmt": r["tmt"],
        "onLoadSec": r["on_load_sec"], "idleSec": r["idle_sec"], "totalKwh": r["total_kwh"],
    } for r in rm_rows])
    erows = energy_calc.query_energy(start.isoformat(), end.isoformat())
    energy = energy_calc.summarize_energy(erows, rm.get("good_tons", 0), rm.get("finished", 0))
    plant = prod_kpi.plant_balance(ccm, rm, _runtime["tracker"].kpis())
    payload = {
        "report": kind, "date": date,
        "start": start.isoformat(), "end": end.isoformat(),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "ccm": ccm, "rm": rm, "energy": energy, "plant": plant,
        "operator": getattr(request, "mes_user", None) and request.mes_user.get("full_name") or "",
    }
    try:
        database.save_shift_summary(date, kind.upper()[:1] or "D", payload)
    except Exception:
        pass

    fmt = (request.args.get("format") or "json").lower()
    flat = [{
        "kind": kind, "date": date,
        "ccm_tons": ccm["tons"], "ccm_billets": ccm["billets"],
        "rm_tons": rm["good_tons"], "miss": rm["miss_pcs"], "yield": rm["yield_pct"],
        "kwh": energy["kwh"], "kwh_per_ton": energy["kwh_per_ton"],
        "cost": energy["cost"], "util": rm["util_pct"],
        "plant_eff": plant["plant_efficiency"],
    }]
    if fmt == "csv":
        return Response(report_export.to_csv(flat), mimetype="text/csv",
                        headers={"Content-Disposition": f"attachment; filename=mes_{kind}_{date}.csv"})
    if fmt == "xlsx":
        raw = report_export.try_excel(flat, "MES Report")
        if raw is None:
            return jsonify({"ok": False, "error": "openpyxl not installed"}), 501
        return Response(raw, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": f"attachment; filename=mes_{kind}_{date}.xlsx"})
    return jsonify({"ok": True, "report": payload})


@mes_bp.route("/session/reset", methods=["POST"])
@require_role("production", "maintenance")
def reset_session():
    _runtime["band"].reset_session()
    return jsonify({"ok": True, "session": _runtime["band"].snapshot()})
