import os
import re
import json
import base64
from .constants import MASTER_KEY_LEN, PART_TARGET


def split_parts(content: bytes, target: int = PART_TARGET) -> list[bytes]:
    paras = re.split(rb"\r?\n\r?\n", content)
    parts, cur = [], b""
    for p in paras:
        chunk = p + b"\n\n"
        if cur and len(cur) + len(chunk) > target:
            parts.append(cur)
            cur = chunk
        else:
            cur += chunk
    if cur:
        parts.append(cur)
    return parts


def load_creds(path: str) -> dict:
    with open(path) as f:
        creds = json.load(f)
    url = os.environ.get("TURSO_DATABASE_URL") or creds.get("turso_database_url")
    token = os.environ.get("TURSO_AUTH_TOKEN") or creds.get("turso_auth_token")
    if not url or not token:
        raise ValueError("Missing Turso URL or auth token in creds or environment")
    creds["turso_database_url"] = url
    creds["turso_auth_token"] = token
    return creds


def get_master_key(creds: dict) -> bytes:
    raw = creds.get("master_key", "")
    if not raw:
        raise ValueError("No master_key in credentials; run --gen-master-key first")
    key = base64.b64decode(raw)
    if len(key) != MASTER_KEY_LEN:
        raise ValueError(f"master_key must be {MASTER_KEY_LEN} bytes, got {len(key)}")
    return key
