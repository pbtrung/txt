import base64
import json
import secrets

import pytest

import txt.account_session as account_session_module
import txt.clean_bucket as clean_bucket_module
from txt.clean_bucket import BucketCleaner
from txt.creds import load_creds
from txt.crypto_blob import CryptoBlob

CTL_URL = "libsql://ctl-x.aws-us-east-1.turso.io"
DB_PATH = "0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghj"
AA_URL = f"libsql://{DB_PATH}-x.aws-us-east-1.turso.io"


class NullLogger:
    def verbose(self, message):
        pass

    def info(self, message):
        pass


class FakeFirebaseAuth:
    def __init__(self, api_key):
        pass

    def sign_in(self, email, password):
        return "admin-uid"


class FakeTursoClient:
    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        return f"token-for-{db_name}"

    def create_database(self, name, group):
        return {}


class FakeLibsqlClient:
    preset = {}
    instances = {}

    def __init__(self, url, token):
        self.url = url
        self.calls = []
        FakeLibsqlClient.instances[url] = self

    def execute(self, sql, args=None):
        self.calls.append(("execute", " ".join(sql.split()), args))
        return {}

    def query(self, sql, args=None):
        self.calls.append(("query", " ".join(sql.split()), args))
        for needle, rows in FakeLibsqlClient.preset.get(self.url, {}).items():
            if needle in sql:
                return rows
        return []


class FakeR2Client:
    instances = []

    def __init__(self, config):
        self.deleted = []
        FakeR2Client.instances.append(self)

    def list_common_prefixes(self, prefix="", delimiter="/"):
        return FakeR2Client.prefixes

    def list_keys(self, prefix):
        return FakeR2Client.keys_by_prefix.get(prefix, [])

    def delete_keys(self, keys):
        self.deleted.extend(keys)


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(account_session_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(account_session_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(account_session_module, "LibsqlClient", FakeLibsqlClient)
    monkeypatch.setattr(clean_bucket_module, "LibsqlClient", FakeLibsqlClient)
    monkeypatch.setattr(clean_bucket_module, "R2Client", FakeR2Client)
    FakeLibsqlClient.preset = {CTL_URL: {"SELECT db_path, type": [[DB_PATH, "admin"]]}}
    FakeLibsqlClient.instances = {}
    FakeR2Client.instances = []
    FakeR2Client.prefixes = []
    FakeR2Client.keys_by_prefix = {}
    yield


@pytest.fixture
def account(engine, tmp_path):
    blob = CryptoBlob(engine)
    root_key = secrets.token_bytes(256)
    umk = secrets.token_bytes(128)
    wrapped_umk = blob.encrypt(umk, root_key)

    data = {
        "turso_org_token": "tok", "turso_ctl_db_url": CTL_URL, "turso_group": "g",
        "turso_org": "x", "firebase_email": "admin@x.com", "firebase_password": "pw",
        "firebase_api_key": "key", "user_root_key": base64.b64encode(root_key).decode(),
        "r2_config": {
            "endpoint": "https://x.r2.cloudflarestorage.com", "read_only_access_key_id": "ro",
            "read_only_secret_access_key": "ro-secret", "read_write_access_key_id": "rw",
            "read_write_secret_access_key": "rw-secret", "region": "auto", "bucket": "my-bucket",
        },
    }
    creds_path = tmp_path / "creds.json"
    creds_path.write_text(json.dumps(data))

    FakeLibsqlClient.preset[AA_URL] = {"SELECT umk FROM key_store": [[wrapped_umk]]}
    return str(creds_path), blob, umk


def _cred_store_rows(blob, umk, entries):
    """entries: list of (user_id, db_prefix, payload_user_id_override)."""
    rows = []
    for user_id, db_prefix, payload_user_id in entries:
        payload = {"user_id": payload_user_id, "display_name": "x", "db_master_key": "y", "db_prefix": db_prefix}
        rows.append([user_id, blob.encrypt_json(payload, umk)])
    return rows


def test_known_prefixes_survive(account):
    creds_path, blob, umk = account
    FakeLibsqlClient.preset[CTL_URL]["SELECT id, db_path, type"] = [
        ["admin-uid", DB_PATH, "admin"], ["user-1", "userdbpath", "user"],
    ]
    FakeLibsqlClient.preset[AA_URL]["SELECT user_id, content"] = _cred_store_rows(
        blob, umk, [("admin-uid", "admin-prefix", "admin-uid"), ("user-1", "user-1-prefix", "user-1")]
    )
    FakeR2Client.prefixes = ["admin-prefix/", "user-1-prefix/"]

    BucketCleaner(load_creds(creds_path), dry_run=False, logger=NullLogger()).run()

    assert FakeR2Client.instances[-1].deleted == []


def test_unknown_prefix_deleted_in_real_mode(account):
    creds_path, blob, umk = account
    FakeLibsqlClient.preset[CTL_URL]["SELECT id, db_path, type"] = [["admin-uid", DB_PATH, "admin"]]
    FakeLibsqlClient.preset[AA_URL]["SELECT user_id, content"] = _cred_store_rows(
        blob, umk, [("admin-uid", "admin-prefix", "admin-uid")]
    )
    FakeR2Client.prefixes = ["admin-prefix/", "orphan-prefix/"]
    FakeR2Client.keys_by_prefix = {"orphan-prefix/": ["orphan-prefix/a", "orphan-prefix/b"]}

    BucketCleaner(load_creds(creds_path), dry_run=False, logger=NullLogger()).run()

    assert FakeR2Client.instances[-1].deleted == ["orphan-prefix/a", "orphan-prefix/b"]


def test_unknown_prefix_only_reported_in_dry_run(account):
    creds_path, blob, umk = account
    FakeLibsqlClient.preset[CTL_URL]["SELECT id, db_path, type"] = [["admin-uid", DB_PATH, "admin"]]
    FakeLibsqlClient.preset[AA_URL]["SELECT user_id, content"] = _cred_store_rows(
        blob, umk, [("admin-uid", "admin-prefix", "admin-uid")]
    )
    FakeR2Client.prefixes = ["admin-prefix/", "orphan-prefix/"]
    FakeR2Client.keys_by_prefix = {"orphan-prefix/": ["orphan-prefix/a"]}

    BucketCleaner(load_creds(creds_path), dry_run=True, logger=NullLogger()).run()

    assert FakeR2Client.instances[-1].deleted == []


def test_unverifiable_account_blocks_real_mode(account):
    creds_path, blob, umk = account
    FakeLibsqlClient.preset[CTL_URL]["SELECT id, db_path, type"] = [
        ["admin-uid", DB_PATH, "admin"], ["user-1", "userdbpath", "user"],
    ]
    # user-1 has no cred_store row at all -- unverifiable.
    FakeLibsqlClient.preset[AA_URL]["SELECT user_id, content"] = _cred_store_rows(
        blob, umk, [("admin-uid", "admin-prefix", "admin-uid")]
    )
    FakeR2Client.prefixes = ["admin-prefix/", "orphan-prefix/"]
    FakeR2Client.keys_by_prefix = {"orphan-prefix/": ["orphan-prefix/a"]}

    with pytest.raises(ValueError, match="no verifiable db_prefix"):
        BucketCleaner(load_creds(creds_path), dry_run=False, logger=NullLogger()).run()

    assert FakeR2Client.instances[-1].deleted == []


def test_unverifiable_account_does_not_block_dry_run(account):
    creds_path, blob, umk = account
    FakeLibsqlClient.preset[CTL_URL]["SELECT id, db_path, type"] = [
        ["admin-uid", DB_PATH, "admin"], ["user-1", "userdbpath", "user"],
    ]
    FakeLibsqlClient.preset[AA_URL]["SELECT user_id, content"] = _cred_store_rows(
        blob, umk, [("admin-uid", "admin-prefix", "admin-uid")]
    )
    FakeR2Client.prefixes = ["admin-prefix/"]

    BucketCleaner(load_creds(creds_path), dry_run=True, logger=NullLogger()).run()  # must not raise


def test_user_id_mismatched_row_treated_as_unverifiable(account):
    creds_path, blob, umk = account
    FakeLibsqlClient.preset[CTL_URL]["SELECT id, db_path, type"] = [
        ["admin-uid", DB_PATH, "admin"], ["user-1", "userdbpath", "user"],
    ]
    # The row for user-1's own payload claims to be user-2's -- a swapped row.
    FakeLibsqlClient.preset[AA_URL]["SELECT user_id, content"] = _cred_store_rows(
        blob, umk, [("admin-uid", "admin-prefix", "admin-uid"), ("user-1", "user-1-prefix", "user-2")]
    )
    FakeR2Client.prefixes = ["admin-prefix/", "user-1-prefix/"]

    with pytest.raises(ValueError, match="no verifiable db_prefix"):
        BucketCleaner(load_creds(creds_path), dry_run=False, logger=NullLogger()).run()
