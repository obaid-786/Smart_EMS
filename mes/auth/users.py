"""Role-based authentication for MES dashboard."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta
from typing import Optional

from mes.database import db as database

_SESSIONS: dict[str, dict] = {}
SESSION_HOURS = 12


def hash_password(password: str, salt: Optional[str] = None) -> str:
    salt = salt or secrets.token_hex(8)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, _ = stored.split("$", 1)
    except ValueError:
        return False
    return hmac.compare_digest(hash_password(password, salt), stored)


def login(username: str, password: str) -> Optional[dict]:
    database.init_db()
    rows = database.query_rows(
        "SELECT id,username,password_hash,role,full_name,active FROM users WHERE username=?",
        (username,),
    )
    if not rows or not rows[0]["active"]:
        return None
    user = rows[0]
    if not verify_password(password, user["password_hash"]):
        return None
    token = secrets.token_urlsafe(32)
    _SESSIONS[token] = {
        "user_id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "full_name": user["full_name"],
        "expires": datetime.utcnow() + timedelta(hours=SESSION_HOURS),
    }
    return {
        "token": token,
        "username": user["username"],
        "role": user["role"],
        "full_name": user["full_name"],
    }


def logout(token: str):
    _SESSIONS.pop(token or "", None)


def session_user(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    s = _SESSIONS.get(token)
    if not s:
        return None
    if s["expires"] < datetime.utcnow():
        _SESSIONS.pop(token, None)
        return None
    return s


ROLES_CAN_WRITE = {"admin", "production"}
ROLES_CAN_MAINT = {"admin", "maintenance", "production"}
ROLES_CAN_VIEW_COST = {"admin", "management"}
