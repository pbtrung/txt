import base64
import json
import secrets
from dataclasses import dataclass
from urllib.parse import urlsplit

OWNER_REQUIRED_FIELDS = [
    "rqlite_admin_username",
    "rqlite_admin_password",
    "rqlite_operator_url",
    "firebase_email",
    "firebase_password",
    "firebase_api_key",
    "display_name",
    "r2_config",
    "slhdsa_256f_priv_key",
    "asset_base_url",
    "user_root_key",
]


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
class OwnerCreds:
    rqlite_admin_username: str
    rqlite_admin_password: str
    rqlite_operator_url: str
    firebase_email: str
    firebase_password: str
    firebase_api_key: str
    display_name: str
    r2_config: R2Config
    slhdsa_256f_priv_key: str
    asset_base_url: str
    user_root_key: str


def load_owner_creds(path: str) -> OwnerCreds:
    data = _read_json(path)
    missing = [key for key in OWNER_REQUIRED_FIELDS if key not in data]
    if missing:
        raise ValueError(f"Missing fields in creds.json: {', '.join(missing)}")
    values = {key: data[key] for key in OWNER_REQUIRED_FIELDS if key != "r2_config"}
    values["rqlite_operator_url"] = _operator_url(values["rqlite_operator_url"])
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
        raise ValueError("rqlite_operator_url must be an HTTP(S) URL")
    parsed = urlsplit(value)
    valid_path = parsed.path.rstrip("/") == "/operator/rqlite"
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not valid_path:
        raise ValueError(
            "rqlite_operator_url must end with /operator/rqlite, without an API path"
        )
    if parsed.query or parsed.fragment:
        raise ValueError("rqlite_operator_url must not contain a query or fragment")
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
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
