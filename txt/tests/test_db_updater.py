import base64

import pytest

from txt.creds import OwnerCreds, R2Config
from txt.db_updater import DbUpdater
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

    def info(self, message):
        self.info_messages.append(message)

    def verbose(self, _message):
        pass


class FakeD1:
    """A minimal in-memory stand-in matching exactly the SQL shapes
    owner_init.py/db_updater.py issue -- not a general SQL engine."""

    def __init__(self):
        self.owner = None
        self.documents = {}

    def query_one(self, sql, _params=None):
        if "FROM owner" in sql:
            return self.owner
        if sql.strip().startswith("SELECT count(*) AS n FROM documents"):
            n = sum(1 for row in self.documents.values() if row["access_key_id"])
            return {"n": n}
        raise AssertionError(f"unexpected query_one: {sql}")

    def execute(self, sql, params=None):
        sql = sql.strip()
        if sql.startswith("INSERT INTO owner"):
            return self._insert_owner(params)
        if sql.startswith("UPDATE documents SET access_blob = NULL"):
            return self._clear_access()
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

    def _clear_access(self):
        changed = 0
        for row in self.documents.values():
            if row["access_key_id"] is not None:
                row["access_key_id"] = None
                row["access_blob"] = None
                changed += 1
        return {"meta": {"changes": changed}}

    def add_document(self, doc_id: int, *, accessed: bool) -> None:
        self.documents[doc_id] = {
            "access_key_id": 100 + doc_id if accessed else None,
            "access_blob": b"blob" if accessed else None,
        }


@pytest.fixture
def d1(engine):
    fake = FakeD1()
    OwnerInitializer(
        CF_CREDS, CF_CREDS_PATH, NullLogger(), engine=engine, d1=fake
    ).run()
    return fake


def _updater(d1_fake, engine, *, dry_run=False) -> DbUpdater:
    updater = object.__new__(DbUpdater)
    updater.logger = CapturingLogger()
    updater.dry_run = dry_run
    updater.owner = OwnerInitializer(
        CF_CREDS, CF_CREDS_PATH, updater.logger, engine=engine, d1=d1_fake
    )
    return updater


def test_clears_access_state_on_every_accessed_document(d1, engine):
    d1.add_document(1, accessed=True)
    d1.add_document(2, accessed=True)
    d1.add_document(3, accessed=False)

    updater = _updater(d1, engine)
    updater.run()

    assert d1.documents[1] == {"access_key_id": None, "access_blob": None}
    assert d1.documents[2] == {"access_key_id": None, "access_blob": None}
    assert d1.documents[3] == {"access_key_id": None, "access_blob": None}
    assert "Cleared access state on 2 document(s)." in updater.logger.info_messages


def test_dry_run_reports_the_count_without_changing_anything(d1, engine):
    d1.add_document(1, accessed=True)
    d1.add_document(2, accessed=True)

    updater = _updater(d1, engine, dry_run=True)
    updater.run()

    assert d1.documents[1]["access_key_id"] is not None
    assert d1.documents[2]["access_key_id"] is not None
    assert (
        "Dry run: would clear access state on 2 document(s)."
        in updater.logger.info_messages
    )


def test_no_accessed_documents_is_a_clean_no_op(d1, engine):
    d1.add_document(1, accessed=False)

    updater = _updater(d1, engine)
    updater.run()

    assert "Cleared access state on 0 document(s)." in updater.logger.info_messages
