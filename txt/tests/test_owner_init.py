import base64
import hashlib
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from txt.account_data import parse_storage_account, storage_binding
from txt.creds import load_owner_creds
from txt.crypto_blob import CryptoBlob
from txt.leancrypto_wasm import KEM_PK_SIZE, KEM_SK_SIZE
from txt.owner_init import OwnerInitializer
from txt.rqlite_client import RqliteError

OWNER_UID = "firebase-owner"


class NullLogger:
    def verbose(self, _message):
        pass

    def info(self, _message):
        pass


class FakeFirebaseAuth:
    def __init__(self, _api_key):
        pass

    def sign_in(self, _email, _password):
        return OWNER_UID


class FakeRqlite:
    def __init__(self):
        self.owner = None
        self.inserts = 0

    def query_one(self, _sql, _params=None):
        return self.owner

    def execute(self, _sql, params=None):
        self.owner = dict(params)
        self.inserts += 1
        return {}


@pytest.fixture
def owner_creds_path(tmp_path):
    data = {
        "rqlite_admin_username": "operator",
        "rqlite_admin_password": "secret",
        "rqlite_operator_url": "https://api.example.com/operator/rqlite",
        "firebase_email": "owner@example.com",
        "firebase_password": "firebase-secret",
        "firebase_api_key": "firebase-key",
        "display_name": "Owner",
        "r2_config": {
            "endpoint": "https://account.r2.cloudflarestorage.com",
            "read_only_access_key_id": "ro-id",
            "read_only_secret_access_key": "ro-secret",
            "read_write_access_key_id": "rw-id",
            "read_write_secret_access_key": "rw-secret",
            "region": "auto",
            "bucket": "books",
        },
        "slhdsa_256f_priv_key": "",
        "asset_base_url": "https://reader.example.com",
        "user_root_key": "",
    }
    path = tmp_path / "owner.json"
    path.write_text(json.dumps(data))
    return str(path)


def _initializer(path, engine, rqlite):
    return OwnerInitializer(
        load_owner_creds(path),
        path,
        NullLogger(),
        engine=engine,
        auth_factory=FakeFirebaseAuth,
        rqlite=rqlite,
    )


def test_provisions_singleton_owner_and_persists_root_key(owner_creds_path, engine):
    rqlite = FakeRqlite()
    _initializer(owner_creds_path, engine, rqlite).run()

    with open(owner_creds_path) as file:
        root_key = base64.b64decode(json.load(file)["user_root_key"])
    assert len(root_key) == 256
    assert rqlite.inserts == 1
    _assert_owner_row(rqlite.owner, root_key, engine)


def test_second_run_validates_without_reinserting(owner_creds_path, engine):
    rqlite = FakeRqlite()
    _initializer(owner_creds_path, engine, rqlite).run()
    _initializer(owner_creds_path, engine, rqlite).run()
    assert rqlite.inserts == 1


def test_rejects_existing_owner_for_another_firebase_uid(owner_creds_path, engine):
    rqlite = FakeRqlite()
    _initializer(owner_creds_path, engine, rqlite).run()
    rqlite.owner["firebase_uid"] = "another-owner"

    with pytest.raises(ValueError, match="another Firebase UID"):
        _initializer(owner_creds_path, engine, rqlite).run()


def test_missing_schema_has_actionable_error(owner_creds_path, engine):
    class MissingSchema(FakeRqlite):
        def query_one(self, _sql, _params=None):
            raise RqliteError("no such table: owner_control")

    with pytest.raises(ValueError, match="0001_control.sql"):
        _initializer(owner_creds_path, engine, MissingSchema()).run()


def _assert_owner_row(row, root_key, engine):
    blob = CryptoBlob(engine)
    umk = blob.decrypt(row["wrapped_umk"], root_key)
    payload = blob.decrypt_json(row["encrypted_credentials"], umk)
    handle = base64.b64decode(payload["user_handle"])
    assert row["firebase_uid"] == OWNER_UID
    assert row["user_handle_hash"] == hashlib.sha256(handle).digest()
    assert row["db_binding_hash"] == storage_binding(
        parse_storage_account(OWNER_UID, payload)
    )
    assert len(row["kem_public_key"]) == KEM_PK_SIZE
    assert len(blob.decrypt(row["wrapped_kem_private_key"], umk)) == KEM_SK_SIZE
    _assert_signing(row, blob, umk)


def _assert_signing(row, blob, umk):
    public = serialization.load_der_public_key(row["sign_public_key"])
    private = serialization.load_der_private_key(
        blob.decrypt(row["wrapped_sign_private_key"], umk), password=None
    )
    assert isinstance(public.curve, ec.SECP521R1)
    assert isinstance(private.curve, ec.SECP521R1)
    assert public.public_numbers() == private.public_key().public_numbers()
