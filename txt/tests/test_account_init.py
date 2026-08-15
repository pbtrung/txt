import base64
import json
import secrets

import pytest

import txt.account_init as account_init_module
from txt.account_init import AccountInitializer
from txt.creds import load_creds, load_user_creds
from txt.crypto_blob import CryptoBlob

ADMIN_UID = "uid-admin"
USER_UID = "uid-user"
ADMIN_EMAIL = "admin@b.com"
USER_EMAIL = "user@b.com"
ADMIN_ROOT_KEY = base64.b64encode(secrets.token_bytes(256)).decode()


class NullLogger:
    def verbose(self, message):
        pass

    def info(self, message):
        pass


class FakeFirebaseAuth:
    def __init__(self, api_key):
        pass

    def sign_in(self, email, password):
        return {ADMIN_EMAIL: ADMIN_UID, USER_EMAIL: USER_UID}[email]


class FakeTursoClient:
    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        return f"token-for-{db_name}"


class FakeLibsqlClient:
    """A minimal, genuinely stateful in-memory stand-in for ctl -- state is
    class-level so it survives across the several LibsqlClient(...)
    instances one AccountInitializer.run() (or two, back to back, to test
    idempotency) constructs, the same way a real Turso database would.
    Reset between tests by the patch_clients autouse fixture below.
    """

    last_instance = None
    users: dict = {}
    key_store: dict = {}
    cred_store: dict = {}

    def __init__(self, url, token):
        self.url = url
        self.calls = []
        FakeLibsqlClient.last_instance = self

    def execute(self, sql, args=None):
        normalized = " ".join(sql.split())
        self.calls.append(("execute", normalized, args))
        if "INSERT INTO users" in normalized:
            uid, type_, created_at = args
            FakeLibsqlClient.users[uid] = (type_, created_at)
        elif "INSERT INTO key_store (user_id, umk, pubkey, privkey)" in normalized:
            uid, umk, pubkey, privkey = args
            FakeLibsqlClient.key_store[uid] = (umk, pubkey, privkey)
        elif "INSERT INTO key_store (user_id, umk)" in normalized:
            uid, umk = args
            FakeLibsqlClient.key_store[uid] = (umk, None, None)
        elif "INSERT INTO cred_store" in normalized:
            owner_id, for_user_id, content = args
            FakeLibsqlClient.cred_store[(owner_id, for_user_id)] = content
        return {}

    def query(self, sql, args=None):
        normalized = " ".join(sql.split())
        self.calls.append(("query", normalized, args))
        if "SELECT id FROM users" in normalized:
            (uid,) = args
            return [[uid]] if uid in FakeLibsqlClient.users else []
        if "SELECT 1 FROM cred_store" in normalized:
            key = tuple(args)
            return [[1]] if key in FakeLibsqlClient.cred_store else []
        if "SELECT umk FROM key_store" in normalized:
            (uid,) = args
            entry = FakeLibsqlClient.key_store.get(uid)
            return [[entry[0]]] if entry else []
        if "SELECT content FROM cred_store" in normalized:
            key = tuple(args)
            content = FakeLibsqlClient.cred_store.get(key)
            return [[content]] if content is not None else []
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
    FakeLibsqlClient.last_instance = None
    FakeLibsqlClient.users = {}
    FakeLibsqlClient.key_store = {}
    FakeLibsqlClient.cred_store = {}
    yield


@pytest.fixture
def creds_path(tmp_path):
    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_name": "ctlname",
        "turso_ctl_db_url": "libsql://ctlname-x.aws-us-east-1.turso.io",
        "firebase_email": ADMIN_EMAIL,
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "display_name": "Admin",
        "user_root_key": ADMIN_ROOT_KEY,
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


@pytest.fixture
def user_creds_path(tmp_path):
    data = {
        "firebase_email": USER_EMAIL,
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "cf_worker_url": "https://worker.example",
        "display_name": "Trung",
    }
    path = tmp_path / "user_creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def _uid_for(account_type: str) -> str:
    return ADMIN_UID if account_type == "admin" else USER_UID


def _provision_admin(engine) -> bytes:
    """Simulates the admin already being provisioned (a prior --init-admin
    run) by seeding their key_store row directly -- required before
    _ensure_admin_backup can look up their umk. Returns the admin's own
    (plaintext) umk for assertions.
    """
    blob = CryptoBlob(engine)
    admin_umk = secrets.token_bytes(128)
    wrapped = blob.encrypt(admin_umk, base64.b64decode(ADMIN_ROOT_KEY))
    FakeLibsqlClient.key_store[ADMIN_UID] = (wrapped, None, None)
    return admin_umk


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
def test_creates_schema_for_all_three_tables(
    creds_path, user_creds_path, engine, account_type
):
    if account_type == "user":
        _provision_admin(engine)
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
def test_registers_account_row(creds_path, user_creds_path, engine, account_type):
    if account_type == "user":
        _provision_admin(engine)
    initializer, _ = _build(account_type, creds_path, user_creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    uid, type_, created_at = ctl.insert_args("users")
    assert (uid, type_) == (_uid_for(account_type), account_type)
    assert isinstance(created_at, int)


@pytest.mark.parametrize("account_type", ["admin", "user"])
def test_persists_generated_user_root_key(
    creds_path, user_creds_path, engine, account_type
):
    if account_type == "user":
        _provision_admin(engine)
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
    assert uid == ADMIN_UID
    umk = blob.decrypt(wrapped_umk, ikm)
    assert len(umk) == 128
    assert len(pubkey) == 1624
    assert len(blob.decrypt(wrapped_privkey, umk)) == 3224


def test_user_key_store_has_no_kem_keypair(creds_path, user_creds_path, engine):
    _provision_admin(engine)
    initializer, _ = _build("user", creds_path, user_creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    uid, _wrapped_umk = ctl.insert_args("key_store")
    assert uid == USER_UID


@pytest.mark.parametrize("account_type", ["admin", "user"])
def test_cred_store_decrypts_correctly(
    creds_path, user_creds_path, engine, account_type
):
    if account_type == "user":
        _provision_admin(engine)
    initializer, target_path = _build(account_type, creds_path, user_creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    with open(target_path) as f:
        ikm = base64.b64decode(json.load(f)["user_root_key"])

    blob = CryptoBlob(engine)
    umk = blob.decrypt(ctl.insert_args("key_store")[1], ikm)
    owner_id, for_user_id, content = ctl.insert_args("cred_store")
    assert owner_id == for_user_id == _uid_for(account_type)
    payload = blob.decrypt_json(content, umk)
    expected_display_name = "Admin" if account_type == "admin" else "Trung"
    assert payload["display_name"] == expected_display_name
    assert len(base64.b64decode(payload["db_master_key"])) == 256
    assert len(payload["db_path"]) == len(payload["db_prefix"]) == 52
    assert payload["db_path"] != payload["db_prefix"]


@pytest.mark.parametrize("account_type", ["admin", "user"])
def test_second_run_does_not_reinsert(
    creds_path, user_creds_path, engine, account_type
):
    if account_type == "user":
        _provision_admin(engine)
    initializer, _ = _build(account_type, creds_path, user_creds_path)
    initializer.run()

    initializer2, _ = _build(account_type, creds_path, user_creds_path)
    initializer2.run()
    second_ctl = FakeLibsqlClient.last_instance
    inserts = [c for c in second_ctl.calls if c[0] == "execute" and "INSERT" in c[1]]
    assert inserts == []


def test_admin_backup_row_decrypts_to_the_same_payload(
    creds_path, user_creds_path, engine
):
    admin_umk = _provision_admin(engine)
    initializer, target_path = _build("user", creds_path, user_creds_path)
    initializer.run()
    with open(target_path) as f:
        user_ikm = base64.b64decode(json.load(f)["user_root_key"])

    blob = CryptoBlob(engine)
    self_content = FakeLibsqlClient.cred_store[(USER_UID, USER_UID)]
    backup_content = FakeLibsqlClient.cred_store[(ADMIN_UID, USER_UID)]

    user_umk = blob.decrypt(FakeLibsqlClient.key_store[USER_UID][0], user_ikm)
    self_payload = blob.decrypt_json(self_content, user_umk)
    backup_payload = blob.decrypt_json(backup_content, admin_umk)

    assert backup_payload == self_payload


def test_admin_backup_row_skipped_when_already_present(
    creds_path, user_creds_path, engine
):
    _provision_admin(engine)
    FakeLibsqlClient.cred_store[(ADMIN_UID, USER_UID)] = b"already-backed-up"
    initializer, _ = _build("user", creds_path, user_creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    cred_store_inserts = [
        a
        for kind, s, a in ctl.calls
        if kind == "execute" and "INSERT INTO cred_store" in s
    ]
    assert len(cred_store_inserts) == 1
    assert cred_store_inserts[0][0] == cred_store_inserts[0][1] == USER_UID
    assert FakeLibsqlClient.cred_store[(ADMIN_UID, USER_UID)] == b"already-backed-up"


def test_admin_backup_not_created_for_admin_self_init(creds_path, engine):
    initializer, _ = _build("admin", creds_path)
    initializer.run()
    ctl = FakeLibsqlClient.last_instance
    cred_store_inserts = [
        a
        for kind, s, a in ctl.calls
        if kind == "execute" and "INSERT INTO cred_store" in s
    ]
    assert len(cred_store_inserts) == 1
