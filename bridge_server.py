"""
bridge_server.py
----------------
Smart Steel Plant bridge + MES API.

Polls S7-1200 (DB4 PAC3200 + DB8 BILLETS_COUNTS), logs energy CSV,
persists to SQLite MES DB, and serves legacy + /api/mes/* endpoints.

RUN
    python bridge_server.py
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import threading
import time
import traceback
import zipfile
from datetime import datetime, timedelta

from flask import Flask, jsonify, request, Response, send_file, send_from_directory
from flask_cors import CORS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pac3200_reader import (
    PLCReader, PLC_IP, OUTPUT_TAGS, BILLETS_HMD_BOOLS, BILLETS_COUNT_TAGS,
)
from mes.api.blueprint import mes_bp, set_live as mes_set_live
from mes.database import db as mes_db
from mes import config as mes_config

# Auto-save every poll cycle (1 second)
POLL_INTERVAL_SECONDS = 1
CONFIG_FILE = os.path.join(BASE_DIR, "log_config.json")
DEFAULT_LOG_DIR = r"D:\Smart EMS and MIS Project\Plant_Data"
LOG_FILENAME = "pac3200_log.csv"
LIVE_JSONL = "plant_live.jsonl"  # full snapshot every 1 s
DATA_FILES = (
    "pac3200_log.csv",
    "plant_live.jsonl",
    "ccm_heats.jsonl",
    "rm_heats.jsonl",
    "ems_readings.jsonl",
    "daily_production.jsonl",
    "plant_mes.sqlite3",
)

# Wide CSV: all DB4 Output tags + DB8 HMD bits/counts + energy aliases
LOG_FIELDS = (
    [name for name, _off, _dtype in OUTPUT_TAGS]
    + ["I_KWH_", "I_KVAH_2", "I_KVARH_2"]
    + [name for name, _b, _bit in BILLETS_HMD_BOOLS]
    + [name for name, _off in BILLETS_COUNT_TAGS]
)
CSV_HEADER = ["timestamp"] + LOG_FIELDS

app = Flask(__name__, static_folder=BASE_DIR)
CORS(app)
app.register_blueprint(mes_bp)

_lock = threading.Lock()
_latest = {
    "connected": False, "error": None, "data": None,
    "timestamp": None, "plc_ip": None, "billets_ok": False,
}
_log_dir = DEFAULT_LOG_DIR
_log_file = os.path.join(DEFAULT_LOG_DIR, LOG_FILENAME)


def _apply_data_dir(folder: str):
    """Point CSV log, heats JSONL, and MES SQLite at the selected folder."""
    global _log_dir, _log_file
    folder = (folder or DEFAULT_LOG_DIR).strip()
    os.makedirs(folder, exist_ok=True)
    _log_dir = folder
    _log_file = os.path.join(_log_dir, LOG_FILENAME)
    mes_config.set_data_dir(folder)
    try:
        mes_db.init_db(seed_users=True)
    except Exception:
        traceback.print_exc()


def _load_config():
    global _log_dir, _log_file
    folder = DEFAULT_LOG_DIR
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
            folder = (cfg.get("log_dir") or DEFAULT_LOG_DIR).strip() or DEFAULT_LOG_DIR
        except Exception:
            traceback.print_exc()
    _apply_data_dir(folder)


def _save_config():
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump({"log_dir": _log_dir}, f, indent=2)


def _list_data_files():
    files = []
    try:
        for name in sorted(os.listdir(_log_dir)):
            path = os.path.join(_log_dir, name)
            if not os.path.isfile(path):
                continue
            if name.startswith("."):
                continue
            st = os.stat(path)
            files.append({
                "name": name,
                "size": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                "path": path,
            })
    except Exception as exc:
        return [], str(exc)
    return files, None


def _ensure_log_dir_and_file():
    os.makedirs(_log_dir, exist_ok=True)
    if not os.path.exists(_log_file):
        with open(_log_file, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(CSV_HEADER)
    else:
        try:
            with open(_log_file, "r", newline="", encoding="utf-8") as f:
                first = f.readline().strip()
            expected = ",".join(CSV_HEADER)
            if first and first != expected:
                bak = _log_file.replace(".csv", f"_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
                os.replace(_log_file, bak)
                with open(_log_file, "w", newline="", encoding="utf-8") as f:
                    csv.writer(f).writerow(CSV_HEADER)
        except Exception:
            traceback.print_exc()


def _csv_cell(v):
    if isinstance(v, bool):
        return 1 if v else 0
    if v is None:
        return ""
    return v


def _log_row(data, ts):
    """Auto-save every 1 s: wide CSV + full JSONL snapshot."""
    _ensure_log_dir_and_file()
    iso = datetime.fromtimestamp(ts).isoformat(timespec="seconds")
    row = [iso] + [_csv_cell(data.get(field, "")) for field in LOG_FIELDS]
    with open(_log_file, "a", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(row)

    # Full plant snapshot (all tags from this cycle) for retrieve/import
    snap = {"timestamp": iso}
    for k, v in data.items():
        if str(k).startswith("_"):
            continue
        if isinstance(v, bool):
            snap[k] = bool(v)
        elif isinstance(v, (int, float)):
            snap[k] = v
        else:
            try:
                snap[k] = float(v)
            except (TypeError, ValueError):
                snap[k] = v
    jsonl_path = os.path.join(_log_dir, LIVE_JSONL)
    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(snap, ensure_ascii=False) + "\n")


def _poll_loop():
    reader = PLCReader()
    while True:
        t0 = time.time()
        try:
            if not reader.client.get_connected():
                reader.connect()
            data = reader.read(group="output")  # DB4 Output + DB8 HMD
            ts = time.time()
            with _lock:
                _latest["connected"] = True
                _latest["error"] = None
                _latest["data"] = data
                _latest["timestamp"] = ts
                _latest["plc_ip"] = PLC_IP
                _latest["billets_ok"] = bool(data.get("_billets_ok"))
            try:
                mes_set_live(data, connected=True)
            except Exception:
                traceback.print_exc()
            try:
                _log_row(data, ts)
            except Exception:
                traceback.print_exc()
        except Exception as exc:
            traceback.print_exc()
            with _lock:
                _latest["connected"] = False
                _latest["error"] = str(exc)
            try:
                mes_set_live({}, connected=False)
            except Exception:
                pass
            time.sleep(2)
            continue
        # Keep true 1 s cycle (account for PLC read time)
        elapsed = time.time() - t0
        time.sleep(max(0.05, POLL_INTERVAL_SECONDS - elapsed))


def _parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def _read_history(start_dt, end_dt):
    _ensure_log_dir_and_file()
    rows = []
    with open(_log_file, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                row_ts = datetime.fromisoformat(row["timestamp"]).replace(tzinfo=None)
            except Exception:
                continue
            if start_dt and row_ts < start_dt:
                continue
            if end_dt and row_ts > end_dt:
                continue
            rows.append(row)
    return rows


def _row_num(r, k):
    try:
        return float(r.get(k) or 0)
    except (TypeError, ValueError):
        return 0.0


def _new_energy_bucket():
    return {
        "readings": 0,
        "first_ts": None,
        "last_ts": None,
        "kwh_start": None,
        "kwh_end": None,
        "kvah_start": None,
        "kvah_end": None,
        "kvarh_start": None,
        "kvarh_end": None,
        "calc_kwh": 0.0,
        "calc_kvah": 0.0,
        "calc_kvarh": 0.0,
        "pf_sum": 0.0,
        "kw_sum": 0.0,
        "_prev_ts": None,
        "_prev_kw": 0.0,
        "_prev_kva": 0.0,
        "_prev_kvar": 0.0,
    }


def _accumulate_energy_row(bucket, row, ts):
    kw = _row_num(row, "Total Active Power_2")
    kva = _row_num(row, "Total Apparent Power_2")
    kvar = _row_num(row, "Total Reac Power_2")
    if kvar == 0.0:
        kvar = (
            _row_num(row, "Reactive power L1_2")
            + _row_num(row, "Reactive power L2_2")
            + _row_num(row, "Reactive power L3_2")
        )
    pf = _row_num(row, "Total Power Factor_2")
    if pf == 0.0:
        pf = _row_num(row, "Average Power Factor_2")

    kwh = _row_num(row, "I_KWH_") or _row_num(row, "O_KWH_1")
    kvah = _row_num(row, "I_KVAH_2") or _row_num(row, "O_KVAH_1")
    kvarh = _row_num(row, "I_KVARH_2") or _row_num(row, "O_KVARH_1")

    if bucket["readings"] == 0:
        bucket["first_ts"] = ts
        bucket["kwh_start"] = kwh
        bucket["kvah_start"] = kvah
        bucket["kvarh_start"] = kvarh
    bucket["last_ts"] = ts
    bucket["kwh_end"] = kwh
    bucket["kvah_end"] = kvah
    bucket["kvarh_end"] = kvarh
    bucket["readings"] += 1
    bucket["pf_sum"] += pf
    bucket["kw_sum"] += kw

    prev = bucket["_prev_ts"]
    if prev is not None:
        dt = (ts - prev).total_seconds()
        if 0 < dt <= 120:
            bucket["calc_kwh"] += bucket["_prev_kw"] * dt / 3600.0
            bucket["calc_kvah"] += bucket["_prev_kva"] * dt / 3600.0
            bucket["calc_kvarh"] += bucket["_prev_kvar"] * dt / 3600.0
    bucket["_prev_ts"] = ts
    bucket["_prev_kw"] = kw
    bucket["_prev_kva"] = kva
    bucket["_prev_kvar"] = kvar


def _finalize_energy_bucket(bucket, query_start=None, query_end=None, extra=None):
    if not bucket or bucket["readings"] <= 0:
        out = {
            "readings": 0,
            "kwh_consumed": 0.0,
            "kvah_consumed": 0.0,
            "kvarh_consumed": 0.0,
            "kwh_start": None,
            "kwh_end": None,
            "kvah_start": None,
            "kvah_end": None,
            "kvarh_start": None,
            "kvarh_end": None,
            "calc_kwh": 0.0,
            "calc_kvah": 0.0,
            "calc_kvarh": 0.0,
            "avg_pf": None,
            "avg_kw": None,
            "start": None,
            "end": None,
            "query_start": query_start,
            "query_end": query_end,
        }
        if extra:
            out.update(extra)
        return out

    kwh_s = bucket["kwh_start"]
    kwh_e = bucket["kwh_end"]
    kvah_s = bucket["kvah_start"]
    kvah_e = bucket["kvah_end"]
    kvarh_s = bucket["kvarh_start"]
    kvarh_e = bucket["kvarh_end"]
    n = bucket["readings"]
    out = {
        "readings": n,
        "kwh_consumed": round((kwh_e or 0) - (kwh_s or 0), 3),
        "kvah_consumed": round((kvah_e or 0) - (kvah_s or 0), 3),
        "kvarh_consumed": round((kvarh_e or 0) - (kvarh_s or 0), 3),
        "kwh_start": kwh_s,
        "kwh_end": kwh_e,
        "kvah_start": kvah_s,
        "kvah_end": kvah_e,
        "kvarh_start": kvarh_s,
        "kvarh_end": kvarh_e,
        "calc_kwh": round(bucket["calc_kwh"], 3),
        "calc_kvah": round(bucket["calc_kvah"], 3),
        "calc_kvarh": round(bucket["calc_kvarh"], 3),
        "avg_pf": round(bucket["pf_sum"] / n, 4) if n else None,
        "avg_kw": round(bucket["kw_sum"] / n, 3) if n else None,
        "start": bucket["first_ts"].isoformat(timespec="seconds") if bucket["first_ts"] else None,
        "end": bucket["last_ts"].isoformat(timespec="seconds") if bucket["last_ts"] else None,
        "query_start": query_start,
        "query_end": query_end,
    }
    if extra:
        out.update(extra)
    return out


def _plant_day_id(ts, day_start_hour):
    """Plant day labeled by the calendar date when the window started."""
    adj = ts - timedelta(hours=int(day_start_hour) % 24)
    return adj.date()


def _scan_energy(start_dt, end_dt, group_plant_day=False, day_start_hour=9):
    """
    Stream pac3200_log.csv once.
    - group_plant_day=False → one summary dict
    - group_plant_day=True  → {"days":[...], "totals":{...}} for each 24h plant day
    """
    _ensure_log_dir_and_file()
    q_start = start_dt.isoformat(timespec="seconds") if start_dt else None
    q_end = end_dt.isoformat(timespec="seconds") if end_dt else None
    hour = int(day_start_hour) % 24

    if not group_plant_day:
        bucket = _new_energy_bucket()
        with open(_log_file, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    ts = datetime.fromisoformat(str(row.get("timestamp", "")).replace("Z", "")).replace(tzinfo=None)
                except Exception:
                    continue
                if start_dt and ts < start_dt:
                    continue
                if end_dt and ts > end_dt:
                    # CSV is chronological — stop early
                    if start_dt:
                        break
                    continue
                _accumulate_energy_row(bucket, row, ts)
        return _finalize_energy_bucket(bucket, q_start, q_end)

    days = {}
    with open(_log_file, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                ts = datetime.fromisoformat(str(row.get("timestamp", "")).replace("Z", "")).replace(tzinfo=None)
            except Exception:
                continue
            if start_dt and ts < start_dt:
                continue
            if end_dt and ts > end_dt:
                if start_dt:
                    break
                continue
            day_id = _plant_day_id(ts, hour)
            key = day_id.isoformat()
            if key not in days:
                days[key] = _new_energy_bucket()
            _accumulate_energy_row(days[key], row, ts)

    day_rows = []
    for key in sorted(days.keys()):
        win_start = datetime.fromisoformat(key) + timedelta(hours=hour)
        win_end = win_start + timedelta(hours=24)
        summary = _finalize_energy_bucket(
            days[key],
            win_start.isoformat(timespec="seconds"),
            win_end.isoformat(timespec="seconds"),
            extra={
                "plant_day": key,
                "window_start": win_start.isoformat(timespec="seconds"),
                "window_end": win_end.isoformat(timespec="seconds"),
                "day_start_hour": hour,
            },
        )
        day_rows.append(summary)

    readings = sum(d["readings"] for d in day_rows)
    pf_w = sum((d["avg_pf"] or 0) * d["readings"] for d in day_rows)
    kw_w = sum((d["avg_kw"] or 0) * d["readings"] for d in day_rows)
    first = day_rows[0] if day_rows else None
    last = day_rows[-1] if day_rows else None
    totals = {
        "readings": readings,
        "kwh_consumed": round(sum(d["kwh_consumed"] for d in day_rows), 3),
        "kvah_consumed": round(sum(d["kvah_consumed"] for d in day_rows), 3),
        "kvarh_consumed": round(sum(d["kvarh_consumed"] for d in day_rows), 3),
        "kwh_start": first["kwh_start"] if first else None,
        "kwh_end": last["kwh_end"] if last else None,
        "kvah_start": first["kvah_start"] if first else None,
        "kvah_end": last["kvah_end"] if last else None,
        "kvarh_start": first["kvarh_start"] if first else None,
        "kvarh_end": last["kvarh_end"] if last else None,
        "calc_kwh": round(sum(d["calc_kwh"] for d in day_rows), 3),
        "calc_kvah": round(sum(d["calc_kvah"] for d in day_rows), 3),
        "calc_kvarh": round(sum(d["calc_kvarh"] for d in day_rows), 3),
        "avg_pf": round(pf_w / readings, 4) if readings else None,
        "avg_kw": round(kw_w / readings, 3) if readings else None,
        "start": first["start"] if first else None,
        "end": last["end"] if last else None,
        "query_start": q_start,
        "query_end": q_end,
        "day_start_hour": hour,
        "days": len(day_rows),
    }
    return {"ok": True, "days": day_rows, "totals": totals, "day_start_hour": hour}


def _energy_from_rows(rows):
    """Legacy helper used by callers that already loaded CSV rows."""
    bucket = _new_energy_bucket()
    for row in rows:
        try:
            ts = datetime.fromisoformat(str(row.get("timestamp", "")).replace("Z", "")).replace(tzinfo=None)
        except Exception:
            continue
        _accumulate_energy_row(bucket, row, ts)
    return _finalize_energy_bucket(bucket)


@app.route("/")
def index():
    """Classic HMI — previous product (unchanged file)."""
    resp = send_from_directory(BASE_DIR, "plc_live_monitor.html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


PRO_DIR = os.path.join(BASE_DIR, "steel_ems_pro")


@app.route("/pro")
@app.route("/pro/")
def steel_ems_pro_index():
    """New market product UI — does not replace classic HMI at /."""
    resp = send_from_directory(PRO_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


@app.route("/pro/<path:asset>")
def steel_ems_pro_assets(asset: str):
    if ".." in asset or asset.startswith("/") or "\\" in asset:
        return jsonify({"ok": False, "error": "not found"}), 404
    full = os.path.join(PRO_DIR, asset)
    if not os.path.isfile(full):
        return jsonify({"ok": False, "error": "not found"}), 404
    resp = send_from_directory(PRO_DIR, asset)
    if asset.lower().endswith((".js", ".html", ".css")):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
    return resp


@app.route("/api/live")
def live():
    with _lock:
        return jsonify(dict(_latest))


@app.route("/api/history")
def history():
    start_dt = _parse_dt(request.args.get("start"))
    end_dt = _parse_dt(request.args.get("end"))
    if end_dt and len(request.args.get("end", "")) <= 10:
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
    return jsonify(_read_history(start_dt, end_dt))


@app.route("/api/energy")
def energy():
    start_dt = _parse_dt(request.args.get("start"))
    end_dt = _parse_dt(request.args.get("end"))
    if end_dt and len(request.args.get("end", "")) <= 10:
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
    summary = _scan_energy(start_dt, end_dt, group_plant_day=False)
    summary["query_start"] = request.args.get("start")
    summary["query_end"] = request.args.get("end")
    summary["log_file"] = _log_file
    return jsonify(summary)


@app.route("/api/energy/days")
def energy_days():
    """
    Day-wise 24h plant-day energy for a range or calendar month.
    Query: year+month OR start+end; day_start_hour (default 9) → e.g. 09:00 → next day 09:00.
    """
    try:
        hour = int(request.args.get("day_start_hour", 9))
    except (TypeError, ValueError):
        hour = 9
    hour = max(0, min(23, hour))

    year = request.args.get("year")
    month = request.args.get("month")
    if year and month:
        try:
            y, m = int(year), int(month)
            start_dt = datetime(y, m, 1, hour, 0, 0)
            if m == 12:
                end_dt = datetime(y + 1, 1, 1, hour, 0, 0)
            else:
                end_dt = datetime(y, m + 1, 1, hour, 0, 0)
        except ValueError:
            return jsonify({"ok": False, "error": "invalid year/month"}), 400
    else:
        start_dt = _parse_dt(request.args.get("start"))
        end_dt = _parse_dt(request.args.get("end"))
        if not start_dt or not end_dt:
            return jsonify({"ok": False, "error": "Provide year+month or start+end"}), 400
        if end_dt and len(request.args.get("end", "")) <= 10:
            end_dt = end_dt.replace(hour=23, minute=59, second=59)

    result = _scan_energy(start_dt, end_dt, group_plant_day=True, day_start_hour=hour)
    result["log_file"] = _log_file
    return jsonify(result)


@app.route("/api/energy/month.xls")
def energy_month_xls():
    """Excel-friendly CSV: full month day+time wise meter & calculated energy."""
    try:
        y = int(request.args.get("year"))
        m = int(request.args.get("month"))
        hour = int(request.args.get("day_start_hour", 9))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "year, month required"}), 400
    hour = max(0, min(23, hour))
    start_dt = datetime(y, m, 1, hour, 0, 0)
    if m == 12:
        end_dt = datetime(y + 1, 1, 1, hour, 0, 0)
    else:
        end_dt = datetime(y, m + 1, 1, hour, 0, 0)

    result = _scan_energy(start_dt, end_dt, group_plant_day=True, day_start_hour=hour)
    days = result.get("days") or []
    totals = result.get("totals") or {}

    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf)
    w.writerow(["SUGNA SPONGE AND POWER PVT LTD"])
    w.writerow(["Rolling Mill EMS · Energy meter · day & time wise"])
    w.writerow(["Month", f"{y:04d}-{m:02d}", "Plant day start hour", hour,
                "Window", f"{hour:02d}:00 → next day {hour:02d}:00"])
    w.writerow(["Generated", datetime.now().isoformat(timespec="seconds")])
    w.writerow([])
    w.writerow([
        "Plant day", "Window start", "Window end", "Samples",
        "Meter kWh start", "Meter kWh end", "Meter ΔkWh",
        "Meter kVAh start", "Meter kVAh end", "Meter ΔkVAh",
        "Meter kVArh start", "Meter kVArh end", "Meter ΔkVArh",
        "Calculated kWh", "Calculated kVAh", "Calculated kVArh",
        "Avg kW", "Avg PF",
    ])
    for d in days:
        w.writerow([
            d.get("plant_day"), d.get("window_start"), d.get("window_end"), d.get("readings"),
            d.get("kwh_start"), d.get("kwh_end"), d.get("kwh_consumed"),
            d.get("kvah_start"), d.get("kvah_end"), d.get("kvah_consumed"),
            d.get("kvarh_start"), d.get("kvarh_end"), d.get("kvarh_consumed"),
            d.get("calc_kwh"), d.get("calc_kvah"), d.get("calc_kvarh"),
            d.get("avg_kw"), d.get("avg_pf"),
        ])
    w.writerow([])
    w.writerow([
        "TOTAL", "", "", totals.get("readings"),
        totals.get("kwh_start"), totals.get("kwh_end"), totals.get("kwh_consumed"),
        totals.get("kvah_start"), totals.get("kvah_end"), totals.get("kvah_consumed"),
        totals.get("kvarh_start"), totals.get("kvarh_end"), totals.get("kvarh_consumed"),
        totals.get("calc_kwh"), totals.get("calc_kvah"), totals.get("calc_kvarh"),
        totals.get("avg_kw"), totals.get("avg_pf"),
    ])
    w.writerow([])
    w.writerow(["Notes"])
    w.writerow(["Meter Δ = end register − start register from PAC3200 log"])
    w.writerow(["Calculated = ∫ power·dt from live kW / kVA / kVAr samples (same window)"])

    # Auto-save each day reading
    try:
        path = _prod_path("ems_readings")
        with open(path, "a", encoding="utf-8") as f:
            for d in days:
                row = dict(d)
                row["savedAt"] = datetime.now().isoformat(timespec="seconds")
                row["source"] = "month-excel"
                row["year"] = y
                row["month"] = m
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        traceback.print_exc()

    filename = f"Sugna_RM_EMS_Energy_{y:04d}{m:02d}_h{hour:02d}.xls"
    return Response(
        buf.getvalue(),
        mimetype="application/vnd.ms-excel",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.route("/api/bands")
def bands_period():
    """On-load / idle / stop seconds from CSV HT kW history for a date-time range."""
    start_dt = _parse_dt(request.args.get("start"))
    end_dt = _parse_dt(request.args.get("end"))
    if end_dt and len(request.args.get("end", "")) <= 10:
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
    try:
        start_kw = float(request.args.get("start_kw", 500))
        onload_kw = float(request.args.get("onload_kw", 1600))
    except (TypeError, ValueError):
        start_kw, onload_kw = 500.0, 1600.0
    if onload_kw <= start_kw:
        onload_kw = start_kw + 1.0

    rows = _read_history(start_dt, end_dt)
    on_sec = idle_sec = stop_sec = 0.0
    on_kwh = idle_kwh = 0.0
    prev_ts = None
    samples = 0

    def _num(r, k):
        try:
            return float(r.get(k) or 0)
        except (TypeError, ValueError):
            return 0.0

    for row in rows:
        try:
            ts = datetime.fromisoformat(str(row.get("timestamp", "")).replace("Z", "")).replace(tzinfo=None)
        except Exception:
            continue
        kw = _num(row, "Total Active Power_2")
        samples += 1
        if prev_ts is not None:
            dt = (ts - prev_ts).total_seconds()
            if 0 < dt <= 120:
                dkwh = kw * dt / 3600.0
                if kw > onload_kw:
                    on_sec += dt
                    on_kwh += dkwh
                elif kw > start_kw:
                    idle_sec += dt
                    idle_kwh += dkwh
                else:
                    stop_sec += dt
        prev_ts = ts

    run = on_sec + idle_sec
    total = run + stop_sec
    util = (on_sec / run * 100.0) if run > 0 else 0.0
    avail = (run / total * 100.0) if total > 0 else 0.0
    return jsonify({
        "ok": True,
        "start": request.args.get("start"),
        "end": request.args.get("end"),
        "start_kw": start_kw,
        "onload_kw": onload_kw,
        "samples": samples,
        "on_load_sec": round(on_sec, 1),
        "idle_sec": round(idle_sec, 1),
        "stop_sec": round(stop_sec, 1),
        "run_sec": round(run, 1),
        "total_sec": round(total, 1),
        "util_pct": round(util, 2),
        "availability_pct": round(avail, 2),
        "on_load_kwh": round(on_kwh, 3),
        "idle_kwh": round(idle_kwh, 3),
        "total_kwh": round(on_kwh + idle_kwh, 3),
    })


@app.route("/api/history.csv")
def history_csv():
    start_dt = _parse_dt(request.args.get("start"))
    end_dt = _parse_dt(request.args.get("end"))
    if end_dt and len(request.args.get("end", "")) <= 10:
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
    rows = _read_history(start_dt, end_dt)
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_HEADER)
    writer.writeheader()
    for row in rows:
        writer.writerow({k: row.get(k, "") for k in CSV_HEADER})
    filename = f"pac3200_report_{request.args.get('start', 'all')}_{request.args.get('end', 'all')}.csv".replace(":", "-")
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={filename}"})


@app.route("/api/log-config", methods=["GET", "POST"])
def log_config():
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        folder = (body.get("log_dir") or "").strip()
        if not folder:
            return jsonify({"ok": False, "error": "log_dir is required"}), 400
        try:
            os.makedirs(folder, exist_ok=True)
            test_path = os.path.join(folder, ".write_test")
            with open(test_path, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(test_path)
        except Exception as exc:
            return jsonify({"ok": False, "error": f"Cannot write to folder: {exc}"}), 400
        _apply_data_dir(folder)
        _save_config()
        _ensure_log_dir_and_file()
        files, _err = _list_data_files()
        return jsonify({
            "ok": True,
            "log_dir": _log_dir,
            "log_file": _log_file,
            "mes_db": str(mes_config.DB_PATH),
            "files": files,
        })

    exists = os.path.exists(_log_file)
    rows_approx = 0
    if exists:
        try:
            with open(_log_file, "rb") as f:
                rows_approx = max(0, sum(1 for _ in f) - 1)
        except Exception:
            rows_approx = 0
    files, err = _list_data_files()
    return jsonify({
        "ok": True,
        "log_dir": _log_dir, "log_file": _log_file, "exists": exists,
        "rows_approx": rows_approx, "default_log_dir": DEFAULT_LOG_DIR,
        "mes_db": str(mes_config.DB_PATH),
        "files": files,
        "error": err,
    })


@app.route("/api/data/files")
def data_files():
    files, err = _list_data_files()
    return jsonify({
        "ok": err is None,
        "log_dir": _log_dir,
        "mes_db": str(mes_config.DB_PATH),
        "files": files,
        "error": err,
    })


@app.route("/api/data/export.zip")
def data_export_zip():
    """Download zip of energy CSV + heats + MES DB from selected folder."""
    os.makedirs(_log_dir, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in DATA_FILES:
            path = os.path.join(_log_dir, name)
            if os.path.isfile(path):
                zf.write(path, arcname=name)
        # also pack any dated backup CSVs
        try:
            for name in os.listdir(_log_dir):
                if name.startswith("pac3200_log_backup_") and name.endswith(".csv"):
                    zf.write(os.path.join(_log_dir, name), arcname=name)
        except Exception:
            pass
        meta = {
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "log_dir": _log_dir,
            "files": [f["name"] for f in _list_data_files()[0]],
        }
        zf.writestr("export_meta.json", json.dumps(meta, indent=2))
    buf.seek(0)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"plant_data_export_{stamp}.zip",
    )


@app.route("/api/data/import", methods=["POST"])
def data_import():
    """Import CCM/RM heats from uploaded JSONL (or JSON array) into the selected folder."""
    kind = (request.args.get("kind") or request.form.get("kind") or "").strip()
    if kind not in ("ccm_heats", "rm_heats"):
        return jsonify({"ok": False, "error": "kind must be ccm_heats or rm_heats"}), 400
    mode = (request.args.get("mode") or request.form.get("mode") or "append").strip().lower()
    if mode not in ("append", "replace"):
        mode = "append"

    rows = []
    if request.files.get("file"):
        raw = request.files["file"].read().decode("utf-8", errors="replace")
    else:
        body = request.get_json(silent=True)
        if isinstance(body, list):
            rows = body
            raw = None
        elif isinstance(body, dict) and isinstance(body.get("rows"), list):
            rows = body["rows"]
            raw = None
        else:
            return jsonify({"ok": False, "error": "Upload a .jsonl/.json file or JSON body"}), 400

    if raw is not None:
        text = raw.strip()
        if text.startswith("["):
            try:
                rows = json.loads(text)
            except Exception as exc:
                return jsonify({"ok": False, "error": f"Invalid JSON array: {exc}"}), 400
        else:
            for line in text.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue

    if not isinstance(rows, list) or not rows:
        return jsonify({"ok": False, "error": "No heat rows found to import"}), 400

    path = _prod_path(kind)
    existing = [] if mode == "replace" else _read_jsonl(path)
    # de-dupe by heatNo+endedAt when appending
    seen = {(r.get("heatNo"), r.get("endedAt")) for r in existing if isinstance(r, dict)}
    added = 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        key = (r.get("heatNo"), r.get("endedAt"))
        if mode == "append" and key in seen:
            continue
        r.setdefault("savedAt", datetime.now().isoformat(timespec="seconds"))
        r["_importedAt"] = datetime.now().isoformat(timespec="seconds")
        existing.append(r)
        seen.add(key)
        added += 1

    with open(path, "w", encoding="utf-8") as f:
        for r in existing:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    return jsonify({
        "ok": True,
        "kind": kind,
        "mode": mode,
        "added": added,
        "total": len(existing),
        "path": path,
    })


@app.route("/api/data/download/<path:name>")
def data_download(name):
    """Download one file from the selected data folder."""
    safe = os.path.basename(name)
    if not safe or safe.startswith(".") or ".." in name:
        return jsonify({"ok": False, "error": "invalid name"}), 400
    path = os.path.join(_log_dir, safe)
    if not os.path.isfile(path):
        return jsonify({"ok": False, "error": "file not found"}), 404
    return send_file(path, as_attachment=True, download_name=safe)


def _prod_path(kind: str) -> str:
    name = {
        "ccm_heats": "ccm_heats.jsonl",
        "rm_heats": "rm_heats.jsonl",
        "ems_readings": "ems_readings.jsonl",
        "daily_summary": "daily_production.jsonl",
    }.get(kind)
    if not name:
        raise ValueError("unknown production kind")
    os.makedirs(_log_dir, exist_ok=True)
    return os.path.join(_log_dir, name)


def _read_jsonl(path: str):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


@app.route("/api/production/reset", methods=["POST"])
def production_reset():
    """Clear saved CCM / RM production heats (jsonl + SQLite). Body: {kind: ccm|rm|both}"""
    body = request.get_json(silent=True) or {}
    kind = str(body.get("kind") or "both").strip().lower()
    if kind not in ("ccm", "rm", "both"):
        return jsonify({"ok": False, "error": "kind must be ccm, rm, or both"}), 400
    cleared_files = []
    try:
        if kind in ("ccm", "both"):
            path = _prod_path("ccm_heats")
            open(path, "w", encoding="utf-8").close()
            cleared_files.append(path)
        if kind in ("rm", "both"):
            path = _prod_path("rm_heats")
            open(path, "w", encoding="utf-8").close()
            cleared_files.append(path)
        db_cleared = {"ccm": 0, "rm": 0}
        try:
            db_cleared = mes_db.clear_production_heats(kind)
        except Exception:
            traceback.print_exc()
        return jsonify({"ok": True, "kind": kind, "files": cleared_files, "sqlite": db_cleared})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/production/<kind>", methods=["GET", "POST"])
def production_store(kind):
    try:
        path = _prod_path(kind)
    except ValueError:
        return jsonify({"ok": False, "error": "kind must be ccm_heats, rm_heats, ems_readings, or daily_summary"}), 400

    if request.method == "POST":
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"ok": False, "error": "JSON object required"}), 400
        body.setdefault("savedAt", datetime.now().isoformat(timespec="seconds"))
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(body, ensure_ascii=False) + "\n")
        # Dual-write into MES SQLite
        try:
            if kind == "ccm_heats":
                mes_db.save_ccm_heat(body)
            elif kind == "rm_heats":
                mes_db.save_rm_heat(body)
        except Exception:
            traceback.print_exc()
        return jsonify({"ok": True, "path": path})

    start = _parse_dt(request.args.get("start"))
    end = _parse_dt(request.args.get("end"))
    if end and len(request.args.get("end", "")) <= 10:
        end = end.replace(hour=23, minute=59, second=59)
    rows = _read_jsonl(path)

    def row_dt(r):
        for key in ("endedAt", "startedAt", "window_end", "window_start", "date", "savedAt", "end", "start"):
            if r.get(key):
                try:
                    return datetime.fromisoformat(str(r[key]).replace("Z", "")).replace(tzinfo=None)
                except Exception:
                    continue
        return None

    if start or end:
        filtered = []
        for r in rows:
            dt = row_dt(r)
            if dt is None:
                continue
            if start and dt < start:
                continue
            if end and dt > end:
                continue
            filtered.append(r)
        rows = filtered
    return jsonify({"ok": True, "path": path, "count": len(rows), "rows": rows})


# Serve frontend assets next to the HTML (plant_mis.js, mes_dashboard.js, …)
@app.route("/<path:asset>")
def project_assets(asset: str):
    if asset.startswith("api/") or ".." in asset or asset.startswith("/") or "\\" in asset:
        return jsonify({"ok": False, "error": "not found"}), 404
    allowed = (".js", ".css", ".html", ".png", ".svg", ".ico", ".json", ".map", ".woff", ".woff2")
    if not asset.lower().endswith(allowed):
        return jsonify({"ok": False, "error": "not found"}), 404
    full = os.path.join(BASE_DIR, asset)
    if not os.path.isfile(full):
        return jsonify({"ok": False, "error": "not found"}), 404
    resp = send_from_directory(BASE_DIR, asset)
    if asset.lower().endswith((".js", ".html", ".css")):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
    return resp


if __name__ == "__main__":
    _load_config()
    _ensure_log_dir_and_file()
    _save_config()
    db_path = mes_db.init_db(seed_users=True)
    t = threading.Thread(target=_poll_loop, daemon=True)
    t.start()
    print(f"Auto-save EVERY {POLL_INTERVAL_SECONDS}s -> {_log_dir}")
    print("  CSV :", _log_file)
    print("  JSONL:", os.path.join(_log_dir, LIVE_JSONL))
    print("MES SQLite:", db_path)
    print("Classic HMI:   http://localhost:5000/")
    print("Steel EMS Pro: http://localhost:5000/pro/")
    print("MES API:       http://localhost:5000/api/mes/health")
    print("Default users: admin/admin123 / prod/prod123 / maint/maint123 / mgmt/mgmt123")
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
