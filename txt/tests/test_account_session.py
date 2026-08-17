import base64
import json
import secrets

import pytest

import txt.account_session as account_session_module
from txt.account_session import Account, AccountSession
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
    preset_rows = []

    def __init__(self, url, token):
        self.url = url
        self.token = token

    def query(self, sql, args=None):
        return FakeLibsqlClient.preset_rows


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(account_session_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(account_session_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(account_session_module, "LibsqlClient", FakeLibsqlClient)
    FakeLibsqlClient.preset_rows = []
    yield


@pytest.fixture
def user_root_key():
    return base64.b64encode(secrets.token_bytes(256)).decode()


@pytest.fixture
def creds_path(tmp_path, user_root_key):
    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_name": "ctlname",
        "turso_ctl_db_url": "libsql://ctlname-x.aws-us-east-1.turso.io",
        "firebase_email": "a@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "display_name": "Trung",
        "user_root_key": user_root_key,
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def _wrapped_row(engine, user_root_key, account_type="user"):
    blob = CryptoBlob(engine)
    ikm = base64.b64decode(user_root_key)
    umk = secrets.token_bytes(128)
    wrapped_umk = blob.encrypt(umk, ikm)
    payload = {
        "display_name": "Trung",
        "db_master_key": base64.b64encode(secrets.token_bytes(256)).decode(),
        "db_path": "a" * 52,
        "db_prefix": "b" * 52,
    }
    wrapped_content = blob.encrypt_json(payload, umk)
    return [account_type, wrapped_umk, wrapped_content], payload


def test_connect_returns_decrypted_account(creds_path, user_root_key, engine):
    row, payload = _wrapped_row(engine, user_root_key, "user")
    FakeLibsqlClient.preset_rows = [row]

    account = AccountSession(load_creds(creds_path), NullLogger()).connect()

    assert isinstance(account, Account)
    assert account.uid == UID
    assert account.account_type == "user"
    assert account.display_name == "Trung"
    assert base64.b64encode(account.db_master_key).decode() == payload["db_master_key"]
    assert account.db_path == payload["db_path"]
    assert account.db_prefix == payload["db_prefix"]


def test_connect_raises_when_no_ctl_row(creds_path):
    FakeLibsqlClient.preset_rows = []
    with pytest.raises(ValueError):
        AccountSession(load_creds(creds_path), NullLogger()).connect()


def test_connect_raises_on_wrong_user_root_key(creds_path, user_root_key, engine):
    row, _payload = _wrapped_row(engine, user_root_key, "user")
    FakeLibsqlClient.preset_rows = [row]

    creds = load_creds(creds_path)
    creds.user_root_key = base64.b64encode(secrets.token_bytes(256)).decode()
    with pytest.raises(ValueError):
        AccountSession(creds, NullLogger()).connect()


def test_connect_rejects_invalid_user_root_key(creds_path, user_root_key, engine):
    row, _payload = _wrapped_row(engine, user_root_key, "user")
    FakeLibsqlClient.preset_rows = [row]
    creds = load_creds(creds_path)
    creds.user_root_key = "not base64!"

    with pytest.raises(ValueError, match="user_root_key"):
        AccountSession(creds, NullLogger()).connect()
