import base64
import json
import secrets

import pytest
import requests

import txt.init_db as init_db_module
from txt.creds import load_creds
from txt.init_db import DbInitializer

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
        return "uid-123"


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
                return rows
        return []


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch, engine):
    monkeypatch.setattr(init_db_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(init_db_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(init_db_module, "LibsqlClient", FakeLibsqlClient)
    monkeypatch.setattr(init_db_module, "LeancryptoEngine", lambda: engine)
    FakeLibsqlClient.preset = {CTL_URL: {"SELECT db_path, type": [[DB_PATH, "user"]]}}
    FakeLibsqlClient.instances = {}
    FakeTursoClient.created_databases = []
    FakeTursoClient.missing_until_created = set()
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
    from txt.crypto_blob import CryptoBlob

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
    FakeLibsqlClient.preset[AA_URL] = {
        "SELECT db_prefix": [[wrapped_db_prefix]],
        "SELECT umk FROM key_store": [[wrapped_umk]],
        "SELECT content FROM cred_store": [[b"already-there"]],
    }
    DbInitializer(load_creds(str(path)), str(path), NullLogger()).run()
    assert _aa_inserts() == []


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
