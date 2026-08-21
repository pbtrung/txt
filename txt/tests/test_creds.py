import base64
import json

import pytest

from txt.creds import ensure_user_root_key, load_owner_creds

VALID_OWNER = {
    "rqlite_admin_username": "operator",
    "rqlite_admin_password": "secret",
    "rqlite_operator_url": "https://api.example.com/operator/rqlite",
    "firebase_email": "a@b.com",
    "firebase_password": "pw",
    "firebase_api_key": "key",
    "display_name": "Owner",
    "r2_config": {
        "endpoint": "https://account.r2.cloudflarestorage.com",
        "read_only_access_key_id": "ro-id",
        "read_only_secret_access_key": "ro-secret",
        "read_write_access_key_id": "rw-id",
        "read_write_secret_access_key": "rw-secret",
        "region": "auto",
        "bucket": "books",
    },
    "slhdsa_256f_priv_key": "",
    "asset_base_url": "https://reader.example.com",
    "user_root_key": "",
}


@pytest.fixture
def owner_creds_path(tmp_path):
    path = tmp_path / "owner_creds.json"
    path.write_text(json.dumps(VALID_OWNER))
    return str(path)


def test_load_owner_creds_rejects_missing_fields(tmp_path):
    path = tmp_path / "owner_creds.json"
    path.write_text(json.dumps({"firebase_email": "a@b.com"}))
    with pytest.raises(ValueError):
        load_owner_creds(str(path))


def test_load_owner_creds_reads_operator_and_deployment_fields(owner_creds_path):
    creds = load_owner_creds(owner_creds_path)
    assert creds.firebase_email == "a@b.com"
    assert creds.rqlite_admin_username == "operator"
    assert creds.rqlite_operator_url.endswith("/operator/rqlite")
    assert creds.asset_base_url == "https://reader.example.com"
    assert creds.slhdsa_256f_priv_key == ""


def test_load_owner_creds_rejects_service_origin_without_operator_route(tmp_path):
    path = tmp_path / "owner_creds.json"
    path.write_text(
        json.dumps({**VALID_OWNER, "rqlite_operator_url": "https://api.example.com"})
    )

    with pytest.raises(ValueError, match="must end with /operator/rqlite"):
        load_owner_creds(str(path))


def test_load_owner_creds_rejects_incomplete_r2_config(tmp_path):
    path = tmp_path / "owner_creds.json"
    path.write_text(json.dumps({**VALID_OWNER, "r2_config": {"bucket": "books"}}))
    with pytest.raises(ValueError, match="Missing r2_config fields"):
        load_owner_creds(str(path))


def test_ensure_user_root_key_generates_256_bytes(owner_creds_path):
    creds = ensure_user_root_key(owner_creds_path, load_owner_creds(owner_creds_path))
    assert len(base64.b64decode(creds.user_root_key)) == 256


def test_ensure_user_root_key_persists_to_file(owner_creds_path):
    creds = ensure_user_root_key(owner_creds_path, load_owner_creds(owner_creds_path))
    with open(owner_creds_path) as f:
        saved = json.load(f)
    assert saved["user_root_key"] == creds.user_root_key
    assert saved["display_name"] == "Owner"


def test_ensure_user_root_key_never_overwrites(owner_creds_path):
    first = ensure_user_root_key(
        owner_creds_path, load_owner_creds(owner_creds_path)
    ).user_root_key
    second = ensure_user_root_key(
        owner_creds_path, load_owner_creds(owner_creds_path)
    ).user_root_key
    assert first == second
