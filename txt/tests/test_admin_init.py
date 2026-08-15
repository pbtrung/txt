import base64
import json

import pytest

import txt.admin_init as admin_init_module
from txt.admin_init import AdminInitializer
from txt.creds import load_creds
from txt.crypto_blob import CryptoBlob

UID = "uid-123"


class NullLogger:
    def verbose(self, message):
        pass

    def info(self, message):
        pass


class FakeFirebaseAuth:
    def __init__(self, api_key):
        pass

    def sign_in(self, email, password):
        return UID


class FakeTursoClient:
    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        return f"token-for-{db_name}"


class FakeLibsqlClient:
    preset = {}
    last_instance = None

    def __init__(self, url, token):
        self.url = url
        self.calls = []
        FakeLibsqlClient.last_instance = self

    def execute(self, sql, args=None):
        self.calls.append(("execute", " ".join(sql.split()), args))
        return {}

    def query(self, sql, args=None):
        self.calls.append(("query", " ".join(sql.split()), args))
        for needle, rows in FakeLibsqlClient.preset.items():
            if needle in sql:
                return rows
        return []

    def insert_args(self, table):
        return next(
            a
            for kind, s, a in self.calls
            if kind == "execute" and f"INSERT INTO {table}" in s
        )


def _table_name(sql: str) -> str:
    return sql.split("EXISTS", 1)[1].split("(", 1)[0].strip()


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(admin_init_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(admin_init_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(admin_init_module, "LibsqlClient", FakeLibsqlClient)
    FakeLibsqlClient.preset = {}
    FakeLibsqlClient.last_instance = None
    yield


@pytest.fixture
def creds_path(tmp_path):
    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_name": "ctlname",
        "turso_ctl_db_url": "libsql://ctlname-x.aws-us-east-1.turso.io",
        "firebase_email": "a@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "display_name": "Trung",
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def test_creates_schema_for_all_three_tables(creds_path):
    AdminInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    ctl = FakeLibsqlClient.last_instance
    schema_calls = [
        c for c in ctl.calls if c[0] == "execute" and "CREATE TABLE" in c[1]
    ]
    assert {_table_name(sql) for _kind, sql, _args in schema_calls} == {
        "users",
        "key_store",
        "cred_store",
    }


def test_registers_admin_row(creds_path):
    AdminInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    ctl = FakeLibsqlClient.last_instance
    uid, created_at = ctl.insert_args("users")
    assert uid == UID
    assert "'admin'" in next(
        s for kind, s, _a in ctl.calls if kind == "execute" and "INSERT INTO users" in s
    )
    assert isinstance(created_at, int)


def test_persists_generated_user_root_key(creds_path):
    AdminInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    with open(creds_path) as f:
        saved = json.load(f)
    assert len(base64.b64decode(saved["user_root_key"])) == 256


def test_key_store_and_cred_store_decrypt_correctly(creds_path, engine):
    AdminInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    ctl = FakeLibsqlClient.last_instance
    with open(creds_path) as f:
        ikm = base64.b64decode(json.load(f)["user_root_key"])

    blob = CryptoBlob(engine)
    uid, wrapped_umk, pubkey, wrapped_privkey = ctl.insert_args("key_store")
    assert uid == UID
    umk = blob.decrypt(wrapped_umk, ikm)
    assert len(umk) == 128
    assert len(pubkey) == 1624
    assert len(blob.decrypt(wrapped_privkey, umk)) == 3224

    owner_id, for_user_id, content = ctl.insert_args("cred_store")
    assert owner_id == for_user_id == UID
    payload = blob.decrypt_json(content, umk)
    assert payload["display_name"] == "Trung"
    assert len(base64.b64decode(payload["db_master_key"])) == 256
    assert len(payload["db_path"]) == len(payload["db_prefix"]) == 52
    assert payload["db_path"] != payload["db_prefix"]


def test_second_run_does_not_reinsert(creds_path):
    AdminInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    first_ctl = FakeLibsqlClient.last_instance
    FakeLibsqlClient.preset = {
        "SELECT id FROM users": [[UID]],
        "SELECT umk FROM key_store": [first_ctl.insert_args("key_store")[1:2]],
        "SELECT content FROM cred_store": [[first_ctl.insert_args("cred_store")[2]]],
    }

    AdminInitializer(load_creds(creds_path), creds_path, NullLogger()).run()
    second_ctl = FakeLibsqlClient.last_instance
    inserts = [c for c in second_ctl.calls if c[0] == "execute" and "INSERT" in c[1]]
    assert inserts == []
