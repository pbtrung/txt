from dataclasses import dataclass
import json

REQUIRED_FIELDS = [
    "turso_org_token",
    "turso_ctl_db_url",
    "turso_group",
    "turso_org",
    "firebase_email",
    "firebase_password",
    "firebase_api_key",
]


@dataclass
class Creds:
    turso_org_token: str
    turso_ctl_db_url: str
    turso_group: str
    turso_org: str
    firebase_email: str
    firebase_password: str
    firebase_api_key: str


def load_creds(path: str) -> Creds:
    with open(path) as f:
        data = json.load(f)
    missing = [k for k in REQUIRED_FIELDS if k not in data]
    if missing:
        raise ValueError(f"Missing fields in creds.json: {', '.join(missing)}")
    return Creds(**{k: data[k] for k in REQUIRED_FIELDS})
