import base64
import json

import pytest

from txt.creds import ensure_user_root_key, load_creds

VALID = {
    "turso_org_token": "tok",
    "turso_ctl_db_url": "libsql://ctl-x.aws-us-east-1.turso.io",
    "turso_group": "g",
    "turso_org": "x",
    "firebase_email": "a@b.com",
    "firebase_password": "pw",
    "firebase_api_key": "key",
}


@pytest.fixture
def creds_path(tmp_path):
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(VALID))
    return str(path)


def test_load_creds_rejects_missing_fields(tmp_path):
    path = tmp_path / "creds.json"
    path.write_text(json.dumps({"turso_org_token": "x"}))
    with pytest.raises(ValueError):
        load_creds(str(path))


def test_load_creds_defaults_optional_fields(creds_path):
    creds = load_creds(creds_path)
    assert creds.display_name == ""
    assert creds.user_root_key == ""


def test_ensure_user_root_key_generates_256_bytes(creds_path):
    creds = ensure_user_root_key(creds_path, load_creds(creds_path))
    assert len(base64.b64decode(creds.user_root_key)) == 256


def test_ensure_user_root_key_persists_to_file(creds_path):
    creds = ensure_user_root_key(creds_path, load_creds(creds_path))
    with open(creds_path) as f:
        saved = json.load(f)
    assert saved["user_root_key"] == creds.user_root_key
    assert saved["turso_org_token"] == "tok"


def test_ensure_user_root_key_never_overwrites(creds_path):
    first = ensure_user_root_key(creds_path, load_creds(creds_path)).user_root_key
    second = ensure_user_root_key(creds_path, load_creds(creds_path)).user_root_key
    assert first == second
