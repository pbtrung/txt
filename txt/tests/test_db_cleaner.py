import base64

import pytest

from txt.account_data import parse_owner_account
from txt.creds import OwnerCreds, R2Config
from txt.crypto_blob import CryptoBlob
from txt.db_cleaner import DbCleaner
from txt.owner_init import OwnerInitializer

OWNER_EMAIL = "owner@example.com"

CF_CREDS = OwnerCreds(
    owner_email=OWNER_EMAIL,
    cf_account_id="acct123",
    cf_d1_database_id="db456",
    cf_d1_api_token="token789",
    display_name="Trung",
    r2_config=R2Config(
        endpoint="https://account.r2.cloudflarestorage.com",
        read_write_access_key_id="rw-id",
        read_write_secret_access_key="rw-secret",
        region="auto",
        bucket="books",
    ),
    user_root_key=base64.b64encode(b"n" * 256).decode(),
)
CF_CREDS_PATH = "unused-cf-creds-path.json"


class NullLogger:
    def verbose(self, _message):
        pass

    def info(self, _message):
        pass


class CapturingLogger:
    def __init__(self):
        self.info_messages = []
        self.verbose_messages = []

    def info(self, message):
        self.info_messages.append(message)

    def verbose(self, message):
        self.verbose_messages.append(message)


class FakeD1:
    """A minimal in-memory stand-in matching exactly the SQL shapes
    owner_init.py/db_cleaner.py issue -- not a general SQL engine."""

    def __init__(self):
        self.owner = None
        self.key_store = {}
        self.shares = {}
        self._next_id = 1

    def _alloc_id(self) -> int:
        id_ = self._next_id
        self._next_id += 1
        return id_

    def query(self, sql, _params=None):
        if sql.strip().startswith("SELECT s.share_id_hash"):
            return [
                {
                    "share_id_hash": share_id_hash,
                    "key_wrapped": self.key_store[row["key_id"]]["wrapped_key"],
                    "owner_blob": row["owner_blob"],
                }
                for share_id_hash, row in self.shares.items()
                if row["state"] == "deleting"
            ]
        raise AssertionError(f"unexpected query: {sql}")

    def query_one(self, sql, _params=None):
        if "FROM owner" in sql:
            return self.owner
        raise AssertionError(f"unexpected query_one: {sql}")

    def execute(self, sql, params=None):
        sql = sql.strip()
        if sql.startswith("INSERT INTO owner"):
            return self._insert_owner(params)
        if sql.startswith("INSERT INTO key_store"):
            return self._insert_key(params)
        if sql.startswith("DELETE FROM shares WHERE share_id_hash"):
            (share_id_hash,) = params
            self._delete_share(share_id_hash)
            return {"meta": {}}
        raise AssertionError(f"unexpected execute: {sql}")

    def _insert_owner(self, params):
        fields = [
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
        self.owner = dict(zip(fields, params, strict=True))
        self.owner["sign_version"] = 1
        return {"meta": {}}

    def _insert_key(self, params):
        purpose, wrapped_key = params
        id_ = self._alloc_id()
        self.key_store[id_] = {"purpose": purpose, "wrapped_key": wrapped_key}
        return {"meta": {"last_row_id": id_}}

    def _delete_share(self, share_id_hash: bytes) -> None:
        # Mirrors trg_shares_delete_key (docs/data_model.md): deleting a
        # shares row cleans up its key_store row automatically in real D1.
        row = self.shares.pop(share_id_hash, None)
        if row is not None:
            self.key_store.pop(row["key_id"], None)

    def add_share(
        self, share_id_hash: bytes, share_path: str, state: str, umk: bytes, blob
    ) -> None:
        row_key = b"s" * 128
        key_id = self._alloc_id()
        self.key_store[key_id] = {
            "purpose": "share_key",
            "wrapped_key": blob.encrypt(row_key, umk),
        }
        owner_blob = blob.encrypt_json(
            {
                "share_id": base64.b64encode(b"i" * 32).decode(),
                "share_content_key": base64.b64encode(b"x" * 128).decode(),
                "share_path": share_path,
            },
            row_key,
        )
        self.shares[share_id_hash] = {
            "key_id": key_id,
            "owner_blob": owner_blob,
            "state": state,
        }


class FakeR2Client:
    def __init__(self, _config=None):
        self.deleted = []

    def delete_keys(self, keys, on_progress=None):
        self.deleted.extend(keys)


@pytest.fixture
def d1(engine):
    fake = FakeD1()
    OwnerInitializer(
        CF_CREDS, CF_CREDS_PATH, NullLogger(), engine=engine, d1=fake
    ).run()
    return fake


def _account(d1_fake, engine):
    umk, payload = OwnerInitializer(
        CF_CREDS, CF_CREDS_PATH, NullLogger(), engine=engine, d1=d1_fake
    ).load_current_owner()
    return umk, parse_owner_account(payload)


def _cleaner(d1_fake, r2, engine, *, dry_run=False) -> DbCleaner:
    cleaner = object.__new__(DbCleaner)
    cleaner.logger = CapturingLogger()
    cleaner.dry_run = dry_run
    cleaner.engine = engine
    cleaner.blob = CryptoBlob(engine)
    cleaner.owner = OwnerInitializer(
        CF_CREDS, CF_CREDS_PATH, cleaner.logger, engine=engine, d1=d1_fake
    )
    cleaner.r2 = r2
    return cleaner


def test_removes_a_stuck_deleting_share_and_its_key_store_row(d1, engine):
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    share_id_hash = b"h" * 32
    d1.add_share(share_id_hash, "stuck-path", "deleting", umk, blob)
    key_id = d1.shares[share_id_hash]["key_id"]
    r2 = FakeR2Client()

    cleaner = _cleaner(d1, r2, engine)
    cleaner.run()

    assert r2.deleted == [f"{account.db_prefix}/shared/stuck-path"]
    assert share_id_hash not in d1.shares
    assert key_id not in d1.key_store


def test_leaves_an_active_share_untouched(d1, engine):
    umk, _ = _account(d1, engine)
    blob = CryptoBlob(engine)
    share_id_hash = b"h" * 32
    d1.add_share(share_id_hash, "active-path", "active", umk, blob)
    r2 = FakeR2Client()

    cleaner = _cleaner(d1, r2, engine)
    cleaner.run()

    assert r2.deleted == []
    assert share_id_hash in d1.shares


def test_dry_run_removes_nothing(d1, engine):
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    share_id_hash = b"h" * 32
    d1.add_share(share_id_hash, "stuck-path", "deleting", umk, blob)
    r2 = FakeR2Client()

    cleaner = _cleaner(d1, r2, engine, dry_run=True)
    cleaner.run()

    assert r2.deleted == []
    assert share_id_hash in d1.shares
    assert (
        f"Would remove stuck-deleting share at {account.db_prefix}/shared/stuck-path..."
        in cleaner.logger.verbose_messages
    )
    assert (
        cleaner.logger.info_messages[-1] == "1 stale share row(s) would be cleaned up."
    )
