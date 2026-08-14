import json

import pytest

import txt.admin_init as admin_init_module
from txt.admin_init import AdminInitializer
from txt.creds import load_creds

CTL_URL = "libsql://ctl-x.aws-us-east-1.turso.io"


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

    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
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
def patch_clients(monkeypatch):
    monkeypatch.setattr(admin_init_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(admin_init_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(admin_init_module, "LibsqlClient", FakeLibsqlClient)
    FakeTursoClient.created_databases = []
    FakeLibsqlClient.preset = {}
    FakeLibsqlClient.instances = {}
    yield


@pytest.fixture
def creds_path(tmp_path):
    data = {
        "turso_org_token": "tok", "turso_ctl_db_url": CTL_URL, "turso_group": "g", "turso_org": "x",
        "firebase_email": "a@b.com", "firebase_password": "pw", "firebase_api_key": "key",
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def test_registers_admin_with_db_path_but_no_database(creds_path):
    AdminInitializer(load_creds(creds_path), NullLogger()).run()
    ctl = FakeLibsqlClient.instances[CTL_URL]
    insert = next(c for c in ctl.calls if c[0] == "execute" and "INSERT INTO users" in c[1])
    uid, db_path, account_type, _created_at = insert[2]
    assert uid == "uid-123"
    assert account_type == "admin"
    assert len(db_path) == 52
    assert FakeTursoClient.created_databases == []


def test_second_run_does_not_reinsert(creds_path):
    FakeLibsqlClient.preset[CTL_URL] = {"SELECT id FROM users": [["uid-123"]]}
    AdminInitializer(load_creds(creds_path), NullLogger()).run()
    ctl = FakeLibsqlClient.instances[CTL_URL]
    inserts = [c for c in ctl.calls if c[0] == "execute" and "INSERT" in c[1]]
    assert inserts == []
