"""HMD cascade tracker — miss-roll localization, delay, stuck, sensor failure."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from mes.config import HMD_LINE
from mes.database import db as database

RM_STAGES = [s for s in HMD_LINE if s["area"] == "rm"]


@dataclass
class HmdSnapshot:
    ts: str
    counts: dict[str, int]
    bits: dict[str, bool]
    alarms: list[dict] = field(default_factory=list)
    losses: list[dict] = field(default_factory=list)


class HmdTracker:
    """Tracks counter deltas and localizes production loss between HMDs."""

    def __init__(self):
        self.prev_counts: Optional[dict[str, int]] = None
        self.prev_bits: Optional[dict[str, bool]] = None
        self.prev_ts: Optional[datetime] = None
        self.stuck_since: dict[str, datetime] = {}
        self.delay_since: dict[str, datetime] = {}
        self.last_snapshot: Optional[HmdSnapshot] = None
        self._last_hmd_persist: Optional[datetime] = None
        self._last_alarm_at: dict[str, datetime] = {}
        self._alarm_cooldown_sec = 60
        self._hmd_persist_sec = 5
        self.delay_timeout_sec = 90

    def _can_alarm(self, code: str, now: datetime) -> bool:
        last = self._last_alarm_at.get(code)
        if last and (now - last).total_seconds() < self._alarm_cooldown_sec:
            return False
        self._last_alarm_at[code] = now
        return True

    def ingest(self, plc_data: dict) -> HmdSnapshot:
        now = datetime.now()
        ts = now.isoformat(timespec="seconds")
        counts: dict[str, int] = {}
        bits: dict[str, bool] = {}
        for stage in HMD_LINE:
            ctag, htag = stage["count"], stage["hmd"]
            if ctag in plc_data and plc_data[ctag] is not None:
                try:
                    counts[stage["id"]] = int(plc_data[ctag])
                except (TypeError, ValueError):
                    counts[stage["id"]] = 0
            if htag in plc_data:
                bits[stage["id"]] = bool(plc_data[htag])

        alarms: list[dict] = []
        losses: list[dict] = []

        for i in range(len(RM_STAGES) - 1):
            a, b = RM_STAGES[i], RM_STAGES[i + 1]
            if a["id"] not in counts or b["id"] not in counts:
                continue
            ca, cb = counts.get(a["id"], 0), counts.get(b["id"], 0)
            gap = ca - cb
            if gap > 0:
                losses.append({
                    "from": a["id"], "to": b["id"],
                    "from_label": a["label"], "to_label": b["label"],
                    "lost": gap,
                })
                key = f"{a['id']}>{b['id']}"
                if self.prev_counts is not None:
                    d_up = ca - self.prev_counts.get(a["id"], ca)
                    d_dn = cb - self.prev_counts.get(b["id"], cb)
                    if d_up > 0 and d_dn == 0 and gap >= 2:
                        since = self.delay_since.get(key) or now
                        self.delay_since[key] = since
                        if (now - since).total_seconds() >= self.delay_timeout_sec:
                            if self._can_alarm(f"DELAY_{key}", now):
                                alarms.append({
                                    "severity": "caution", "code": "BILLET_DELAY",
                                    "area": "rm",
                                    "message": (
                                        f"Billet delay {a['label']} → {b['label']} "
                                        f"(>{self.delay_timeout_sec}s, gap {gap})"
                                    ),
                                    "value": gap,
                                    "meta": {"from": a["id"], "to": b["id"]},
                                })
                    else:
                        self.delay_since.pop(key, None)

        r3, tmt = counts.get("r3", 0), counts.get("tmt", 0)
        miss = max(0, r3 - tmt)
        if miss > 0 and self._can_alarm("MISS_ROLL", now):
            alarms.append({
                "severity": "caution" if miss < 5 else "alarm",
                "code": "MISS_ROLL", "area": "rm",
                "message": f"Miss-roll R3−TMT = {miss} pcs",
                "value": miss,
            })

        if self.prev_counts is not None:
            for stage in HMD_LINE:
                sid = stage["id"]
                d = counts.get(sid, 0) - self.prev_counts.get(sid, 0)
                prev_on = bool(self.prev_bits.get(sid)) if self.prev_bits else False
                if d > 0 and not bits.get(sid) and not prev_on:
                    if self._can_alarm(f"SENSOR_{sid}", now):
                        alarms.append({
                            "severity": "caution", "code": "SENSOR_FAIL",
                            "area": stage["area"],
                            "message": (
                                f"Sensor anomaly at {stage['label']}: "
                                f"count +{d} without HMD pulse"
                            ),
                            "value": sid,
                        })
                if bits.get(sid) and d == 0:
                    since = self.stuck_since.get(sid) or now
                    self.stuck_since[sid] = since
                    if (now - since).total_seconds() > 120 and self._can_alarm(f"STUCK_{sid}", now):
                        alarms.append({
                            "severity": "caution", "code": "BILLET_STUCK",
                            "area": stage["area"],
                            "message": (
                                f"Possible stuck billet at {stage['label']} "
                                f"(>120s HMD ON, no count)"
                            ),
                            "value": sid,
                        })
                else:
                    self.stuck_since.pop(sid, None)

        if losses:
            worst = max(losses, key=lambda x: x["lost"])
            if worst["lost"] >= 2 and self._can_alarm("LOSS_SEGMENT", now):
                alarms.append({
                    "severity": "alarm", "code": "LOSS_SEGMENT",
                    "area": "rm",
                    "message": (
                        f"Production loss {worst['lost']} pcs between "
                        f"{worst['from_label']} → {worst['to_label']}"
                    ),
                    "value": worst["lost"], "meta": worst,
                })

        for a in alarms:
            try:
                database.insert_alarm(
                    a["severity"], a["message"], area=a.get("area", "rm"),
                    code=a.get("code", ""), value=a.get("value"), meta=a.get("meta"),
                )
            except Exception:
                pass

        snap = HmdSnapshot(ts=ts, counts=counts, bits=bits, alarms=alarms, losses=losses)
        self.prev_counts = counts
        self.prev_bits = bits
        self.prev_ts = now
        self.last_snapshot = snap

        if (self._last_hmd_persist is None or
                (now - self._last_hmd_persist).total_seconds() >= self._hmd_persist_sec):
            try:
                database.insert_hmd(ts, counts, bits)
                self._last_hmd_persist = now
            except Exception:
                pass
        return snap

    def kpis(self) -> dict[str, Any]:
        c = (self.last_snapshot.counts if self.last_snapshot else {}) or {}
        r3, tmt = c.get("r3", 0), c.get("tmt", 0)
        entry = c.get("entry", 0)
        miss = max(0, r3 - tmt)
        yield_pct = (tmt / r3 * 100.0) if r3 > 0 else 0.0
        ccm_s1, ccm_s2 = c.get("ccm_s1", 0), c.get("ccm_s2", 0)
        return {
            "received": entry,
            "at_r3": r3,
            "finished": tmt,
            "miss_roll": miss,
            "miss_pct": (miss / r3 * 100.0) if r3 > 0 else 0.0,
            "yield_pct": yield_pct,
            "ccm_s1": ccm_s1,
            "ccm_s2": ccm_s2,
            "ccm_billets": ccm_s1 + ccm_s2,
            "counts": c,
            "bits": (self.last_snapshot.bits if self.last_snapshot else {}),
            "losses": (self.last_snapshot.losses if self.last_snapshot else []),
            "alarms": (self.last_snapshot.alarms if self.last_snapshot else []),
            "line": [{"id": s["id"], "label": s["label"], "area": s["area"]} for s in HMD_LINE],
        }
