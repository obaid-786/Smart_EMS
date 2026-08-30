"""Report export helpers — CSV / Excel / summary payloads for PDF printers."""
from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Any


def shift_report_payload(
    date: str,
    shift_id: str,
    ccm: dict,
    rm: dict,
    energy: dict,
    plant: dict,
    operator: str = "",
) -> dict[str, Any]:
    return {
        "report": "shift",
        "date": date,
        "shift": shift_id,
        "operator": operator,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "ccm": ccm,
        "rm": rm,
        "energy": energy,
        "plant": plant,
    }


def to_csv(rows: list[dict], fieldnames: list[str] | None = None) -> str:
    if not rows:
        return ""
    fields = fieldnames or list(rows[0].keys())
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


def try_excel(rows: list[dict], sheet_name: str = "Report") -> bytes | None:
    """Optional openpyxl export — returns None if package missing."""
    try:
        from openpyxl import Workbook
    except ImportError:
        return None
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name[:31]
    if not rows:
        bio = io.BytesIO()
        wb.save(bio)
        return bio.getvalue()
    headers = list(rows[0].keys())
    ws.append(headers)
    for r in rows:
        ws.append([r.get(h) for h in headers])
    bio = io.BytesIO()
    wb.save(bio)
    return bio.getvalue()
