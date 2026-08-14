import json

import pytest

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
    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        return f"token-for-{db_name}"


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
    yield


@pytest.fixture
def creds_path(tmp_path):
    data = {
        "turso_org_token": "tok", "turso_ctl_db_url": CTL_URL, "turso_group": "g", "turso_org": "x",
        "firebase_email": "a@b.com", "firebase_password": "pw", "firebase_api_key": "key",
        "display_name": "Trung", "user_root_key": "",
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def _aa_inserts():
    aa = FakeLibsqlClient.instances[AA_URL]
    return [call for call in aa.calls if call[0] == "execute" and "INSERT" in call[1]]


def test_first_run_inserts_meta_and_cred_store(creds_path):
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    inserted_tables = {call[1].split()[2] for call in _aa_inserts()}
    assert inserted_tables == {"meta", "cred_store"}


def test_first_run_generates_and_persists_user_root_key(creds_path):
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    with open(creds_path) as f:
        saved = json.load(f)
    assert saved["user_root_key"] != ""


def test_second_run_is_idempotent(creds_path):
    FakeLibsqlClient.preset[AA_URL] = {
        "SELECT db_prefix": [["existing-prefix"]],
        "SELECT content FROM cred_store": [[b"already-there"]],
    }
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    assert _aa_inserts() == []


def test_admin_account_creates_key_store(creds_path):
    FakeLibsqlClient.preset[CTL_URL] = {"SELECT db_path, type": [[DB_PATH, "admin"]]}
    DbInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    inserted_tables = {call[1].split()[2] for call in _aa_inserts()}
    assert "key_store" in inserted_tables
