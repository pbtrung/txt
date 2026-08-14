import base64
import json
import secrets
from dataclasses import dataclass

REQUIRED_FIELDS = [
    "turso_org_token",
    "turso_ctl_db_url",
    "turso_group",
    "turso_org",
    "firebase_email",
    "firebase_password",
    "firebase_api_key",
]

OPTIONAL_FIELDS = ["display_name", "user_root_key"]


@dataclass
class Creds:
    turso_org_token: str
    turso_ctl_db_url: str
    turso_group: str
    turso_org: str
    firebase_email: str
    firebase_password: str
    firebase_api_key: str
    display_name: str = ""
    user_root_key: str = ""


def load_creds(path: str) -> Creds:
    data = _read_json(path)
    missing = [k for k in REQUIRED_FIELDS if k not in data]
    if missing:
        raise ValueError(f"Missing fields in creds.json: {', '.join(missing)}")
    fields = REQUIRED_FIELDS + OPTIONAL_FIELDS
    return Creds(**{k: data.get(k, "") for k in fields})


def ensure_user_root_key(path: str, creds: Creds) -> Creds:
    if creds.user_root_key:
        return creds
    creds.user_root_key = base64.b64encode(secrets.token_bytes(256)).decode()
    data = _read_json(path)
    data["user_root_key"] = creds.user_root_key
    _write_json(path, data)
    return creds


def _read_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _write_json(path: str, data: dict) -> None:
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
