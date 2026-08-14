import base64
import json
import secrets

import pytest

from txt.account_session import AccountSession
from txt.creds import load_creds
from txt.crypto_blob import CryptoBlob


class FakeAa:
    def __init__(self, rows_by_needle):
        self.rows_by_needle = rows_by_needle

    def query(self, sql, params=None):
        for needle, rows in self.rows_by_needle.items():
            if needle in sql:
                return rows
        return []


@pytest.fixture
def creds_path(tmp_path):
    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_url": "libsql://ctl-x.aws-us-east-1.turso.io",
        "turso_group": "g",
        "turso_org": "x",
        "firebase_email": "a@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def test_read_umk_returns_none_when_missing(creds_path):
    session = AccountSession(load_creds(creds_path), None)
    aa = FakeAa({})
    assert session.read_umk(aa, blob=None, ikm=b"x") is None


def test_read_umk_unwraps_existing_row(creds_path, engine):
    blob = CryptoBlob(engine)
    ikm = secrets.token_bytes(256)
    umk = secrets.token_bytes(128)
    wrapped = blob.encrypt(umk, ikm)
    session = AccountSession(load_creds(creds_path), None)
    aa = FakeAa({"SELECT umk FROM key_store": [[wrapped]]})
    assert session.read_umk(aa, blob, ikm) == umk


def test_read_db_master_key_returns_none_when_missing(creds_path):
    session = AccountSession(load_creds(creds_path), None)
    aa = FakeAa({})
    assert session.read_db_master_key(aa, "uid-1", "user", blob=None, umk=b"x") is None


def test_read_db_master_key_decodes_from_cred_store(creds_path, engine):
    blob = CryptoBlob(engine)
    umk = secrets.token_bytes(128)
    db_master_key = secrets.token_bytes(256)
    payload = {
        "display_name": "Trung",
        "db_master_key": base64.b64encode(db_master_key).decode(),
    }
    wrapped = blob.encrypt_json(payload, umk)
    session = AccountSession(load_creds(creds_path), None)
    aa = FakeAa({"SELECT content FROM cred_store WHERE id = 1": [[wrapped]]})
    assert session.read_db_master_key(aa, "uid-1", "user", blob, umk) == db_master_key


def test_read_db_master_key_uses_user_id_lookup_for_admin(creds_path, engine):
    blob = CryptoBlob(engine)
    umk = secrets.token_bytes(128)
    db_master_key = secrets.token_bytes(256)
    payload = {
        "display_name": "Trung",
        "db_master_key": base64.b64encode(db_master_key).decode(),
    }
    wrapped = blob.encrypt_json(payload, umk)
    session = AccountSession(load_creds(creds_path), None)
    aa = FakeAa({"SELECT content FROM cred_store WHERE user_id = ?": [[wrapped]]})
    assert session.read_db_master_key(aa, "uid-1", "admin", blob, umk) == db_master_key
