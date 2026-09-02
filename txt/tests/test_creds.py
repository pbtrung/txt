import base64
import json
import os
import stat

import pytest

from txt.creds import ensure_user_root_key, load_owner_creds

VALID_OWNER = {
    "owner_email": "owner@example.com",
    "cf_account_id": "acct123",
    "cf_d1_database_id": "db456",
    "cf_d1_api_token": "token789",
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
    path.write_text(json.dumps({"owner_email": "a@b.com"}))
    with pytest.raises(ValueError):
        load_owner_creds(str(path))


def test_load_owner_creds_reads_owner_and_d1_fields(owner_creds_path):
    creds = load_owner_creds(owner_creds_path)
    assert creds.owner_email == "owner@example.com"
    assert creds.cf_account_id == "acct123"
    assert creds.cf_d1_database_id == "db456"
    assert creds.cf_d1_api_token == "token789"


def test_load_owner_creds_ignores_legacy_extra_fields(tmp_path):
    path = tmp_path / "owner_creds.json"
    data = {**VALID_OWNER, "asset_base_url": "https://reader.example.com"}
    data["r2_config"] = {**data["r2_config"], "read_only_access_key_id": "old"}
    path.write_text(json.dumps(data))

    creds = load_owner_creds(str(path))

    assert not hasattr(creds, "asset_base_url")
    assert not hasattr(creds.r2_config, "read_only_access_key_id")


def test_load_owner_creds_rejects_malformed_owner_email(tmp_path):
    path = tmp_path / "owner_creds.json"
    path.write_text(json.dumps({**VALID_OWNER, "owner_email": "not-an-email"}))

    with pytest.raises(ValueError, match="owner_email"):
        load_owner_creds(str(path))


@pytest.mark.parametrize(
    "field", ["cf_account_id", "cf_d1_database_id", "cf_d1_api_token"]
)
def test_load_owner_creds_rejects_empty_cloudflare_fields(tmp_path, field):
    path = tmp_path / "owner_creds.json"
    path.write_text(json.dumps({**VALID_OWNER, field: "  "}))

    with pytest.raises(ValueError, match=field):
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


def test_ensure_user_root_key_writes_owner_only_permissions(owner_creds_path):
    os.chmod(owner_creds_path, 0o644)
    ensure_user_root_key(owner_creds_path, load_owner_creds(owner_creds_path))
    assert stat.S_IMODE(os.stat(owner_creds_path).st_mode) == 0o600
