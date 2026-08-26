import base64
import json
import os
import secrets
from dataclasses import dataclass
from urllib.parse import urlsplit

OWNER_REQUIRED_FIELDS = [
    "rqlite_admin_username",
    "rqlite_admin_password",
    "rqlite_operator_url",
    "rqlite_control_backup",
    "firebase_email",
    "firebase_password",
    "firebase_api_key",
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
    rqlite_admin_username: str
    rqlite_admin_password: str
    rqlite_operator_url: str
    rqlite_control_backup: str
    firebase_email: str
    firebase_password: str
    firebase_api_key: str
    display_name: str
    r2_config: R2Config
    user_root_key: str


def load_owner_creds(path: str) -> OwnerCreds:
    data = _read_json(path)
    missing = [key for key in OWNER_REQUIRED_FIELDS if key not in data]
    if missing:
        raise ValueError(f"Missing fields in creds.json: {', '.join(missing)}")
    values = {key: data[key] for key in OWNER_REQUIRED_FIELDS if key != "r2_config"}
    values["rqlite_operator_url"] = _operator_url(values["rqlite_operator_url"])
    values["rqlite_control_backup"] = _r2_prefix(values["rqlite_control_backup"])
    return OwnerCreds(**values, r2_config=_require_r2_config(data["r2_config"]))


def _require_r2_config(value: object) -> R2Config:
    if not isinstance(value, dict):
        raise ValueError("r2_config must be an object")
    missing = [name for name in R2Config.__annotations__ if name not in value]
    if missing:
        raise ValueError(f"Missing r2_config fields: {', '.join(missing)}")
    return R2Config(**{name: value[name] for name in R2Config.__annotations__})


def _operator_url(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("rqlite_operator_url must be a valid operator URL")
    parsed = urlsplit(value)
    _validate_operator_location(parsed)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("rqlite_operator_url must not contain embedded credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("rqlite_operator_url must not contain a query or fragment")
    return value


def _validate_operator_location(parsed) -> None:
    local = parsed.hostname in {"127.0.0.1", "localhost"}
    secure = parsed.scheme == "https" or (local and parsed.scheme == "http")
    valid_path = parsed.path.rstrip("/") == "/operator/rqlite"
    if secure and parsed.netloc and valid_path:
        return
    raise ValueError(
        "rqlite_operator_url must use HTTPS and end with /operator/rqlite; "
        "localhost HTTP is allowed for development"
    )


def _r2_prefix(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or value.startswith("/"):
        raise ValueError(
            "rqlite_control_backup must be a non-empty R2 object-key prefix "
            "relative to the bucket"
        )
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
