import base64
import json
import re

import brotli
import pytest

from txt.account_data import parse_owner_account
from txt.catalog_checker import CatalogChecker
from txt.creds import OwnerCreds, R2Config
from txt.crypto_blob import CryptoBlob
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
    owner_init.py/catalog_writer.py/catalog_checker.py issue -- not a
    general SQL engine."""

    def __init__(self):
        self.owner = None
        self.key_store = {}
        self.document_ids: list[int] = []
        self.catalog = None
        self._next_id = 1

    def _alloc_id(self) -> int:
        id_ = self._next_id
        self._next_id += 1
        return id_

    def query(self, sql, _params=None):
        if sql.strip().startswith("SELECT id FROM documents"):
            last_id = int(re.search(r"id > (\d+)", sql).group(1))
            limit = int(re.search(r"LIMIT (\d+)", sql).group(1))
            page = sorted(i for i in self.document_ids if i > last_id)[:limit]
            return [{"id": i} for i in page]
        raise AssertionError(f"unexpected query: {sql}")

    def query_one(self, sql, _params=None):
        if "FROM owner" in sql:
            return self.owner
        if sql.startswith("SELECT key_id, catalog_blob FROM catalog"):
            return self.catalog
        if sql.startswith("SELECT wrapped_key FROM key_store"):
            key_id = int(re.search(r"id = (\d+)", sql).group(1))
            row = self.key_store.get(key_id)
            return {"wrapped_key": row["wrapped_key"]} if row else None
        raise AssertionError(f"unexpected query_one: {sql}")

    def execute(self, sql, params=None):
        sql = sql.strip()
        if sql.startswith("INSERT INTO owner"):
            return self._insert_owner(params)
        if sql.startswith("INSERT INTO key_store"):
            return self._insert_key(params)
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


class FakeR2Client:
    def __init__(self):
        self.objects = {}

    def get_object(self, key):
        return self.objects.get(key)


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


def _set_catalog(d1_fake, umk, blob: CryptoBlob, document_ids: list[int]) -> None:
    row_key = b"c" * 128
    catalog_key = b"k" * 128
    key_id = d1_fake._alloc_id()
    d1_fake.key_store[key_id] = {
        "purpose": "catalog_key",
        "wrapped_key": blob.encrypt(row_key, umk),
    }
    pointer = {
        "catalog_key": base64.b64encode(catalog_key).decode(),
        "catalog_path": "catalog-path",
    }
    d1_fake.catalog = {
        "key_id": key_id,
        "catalog_blob": blob.encrypt_json(pointer, row_key),
    }
    return catalog_key


def _checker(d1_fake, r2, engine) -> CatalogChecker:
    checker = object.__new__(CatalogChecker)
    checker.logger = CapturingLogger()
    checker.blob = CryptoBlob(engine)
    checker.owner = OwnerInitializer(
        CF_CREDS, CF_CREDS_PATH, checker.logger, engine=engine, d1=d1_fake
    )
    checker.r2 = r2
    return checker


def _upload_catalog(r2, db_prefix, catalog_key, blob, document_ids: list[int]) -> None:
    entries = [
        {"document_id": i, "catalog": {"name": f"{i}.epub"}} for i in document_ids
    ]
    object_key = f"{db_prefix}/catalog/catalog-path"
    r2.objects[object_key] = blob.encrypt(
        brotli.compress(json.dumps(entries).encode()), catalog_key
    )


def test_reports_clean_when_documents_and_catalog_match(d1, engine):
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    d1.document_ids = [1, 2, 3]
    catalog_key = _set_catalog(d1, umk, blob, [1, 2, 3])
    r2 = FakeR2Client()
    _upload_catalog(r2, account.db_prefix, catalog_key, blob, [1, 2, 3])

    checker = _checker(d1, r2, engine)
    checker.run()

    assert (
        "Every document is represented in the catalog." in checker.logger.info_messages
    )
    assert (
        "Every catalog entry references a real document."
        in checker.logger.info_messages
    )


def test_reports_documents_missing_from_the_catalog(d1, engine):
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    d1.document_ids = [1, 2, 3]
    catalog_key = _set_catalog(d1, umk, blob, [1, 2])
    r2 = FakeR2Client()
    _upload_catalog(r2, account.db_prefix, catalog_key, blob, [1, 2])

    checker = _checker(d1, r2, engine)
    checker.run()

    assert any(
        "1 document(s) missing from the catalog" in m and "[3]" in m
        for m in checker.logger.info_messages
    )
    assert (
        "Every catalog entry references a real document."
        in checker.logger.info_messages
    )


def test_reports_catalog_entries_with_no_matching_document(d1, engine):
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    d1.document_ids = [1, 2]
    catalog_key = _set_catalog(d1, umk, blob, [1, 2, 3])
    r2 = FakeR2Client()
    _upload_catalog(r2, account.db_prefix, catalog_key, blob, [1, 2, 3])

    checker = _checker(d1, r2, engine)
    checker.run()

    assert (
        "Every document is represented in the catalog." in checker.logger.info_messages
    )
    assert any(
        "1 catalog entries reference a document_id that doesn't exist" in m
        and "[3]" in m
        for m in checker.logger.info_messages
    )


def test_handles_a_library_with_no_catalog_row_yet(d1, engine):
    d1.document_ids = [1, 2]
    r2 = FakeR2Client()

    checker = _checker(d1, r2, engine)
    checker.run()

    assert any(
        "2 document(s) missing from the catalog" in m
        for m in checker.logger.info_messages
    )
