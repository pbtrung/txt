import base64
import hashlib
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from txt.account_data import parse_owner_account
from txt.creds import load_owner_creds
from txt.crypto_blob import CryptoBlob
from txt.d1_client import D1Error
from txt.leancrypto_wasm import KEM_PK_SIZE, KEM_SK_SIZE
from txt.owner_init import OwnerInitializer

OWNER_EMAIL = "owner@example.com"

# Matches _insert_owner()'s exact positional param order in txt/owner_init.py.
INSERT_PARAM_FIELDS = [
    "owner_email_hash",
    "db_prefix_hash",
    "user_handle_hash",
    "wrapped_umk",
    "kem_public_key",
    "wrapped_kem_private_key",
    "sign_algorithm",
    "sign_public_key",
    "wrapped_sign_private_key",
    "encrypted_credentials",
]


class NullLogger:
    def verbose(self, _message):
        pass

    def info(self, _message):
        pass


class FakeD1:
    def __init__(self):
        self.owner = None
        self.inserts = 0
        self.table_missing = False

    def query_one(self, _sql, _params=None):
        if self.table_missing:
            raise D1Error("no such table: owner")
        return self.owner

    def execute(self, _sql, params=None):
        row = dict(zip(INSERT_PARAM_FIELDS, params, strict=True))
        row["sign_version"] = 1
        self.owner = row
        self.inserts += 1
        return {}


@pytest.fixture
def owner_creds_path(tmp_path):
    data = {
        "owner_email": OWNER_EMAIL,
        "cf_account_id": "acct123",
        "cf_d1_database_id": "db456",
        "cf_d1_api_token": "token789",
        "display_name": "Owner",
        "r2_config": {
            "endpoint": "https://account.r2.cloudflarestorage.com",
            "read_write_access_key_id": "rw-id",
            "read_write_secret_access_key": "rw-secret",
            "region": "auto",
            "bucket": "books",
        },
        "user_root_key": "",
    }
    path = tmp_path / "owner.json"
    path.write_text(json.dumps(data))
    return str(path)


def _initializer(path, engine, d1):
    return OwnerInitializer(
        load_owner_creds(path), path, NullLogger(), engine=engine, d1=d1
    )


def test_provisions_singleton_owner_and_persists_root_key(owner_creds_path, engine):
    d1 = FakeD1()
    _initializer(owner_creds_path, engine, d1).run()

    with open(owner_creds_path) as file:
        root_key = base64.b64decode(json.load(file)["user_root_key"])
    assert len(root_key) == 256
    assert d1.inserts == 1
    _assert_owner_row(d1.owner, root_key, engine)


def test_second_run_validates_without_reinserting(owner_creds_path, engine):
    d1 = FakeD1()
    _initializer(owner_creds_path, engine, d1).run()
    _initializer(owner_creds_path, engine, d1).run()
    assert d1.inserts == 1


def test_rejects_existing_owner_for_a_different_email(owner_creds_path, engine):
    d1 = FakeD1()
    _initializer(owner_creds_path, engine, d1).run()
    d1.owner["owner_email_hash"] = hashlib.sha256(b"someone-else@example.com").digest()

    with pytest.raises(ValueError, match="owner email mismatch"):
        _initializer(owner_creds_path, engine, d1).run()


def test_rejects_a_tampered_user_handle_hash(owner_creds_path, engine):
    d1 = FakeD1()
    _initializer(owner_creds_path, engine, d1).run()
    d1.owner["user_handle_hash"] = hashlib.sha256(b"wrong").digest()

    with pytest.raises(ValueError, match="user handle mismatch"):
        _initializer(owner_creds_path, engine, d1).run()


def test_missing_owner_table_raises_a_clear_deploy_first_error(
    owner_creds_path, engine
):
    d1 = FakeD1()
    d1.table_missing = True

    with pytest.raises(ValueError, match="deploy the Worker first"):
        _initializer(owner_creds_path, engine, d1).run()


def test_load_current_owner_requires_init_owner_first(owner_creds_path, engine):
    d1 = FakeD1()

    with pytest.raises(ValueError, match="run --init-owner first"):
        _initializer(owner_creds_path, engine, d1).load_current_owner()


def test_load_current_owner_returns_umk_and_payload(owner_creds_path, engine):
    d1 = FakeD1()
    _initializer(owner_creds_path, engine, d1).run()

    umk, payload = _initializer(owner_creds_path, engine, d1).load_current_owner()

    assert len(umk) == 128
    account = parse_owner_account(payload)
    assert account.display_name == "Owner"


def _assert_owner_row(row, root_key, engine):
    blob = CryptoBlob(engine)
    umk = blob.decrypt(row["wrapped_umk"], root_key)
    payload = blob.decrypt_json(row["encrypted_credentials"], umk)
    account = parse_owner_account(payload)
    assert row["owner_email_hash"] == hashlib.sha256(OWNER_EMAIL.encode()).digest()
    assert row["user_handle_hash"] == hashlib.sha256(account.user_handle).digest()
    assert row["db_prefix_hash"] == hashlib.sha256(account.db_prefix.encode()).digest()
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
