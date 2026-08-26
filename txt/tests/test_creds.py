import base64
import json
import os
import stat

import pytest

from txt.creds import ensure_user_root_key, load_owner_creds

VALID_OWNER = {
    "rqlite_admin_username": "operator",
    "rqlite_admin_password": "secret",
    "rqlite_operator_url": "https://api.example.com/operator/rqlite",
    "rqlite_control_backup": "private/rqlite/",
    "firebase_email": "a@b.com",
    "firebase_password": "pw",
    "firebase_api_key": "key",
    "display_name": "Owner",
    "r2_config": {
        "endpoint": "https://account.r2.cloudflarestorage.com",
        "read_write_access_key_id": "rw-id",
        "read_write_secret_access_key": "rw-secret",
        "region": "auto",
        "bucket": "books",
    },
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
    assert creds.rqlite_control_backup == "private/rqlite/"


def test_load_owner_creds_ignores_legacy_extra_fields(tmp_path):
    path = tmp_path / "owner_creds.json"
    data = {**VALID_OWNER, "asset_base_url": "https://reader.example.com"}
    data["r2_config"] = {**data["r2_config"], "read_only_access_key_id": "old"}
    path.write_text(json.dumps(data))

    creds = load_owner_creds(str(path))

    assert not hasattr(creds, "asset_base_url")
    assert not hasattr(creds.r2_config, "read_only_access_key_id")


def test_load_owner_creds_rejects_service_origin_without_operator_route(tmp_path):
    path = tmp_path / "owner_creds.json"
    path.write_text(
        json.dumps({**VALID_OWNER, "rqlite_operator_url": "https://api.example.com"})
    )

    with pytest.raises(ValueError, match="end with /operator/rqlite"):
        load_owner_creds(str(path))


@pytest.mark.parametrize(
    "url",
    [
        "http://api.example.com/operator/rqlite",
        "https://user:password@api.example.com/operator/rqlite",
    ],
)
def test_load_owner_creds_rejects_unsafe_operator_urls(tmp_path, url):
    path = tmp_path / "owner_creds.json"
    path.write_text(json.dumps({**VALID_OWNER, "rqlite_operator_url": url}))

    with pytest.raises(ValueError, match="rqlite_operator_url"):
        load_owner_creds(str(path))


def test_load_owner_creds_rejects_incomplete_r2_config(tmp_path):
    path = tmp_path / "owner_creds.json"
    path.write_text(json.dumps({**VALID_OWNER, "r2_config": {"bucket": "books"}}))
    with pytest.raises(ValueError, match="Missing r2_config fields"):
        load_owner_creds(str(path))


@pytest.mark.parametrize("prefix", ["", "   ", "/control-backups/"])
def test_load_owner_creds_rejects_invalid_control_backup_prefix(tmp_path, prefix):
    path = tmp_path / "owner_creds.json"
    path.write_text(json.dumps({**VALID_OWNER, "rqlite_control_backup": prefix}))

    with pytest.raises(ValueError, match="rqlite_control_backup"):
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


def test_ensure_user_root_key_writes_owner_only_permissions(owner_creds_path):
    os.chmod(owner_creds_path, 0o644)
    ensure_user_root_key(owner_creds_path, load_owner_creds(owner_creds_path))
    assert stat.S_IMODE(os.stat(owner_creds_path).st_mode) == 0o600
