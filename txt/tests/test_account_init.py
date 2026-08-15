import base64
import json

import pytest

import txt.account_init as account_init_module
from txt.account_init import AccountInitializer
from txt.creds import load_creds, load_user_creds
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
    monkeypatch.setattr(account_init_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(account_init_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(account_init_module, "LibsqlClient", FakeLibsqlClient)
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


@pytest.fixture
def user_creds_path(tmp_path):
    data = {
        "firebase_email": "user@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "cf_worker_url": "https://worker.example",
        "display_name": "Trung",
    }
    path = tmp_path / "user_creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def _build(account_type, creds_path, user_creds_path=None):
    """Returns (initializer, target_creds_path) -- target_creds_path is
    whichever file the initializer will read/persist user_root_key into.
    """
    admin_creds = load_creds(creds_path)
    if account_type == "admin":
        return (
            AccountInitializer(
                admin_creds, admin_creds, creds_path, NullLogger(), "admin"
            ),
            creds_path,
        )
    user_creds = load_user_creds(user_creds_path)
    return (
        AccountInitializer(
            admin_creds, user_creds, user_creds_path, NullLogger(), "user"
        ),
        user_creds_path,
    )


@pytest.mark.parametrize("account_type", ["admin", "user"])
def test_creates_schema_for_all_three_tables(creds_path, user_creds_path, account_type):
    initializer, _ = _build(account_type, creds_path, user_creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    schema_calls = [
        c for c in ctl.calls if c[0] == "execute" and "CREATE TABLE" in c[1]
    ]
    assert {_table_name(sql) for _kind, sql, _args in schema_calls} == {
        "users",
        "key_store",
        "cred_store",
    }


@pytest.mark.parametrize("account_type", ["admin", "user"])
def test_registers_account_row(creds_path, user_creds_path, account_type):
    initializer, _ = _build(account_type, creds_path, user_creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    uid, type_, created_at = ctl.insert_args("users")
    assert (uid, type_) == (UID, account_type)
    assert isinstance(created_at, int)


@pytest.mark.parametrize("account_type", ["admin", "user"])
def test_persists_generated_user_root_key(creds_path, user_creds_path, account_type):
    initializer, target_path = _build(account_type, creds_path, user_creds_path)
    initializer.run()
    with open(target_path) as f:
        saved = json.load(f)
    assert len(base64.b64decode(saved["user_root_key"])) == 256


def test_admin_key_store_has_composite_kem_keypair(creds_path, engine):
    initializer, target_path = _build("admin", creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    with open(target_path) as f:
        ikm = base64.b64decode(json.load(f)["user_root_key"])

    blob = CryptoBlob(engine)
    uid, wrapped_umk, pubkey, wrapped_privkey = ctl.insert_args("key_store")
    assert uid == UID
    umk = blob.decrypt(wrapped_umk, ikm)
    assert len(umk) == 128
    assert len(pubkey) == 1624
    assert len(blob.decrypt(wrapped_privkey, umk)) == 3224


def test_user_key_store_has_no_kem_keypair(creds_path, user_creds_path):
    initializer, _ = _build("user", creds_path, user_creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    uid, _wrapped_umk = ctl.insert_args("key_store")
    assert uid == UID


@pytest.mark.parametrize("account_type", ["admin", "user"])
def test_cred_store_decrypts_correctly(creds_path, user_creds_path, engine, account_type):
    initializer, target_path = _build(account_type, creds_path, user_creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    with open(target_path) as f:
        ikm = base64.b64decode(json.load(f)["user_root_key"])

    blob = CryptoBlob(engine)
    umk = blob.decrypt(ctl.insert_args("key_store")[1], ikm)
    owner_id, for_user_id, content = ctl.insert_args("cred_store")
    assert owner_id == for_user_id == UID
    payload = blob.decrypt_json(content, umk)
    assert payload["display_name"] == "Trung"
    assert len(base64.b64decode(payload["db_master_key"])) == 256
    assert len(payload["db_path"]) == len(payload["db_prefix"]) == 52
    assert payload["db_path"] != payload["db_prefix"]


@pytest.mark.parametrize("account_type", ["admin", "user"])
def test_second_run_does_not_reinsert(creds_path, user_creds_path, account_type):
    initializer, _ = _build(account_type, creds_path, user_creds_path)
    initializer.run()
    first_ctl = FakeLibsqlClient.last_instance
    FakeLibsqlClient.preset = {
        "SELECT id FROM users": [[UID]],
        "SELECT umk FROM key_store": [first_ctl.insert_args("key_store")[1:2]],
        "SELECT content FROM cred_store": [[first_ctl.insert_args("cred_store")[2]]],
    }

    initializer2, _ = _build(account_type, creds_path, user_creds_path)
    initializer2.run()
    second_ctl = FakeLibsqlClient.last_instance
    inserts = [c for c in second_ctl.calls if c[0] == "execute" and "INSERT" in c[1]]
    assert inserts == []
