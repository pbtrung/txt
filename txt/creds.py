import base64
import json
import os
import secrets
from dataclasses import dataclass

OWNER_REQUIRED_FIELDS = [
    "owner_email",
    "cf_account_id",
    "cf_d1_database_id",
    "cf_d1_api_token",
    "display_name",
    "r2_config",
    "user_root_key",
]


@dataclass
class R2Config:
    endpoint: str
    read_write_access_key_id: str
    read_write_secret_access_key: str
    region: str
    bucket: str


@dataclass
class OwnerCreds:
    owner_email: str
    cf_account_id: str
    cf_d1_database_id: str
    cf_d1_api_token: str
    display_name: str
    r2_config: R2Config
    user_root_key: str


def load_owner_creds(path: str) -> OwnerCreds:
    data = _read_json(path)
    missing = [key for key in OWNER_REQUIRED_FIELDS if key not in data]
    if missing:
        raise ValueError(f"Missing fields in creds.json: {', '.join(missing)}")
    values = {key: data[key] for key in OWNER_REQUIRED_FIELDS if key != "r2_config"}
    values["owner_email"] = _require_owner_email(values["owner_email"])
    for field in ("cf_account_id", "cf_d1_database_id", "cf_d1_api_token"):
        values[field] = _require_nonempty(field, values[field])
    return OwnerCreds(**values, r2_config=_require_r2_config(data["r2_config"]))


def _require_r2_config(value: object) -> R2Config:
    if not isinstance(value, dict):
        raise ValueError("r2_config must be an object")
    missing = [name for name in R2Config.__annotations__ if name not in value]
    if missing:
        raise ValueError(f"Missing r2_config fields: {', '.join(missing)}")
    return R2Config(**{name: value[name] for name in R2Config.__annotations__})


def _require_owner_email(value: object) -> str:
    if not isinstance(value, str) or "@" not in value or value != value.strip():
        raise ValueError("owner_email must be a valid email address")
    return value


def _require_nonempty(name: str, value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value


def ensure_user_root_key(path: str, creds: OwnerCreds) -> OwnerCreds:
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
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
