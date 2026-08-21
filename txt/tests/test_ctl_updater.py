import base64
import hashlib
import secrets

import pytest

import txt.ctl_updater as ctl_updater_module
from txt.creds import Creds
from txt.crypto_blob import CryptoBlob
from txt.ctl_updater import CtlUpdater

ADMIN_UID = "uid-admin"
USER_UID = "uid-user"
ADMIN_ROOT = base64.b64encode(secrets.token_bytes(256)).decode()


class CaptureLogger:
    def __init__(self):
        self.messages = []

    def verbose(self, message):
        self.messages.append(message)

    def info(self, message):
        self.messages.append(message)


class FakeFirebaseAuth:
    def __init__(self, api_key):
        pass

    def sign_in(self, email, password):
        return ADMIN_UID


class FakeTursoClient:
    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        return "ctl-token"


class FakeLibsqlClient:
    columns = {"id", "type", "created_at", "db_binding_hash"}
    users = {}
    key_store = {}
    cred_store = {}
    calls = []
    has_index = False

    def __init__(self, url, token):
        pass

    def execute(self, sql, args=None):
        normalized = " ".join(sql.split())
        self.calls.append((normalized, args))
        if normalized.startswith("ALTER TABLE users ADD COLUMN user_handle_hash"):
            self.columns.add("user_handle_hash")
            for entry in self.users.values():
                entry[2] = bytes(32)
        elif normalized.startswith("UPDATE users SET user_handle_hash"):
            handle_hash, uid = args
            self.users[uid][2] = handle_hash
        elif normalized.startswith("UPDATE cred_store SET content"):
            content, owner_uid, user_uid = args
            self.cred_store[(owner_uid, user_uid)] = content
        elif normalized.startswith("CREATE UNIQUE INDEX"):
            hashes = [entry[2] for entry in self.users.values()]
            if len(hashes) != len(set(hashes)):
                raise ValueError("duplicate handle hash")
            type(self).has_index = True
        return {}

    def query(self, sql, args=None):
        normalized = " ".join(sql.split())
        if normalized == "PRAGMA table_info(users)":
            return [[index, value] for index, value in enumerate(self.columns)]
        if normalized == "SELECT id, type FROM users":
            return [[uid, entry[0]] for uid, entry in self.users.items()]
        if normalized == "SELECT id, type, user_handle_hash FROM users":
            return [[uid, entry[0], entry[2]] for uid, entry in self.users.items()]
        if "SELECT for_user_id, content FROM cred_store" in normalized:
            owner_uid = args[0]
            return [
                [user_uid, content]
                for (owner, user_uid), content in self.cred_store.items()
                if owner == owner_uid
            ]
        if "SELECT umk FROM key_store" in normalized:
            uid = args[0]
            return [[self.key_store[uid]]]
        if "SELECT k.umk, c.content" in normalized:
            uid = args[0]
            return [[self.key_store[uid], self.cred_store[(uid, uid)]]]
        return []


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(ctl_updater_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(ctl_updater_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(ctl_updater_module, "LibsqlClient", FakeLibsqlClient)
    FakeLibsqlClient.columns = {"id", "type", "created_at", "db_binding_hash"}
    FakeLibsqlClient.users = {}
    FakeLibsqlClient.key_store = {}
    FakeLibsqlClient.cred_store = {}
    FakeLibsqlClient.calls = []
    FakeLibsqlClient.has_index = False


@pytest.fixture
def creds():
    return Creds(
        turso_org_token="tok",
        turso_ctl_db_name="ctl",
        turso_ctl_db_url="libsql://ctl-account.turso.io",
        firebase_email="admin@example.com",
        firebase_password="pw",
        firebase_api_key="key",
        user_root_key=ADMIN_ROOT,
    )


def _payload(uid):
    return {
        "display_name": uid,
        "db_master_key": base64.b64encode(secrets.token_bytes(256)).decode(),
        "db_path": ("a" if uid == ADMIN_UID else "b") * 52,
        "db_prefix": ("c" if uid == ADMIN_UID else "d") * 52,
    }


def _seed_accounts(engine):
    blob = CryptoBlob(engine)
    admin_umk = secrets.token_bytes(128)
    user_umk = secrets.token_bytes(128)
    user_root = base64.b64encode(secrets.token_bytes(256)).decode()
    admin_payload, user_payload = _payload(ADMIN_UID), _payload(USER_UID)
    FakeLibsqlClient.users = {
        ADMIN_UID: ["admin", bytes(64), None],
        USER_UID: ["user", bytes(64), None],
    }
    FakeLibsqlClient.key_store = {
        ADMIN_UID: blob.encrypt(admin_umk, base64.b64decode(ADMIN_ROOT)),
        USER_UID: blob.encrypt(user_umk, base64.b64decode(user_root)),
    }
    FakeLibsqlClient.cred_store = {
        (ADMIN_UID, ADMIN_UID): blob.encrypt_json(admin_payload, admin_umk),
        (USER_UID, USER_UID): blob.encrypt_json(user_payload, user_umk),
        (ADMIN_UID, USER_UID): blob.encrypt_json(
            {**user_payload, "user_root_key": user_root}, admin_umk
        ),
    }
    return blob, admin_umk, user_umk


def _decrypt_payloads(blob, admin_umk, user_umk):
    admin = blob.decrypt_json(
        FakeLibsqlClient.cred_store[(ADMIN_UID, ADMIN_UID)], admin_umk
    )
    user = blob.decrypt_json(
        FakeLibsqlClient.cred_store[(USER_UID, USER_UID)], user_umk
    )
    backup = blob.decrypt_json(
        FakeLibsqlClient.cred_store[(ADMIN_UID, USER_UID)], admin_umk
    )
    return admin, user, backup


def test_migrates_schema_and_all_encrypted_payloads(creds, engine):
    blob, admin_umk, user_umk = _seed_accounts(engine)

    CtlUpdater(creds, CaptureLogger()).run()

    assert "user_handle_hash" in FakeLibsqlClient.columns
    assert FakeLibsqlClient.has_index is True
    admin, user, backup = _decrypt_payloads(blob, admin_umk, user_umk)
    for uid, payload in ((ADMIN_UID, admin), (USER_UID, user)):
        handle = base64.b64decode(payload["user_handle"], validate=True)
        assert len(handle) == 32
        assert FakeLibsqlClient.users[uid][2] == hashlib.sha256(handle).digest()
    assert backup["user_handle"] == user["user_handle"]
    assert "user_root_key" not in user
    assert "user_root_key" in backup


def test_dry_run_validates_without_writing(creds, engine):
    _seed_accounts(engine)
    before = dict(FakeLibsqlClient.cred_store)
    logger = CaptureLogger()

    CtlUpdater(creds, logger, dry_run=True).run()

    assert FakeLibsqlClient.calls == []
    assert FakeLibsqlClient.cred_store == before
    assert "user_handle_hash" not in FakeLibsqlClient.columns
    assert any("Would migrate 2 of 2 account(s)" in value for value in logger.messages)


def test_requires_user_root_key_in_admin_backup(creds, engine):
    blob, admin_umk, _ = _seed_accounts(engine)
    backup = blob.decrypt_json(
        FakeLibsqlClient.cred_store[(ADMIN_UID, USER_UID)], admin_umk
    )
    backup.pop("user_root_key")
    FakeLibsqlClient.cred_store[(ADMIN_UID, USER_UID)] = blob.encrypt_json(
        backup, admin_umk
    )

    with pytest.raises(ValueError, match="backup has no user_root_key"):
        CtlUpdater(creds, CaptureLogger()).run()

    assert FakeLibsqlClient.calls == []


def test_second_run_is_idempotent(creds, engine):
    _seed_accounts(engine)
    CtlUpdater(creds, CaptureLogger()).run()
    contents = dict(FakeLibsqlClient.cred_store)
    FakeLibsqlClient.calls = []

    CtlUpdater(creds, CaptureLogger()).run()

    assert FakeLibsqlClient.cred_store == contents
    assert all("UPDATE" not in sql for sql, _ in FakeLibsqlClient.calls)
