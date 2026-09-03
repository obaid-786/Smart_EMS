"""
WhatsApp Cloud API alert sender.
"""

import json
import os
import requests
import time

CONFIG_FILE = "whatsapp_config.json"

def load_config():
    """Load WhatsApp config from JSON file."""
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def send_whatsapp(message: str) -> bool:
    """Send a WhatsApp text message using Meta Cloud API."""
    cfg = load_config()
    phone_number_id = cfg.get("phone_number_id")
    access_token = cfg.get("access_token")
    recipient = cfg.get("recipient_phone")

    if not all([phone_number_id, access_token, recipient]):
        print("[WhatsApp] Not configured – skipping message.")
        return False

    url = f"https://graph.facebook.com/v17.0/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": recipient,
        "type": "text",
        "text": {"body": message}
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=10)
        if response.status_code == 200:
            print(f"[WhatsApp] Sent: {message}")
            return True
        else:
            print(f"[WhatsApp] Failed: {response.status_code} - {response.text}")
            return False
    except Exception as e:
        print(f"[WhatsApp] Error: {e}")
        return False

# Simple cooldown dictionary (module-level)
_cooldowns = {}

def send_alert_with_cooldown(alert_key: str, message: str, cooldown_sec: int = 3600):
    """Send alert only if cooldown period has passed."""
    now = time.time()
    last_sent = _cooldowns.get(alert_key, 0)
    if now - last_sent >= cooldown_sec:
        ok = send_whatsapp(message)
        if ok:
            _cooldowns[alert_key] = now
        return ok
    return False