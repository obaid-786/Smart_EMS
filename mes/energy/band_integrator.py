"""Server-side HT kW band integrator — mill start / idle / on-load timers & kWh.

Mirrors plant floor logic:
  kW <= start_thr        → STOPPED
  start_thr < kW <= onl  → IDLE RUN (mill started)
  kW > onl               → ON LOAD
"""
from __future__ import annotations

import time
from typing import Any


class BandIntegrator:
    def __init__(self, start_kw: float = 500.0, onload_kw: float = 1600.0):
        self.start_kw = float(start_kw)
        self.onload_kw = float(onload_kw)
        if self.onload_kw <= self.start_kw:
            self.onload_kw = self.start_kw + 1.0
        self._last_ts: float | None = None
        self.reset_session()

    def reset_session(self):
        self.on_load_sec = 0.0
        self.idle_sec = 0.0
        self.stop_sec = 0.0
        self.on_load_kwh = 0.0
        self.idle_kwh = 0.0
        self.total_kwh = 0.0
        self.mode = "stop"
        self.last_kw = 0.0

    def set_thresholds(self, start_kw: float | None = None, onload_kw: float | None = None):
        if start_kw is not None:
            self.start_kw = float(start_kw)
        if onload_kw is not None:
            self.onload_kw = float(onload_kw)
        if self.onload_kw <= self.start_kw:
            self.onload_kw = self.start_kw + 1.0

    def band(self, kw: float) -> str:
        if kw > self.onload_kw:
            return "onload"
        if kw > self.start_kw:
            return "idle"
        return "stop"

    def tick(self, kw: float, now: float | None = None) -> dict[str, Any]:
        now = now if now is not None else time.time()
        kw = max(0.0, float(kw or 0))
        self.last_kw = kw
        mode = self.band(kw)
        self.mode = mode
        if self._last_ts is None:
            self._last_ts = now
            return self.snapshot()
        dt = min(5.0, max(0.0, now - self._last_ts))
        self._last_ts = now
        if dt <= 0:
            return self.snapshot()
        d_kwh = kw * dt / 3600.0
        if mode == "stop":
            self.stop_sec += dt
        elif mode == "onload":
            self.on_load_sec += dt
            self.on_load_kwh += d_kwh
            self.total_kwh += d_kwh
        else:
            self.idle_sec += dt
            self.idle_kwh += d_kwh
            self.total_kwh += d_kwh
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        run = self.on_load_sec + self.idle_sec
        util = (self.on_load_sec / run * 100.0) if run > 0 else 0.0
        return {
            "mode": self.mode,
            "kw": round(self.last_kw, 2),
            "start_kw": self.start_kw,
            "onload_kw": self.onload_kw,
            "on_load_sec": round(self.on_load_sec, 1),
            "idle_sec": round(self.idle_sec, 1),
            "stop_sec": round(self.stop_sec, 1),
            "run_sec": round(run, 1),
            "util_pct": round(util, 2),
            "on_load_kwh": round(self.on_load_kwh, 3),
            "idle_kwh": round(self.idle_kwh, 3),
            "total_kwh": round(self.total_kwh, 3),
            "availability_pct": round(
                (run / (run + self.stop_sec) * 100.0) if (run + self.stop_sec) > 0 else 0.0, 2
            ),
        }
