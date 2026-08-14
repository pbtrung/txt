import base64
import json
import secrets

import pytest
import requests

import txt.account_session as account_session_module
import txt.init_db as init_db_module
from txt.crypto_blob import CryptoBlob
from txt.creds import load_creds
from txt.init_db import DbInitializer

CTL_URL = "libsql://ctl-x.aws-us-east-1.turso.io"
DB_PATH = "0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghj"
AA_URL = f"libsql://{DB_PATH}-x.aws-us-east-1.turso.io"
ADMIN_DB_PATH = "adminadmin0123456789abcdefghjkmnpqrstvwxyz0123456789ad"
ADMIN_AA_URL = f"libsql://{ADMIN_DB_PATH}-x.aws-us-east-1.turso.io"


class NullLogger:
    def verbose(self, message):
        pass

    def info(self, message):
        pass


class FakeFirebaseAuth:
    uids_by_email = {}

    def __init__(self, api_key):
        pass

    def sign_in(self, email, password):
        return FakeFirebaseAuth.uids_by_email.get(email, "uid-123")


class FakeTursoClient:
    created_databases = []
    missing_until_created = set()

    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        already_created = db_name in {
            name for name, _ in FakeTursoClient.created_databases
        }
        if db_name in FakeTursoClient.missing_until_created and not already_created:
            resp = requests.Response()
            resp.status_code = 404
            raise requests.exceptions.HTTPError(response=resp)
        return f"token-for-{db_name}"

    def create_database(self, name, group):
        FakeTursoClient.created_databases.append((name, group))
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
                if isinstance(rows, dict):
                    return rows.get(args[0] if args else None, [])
                return rows
        return []


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch, engine):
    monkeypatch.setattr(account_session_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(account_session_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(account_session_module, "LibsqlClient", FakeLibsqlClient)
    monkeypatch.setattr(init_db_module, "LeancryptoEngine", lambda: engine)
    FakeLibsqlClient.preset = {CTL_URL: {"SELECT db_path, type": [[DB_PATH, "user"]]}}
    FakeLibsqlClient.instances = {}
    FakeTursoClient.created_databases = []
    FakeTursoClient.missing_until_created = set()
    FakeFirebaseAuth.uids_by_email = {}
    yield


@pytest.fixture
def creds_path(tmp_path):
    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_url": CTL_URL,
        "turso_group": "g",
        "turso_org": "x",
        "firebase_email": "a@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "display_name": "Trung",
        "user_root_key": "",
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def _aa_inserts():
    aa = FakeLibsqlClient.instances[AA_URL]
    return [call for call in aa.calls if call[0] == "execute" and "INSERT" in call[1]]


def test_first_run_inserts_meta_key_store_and_cred_store(creds_path):
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    inserted_tables = {call[1].split()[2] for call in _aa_inserts()}
    assert inserted_tables == {"meta", "key_store", "cred_store"}


def test_first_run_generates_and_persists_user_root_key(creds_path):
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    with open(creds_path) as f:
        saved = json.load(f)
    assert saved["user_root_key"] != ""


def test_second_run_is_idempotent(tmp_path, engine):
    root_key = base64.b64encode(secrets.token_bytes(256)).decode()
    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_url": CTL_URL,
        "turso_group": "g",
        "turso_org": "x",
        "firebase_email": "a@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "display_name": "Trung",
        "user_root_key": root_key,
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))

    blob = CryptoBlob(engine)
    umk = secrets.token_bytes(128)
    wrapped_umk = blob.encrypt(umk, base64.b64decode(root_key))
    wrapped_db_prefix = blob.encrypt(b"existing-prefix", umk)
    existing_payload = {
        "user_id": "uid-123",
        "display_name": "Trung",
        "db_master_key": base64.b64encode(secrets.token_bytes(256)).decode(),
        "db_prefix": "existing-prefix",
    }
    wrapped_content = blob.encrypt_json(existing_payload, umk)
    FakeLibsqlClient.preset[AA_URL] = {
        "SELECT db_prefix": [[wrapped_db_prefix]],
        "SELECT umk FROM key_store": [[wrapped_umk]],
        "SELECT content FROM cred_store": [[wrapped_content]],
    }
    DbInitializer(load_creds(str(path)), str(path), NullLogger()).run()
    aa = FakeLibsqlClient.instances[AA_URL]
    assert _aa_inserts() == []
    assert [c for c in aa.calls if c[0] == "execute" and "UPDATE cred_store" in c[1]] == []


def test_admin_account_creates_key_store_with_kem_keypair(creds_path):
    FakeLibsqlClient.preset[CTL_URL] = {"SELECT db_path, type": [[DB_PATH, "admin"]]}
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    aa = FakeLibsqlClient.instances[AA_URL]
    key_store_insert = next(
        c for c in aa.calls if c[0] == "execute" and "INSERT INTO key_store" in c[1]
    )
    assert "pubkey" in key_store_insert[1] and "privkey" in key_store_insert[1]


def test_user_account_key_store_has_no_kem_keypair(creds_path):
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    aa = FakeLibsqlClient.instances[AA_URL]
    key_store_insert = next(
        c for c in aa.calls if c[0] == "execute" and "INSERT INTO key_store" in c[1]
    )
    assert "pubkey" not in key_store_insert[1]


def test_db_prefix_is_stored_wrapped_not_plaintext(creds_path):
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    aa = FakeLibsqlClient.instances[AA_URL]
    meta_insert = next(
        c for c in aa.calls if c[0] == "execute" and "INSERT INTO meta" in c[1]
    )
    wrapped_db_prefix = meta_insert[2][1]
    assert isinstance(wrapped_db_prefix, bytes)
    assert wrapped_db_prefix[0:2] == b"\x54\x58"


def test_creates_database_when_mint_token_404s(creds_path):
    FakeTursoClient.missing_until_created = {DB_PATH}
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    assert FakeTursoClient.created_databases == [(DB_PATH, "g")]
    assert AA_URL in FakeLibsqlClient.instances


def test_does_not_create_database_when_mint_succeeds(creds_path):
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    assert FakeTursoClient.created_databases == []


def _admin_creds_path(tmp_path, root_key):
    data = {
        "turso_org_token": "admin-tok",
        "turso_ctl_db_url": CTL_URL,
        "turso_group": "g",
        "turso_org": "x",
        "firebase_email": "admin@x.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "display_name": "Admin",
        "user_root_key": root_key,
    }
    path = tmp_path / "admin_creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def _seed_admin_aa(engine, admin_root_key):
    blob = CryptoBlob(engine)
    admin_umk = secrets.token_bytes(128)
    wrapped_umk = blob.encrypt(admin_umk, base64.b64decode(admin_root_key))
    FakeFirebaseAuth.uids_by_email = {"admin@x.com": "admin-uid"}
    FakeLibsqlClient.preset[CTL_URL] = {
        "SELECT db_path, type": {
            "uid-123": [[DB_PATH, "user"]],
            "admin-uid": [[ADMIN_DB_PATH, "admin"]],
        }
    }
    FakeLibsqlClient.preset[ADMIN_AA_URL] = {"SELECT umk FROM key_store": [[wrapped_umk]]}
    return admin_umk


def test_push_backup_to_admin_succeeds(creds_path, tmp_path, engine):
    admin_root_key = base64.b64encode(secrets.token_bytes(256)).decode()
    admin_umk = _seed_admin_aa(engine, admin_root_key)
    admin_creds_path = _admin_creds_path(tmp_path, admin_root_key)

    DbInitializer(
        load_creds(creds_path),
        creds_path,
        NullLogger(),
        admin_creds=load_creds(admin_creds_path),
    ).run()

    admin_aa = FakeLibsqlClient.instances[ADMIN_AA_URL]
    push = next(
        c for c in admin_aa.calls if c[0] == "execute" and "INSERT INTO cred_store" in c[1]
    )
    uid, content = push[2]
    assert uid == "uid-123"
    blob = CryptoBlob(engine)
    payload = blob.decrypt_json(content, admin_umk)
    assert payload["user_id"] == "uid-123"
    assert payload["db_prefix"]
    assert payload["db_master_key"]


def test_local_init_db_succeeds_even_if_admin_push_fails(creds_path, tmp_path):
    # admin_creds points at an account ctl has never heard of -- the push
    # must fail gracefully, not take down the user's own (already-valid) run.
    bad_admin_root_key = base64.b64encode(secrets.token_bytes(256)).decode()
    admin_creds_path = _admin_creds_path(tmp_path, bad_admin_root_key)
    FakeFirebaseAuth.uids_by_email = {"admin@x.com": "unregistered-admin-uid"}
    FakeLibsqlClient.preset[CTL_URL] = {
        "SELECT db_path, type": {"uid-123": [[DB_PATH, "user"]]}
    }

    DbInitializer(
        load_creds(creds_path),
        creds_path,
        NullLogger(),
        admin_creds=load_creds(admin_creds_path),
    ).run()

    aa = FakeLibsqlClient.instances[AA_URL]
    inserted_tables = {call[1].split()[2] for call in _aa_inserts()}
    assert inserted_tables == {"meta", "key_store", "cred_store"}


def test_backfill_adds_user_id_and_db_prefix_without_regenerating_db_master_key(
    tmp_path, engine
):
    root_key = base64.b64encode(secrets.token_bytes(256)).decode()
    data = {
        "turso_org_token": "tok", "turso_ctl_db_url": CTL_URL, "turso_group": "g",
        "turso_org": "x", "firebase_email": "a@b.com", "firebase_password": "pw",
        "firebase_api_key": "key", "display_name": "Trung", "user_root_key": root_key,
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))

    blob = CryptoBlob(engine)
    umk = secrets.token_bytes(128)
    wrapped_umk = blob.encrypt(umk, base64.b64decode(root_key))
    wrapped_db_prefix = blob.encrypt(b"existing-prefix", umk)
    original_db_master_key = base64.b64encode(secrets.token_bytes(256)).decode()
    old_payload = {"display_name": "Trung", "db_master_key": original_db_master_key}
    wrapped_content = blob.encrypt_json(old_payload, umk)
    FakeLibsqlClient.preset[AA_URL] = {
        "SELECT db_prefix": [[wrapped_db_prefix]],
        "SELECT umk FROM key_store": [[wrapped_umk]],
        "SELECT content FROM cred_store": [[wrapped_content]],
    }

    DbInitializer(load_creds(str(path)), str(path), NullLogger()).run()

    aa = FakeLibsqlClient.instances[AA_URL]
    update = next(
        c for c in aa.calls if c[0] == "execute" and "UPDATE cred_store" in c[1]
    )
    new_content = update[2][0]
    new_payload = blob.decrypt_json(new_content, umk)
    assert new_payload["user_id"] == "uid-123"
    assert new_payload["db_prefix"] == "existing-prefix"
    assert new_payload["db_master_key"] == original_db_master_key
