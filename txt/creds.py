import base64
import json
import secrets
from dataclasses import dataclass

REQUIRED_FIELDS = [
    "turso_org_token",
    "turso_ctl_db_name",
    "turso_ctl_db_url",
    "firebase_email",
    "firebase_password",
    "firebase_api_key",
]

OPTIONAL_FIELDS = ["display_name", "user_root_key"]

# Browser credentials use this reduced shape rather than the maintenance
# CLI's full Creds, matching ui/src/data/creds.ts's BrowserCreds exactly.
USER_REQUIRED_FIELDS = [
    "firebase_email",
    "firebase_password",
    "firebase_api_key",
]

# display_name is set here at provisioning time (by whoever creates this
# file for the new user) purely so --init-user has somewhere to read it
# from; the browser itself never reads it back out of its own creds.json
# -- it gets display_name from the decrypted cred_store payload instead.
USER_OPTIONAL_FIELDS = ["display_name", "user_root_key"]


@dataclass
class R2Config:
    endpoint: str
    read_only_access_key_id: str
    read_only_secret_access_key: str
    read_write_access_key_id: str
    read_write_secret_access_key: str
    region: str
    bucket: str


@dataclass
class Creds:
    turso_org_token: str
    turso_ctl_db_name: str
    turso_ctl_db_url: str
    firebase_email: str
    firebase_password: str
    firebase_api_key: str
    display_name: str = ""
    user_root_key: str = ""
    r2_config: R2Config | None = None


@dataclass
class UserCreds:
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
    creds = Creds(**{k: data.get(k, "") for k in fields})
    creds.r2_config = _parse_r2_config(data.get("r2_config"))
    return creds


def load_user_creds(path: str) -> UserCreds:
    data = _read_json(path)
    missing = [k for k in USER_REQUIRED_FIELDS if k not in data]
    if missing:
        raise ValueError(f"Missing fields in creds.json: {', '.join(missing)}")
    fields = USER_REQUIRED_FIELDS + USER_OPTIONAL_FIELDS
    return UserCreds(**{k: data.get(k, "") for k in fields})


def _parse_r2_config(value: dict | None) -> R2Config | None:
    return R2Config(**value) if value else None


def ensure_user_root_key(path: str, creds: Creds | UserCreds) -> Creds | UserCreds:
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
