import base64
import re

import pytest

import txt.bucket_cleaner as bucket_cleaner_module
from txt.account_data import parse_owner_account
from txt.bucket_cleaner import BucketCleaner
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
        self.verbose_messages = []

    def info(self, message):
        self.info_messages.append(message)

    def verbose(self, message):
        self.verbose_messages.append(message)


class FakeD1:
    """A minimal in-memory stand-in matching exactly the SQL shapes
    owner_init.py/bucket_cleaner.py issue -- not a general SQL engine."""

    def __init__(self):
        self.owner = None
        self.key_store = {}
        self.documents = []
        self.catalog = None
        self._next_id = 1

    def _alloc_id(self) -> int:
        id_ = self._next_id
        self._next_id += 1
        return id_

    def query(self, sql, _params=None):
        if sql.strip().startswith("SELECT k.wrapped_key AS key_wrapped"):
            return self._document_rows(sql)
        raise AssertionError(f"unexpected query: {sql}")

    def _document_rows(self, sql):
        match = re.search(r"LIMIT (\d+) OFFSET (\d+)", sql)
        limit, offset = int(match.group(1)), int(match.group(2))
        page = self.documents[offset : offset + limit]
        return [
            {"key_wrapped": self.key_store[key_id]["wrapped_key"], "content_blob": blob}
            for key_id, blob in page
        ]

    def query_one(self, sql, _params=None):
        if "FROM owner" in sql:
            return self.owner
        if sql.startswith("SELECT key_id, catalog_blob FROM catalog"):
            return self.catalog
        if sql.startswith("SELECT wrapped_key FROM key_store"):
            key_id = int(sql.rsplit("= ", 1)[1])
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

    def add_document(self, path: str, umk: bytes, blob: CryptoBlob) -> None:
        row_key = b"r" * 128
        content_blob = blob.encrypt_json(
            {"content_key": base64.b64encode(b"x" * 128).decode(), "path": path},
            row_key,
        )
        key_id = self._alloc_id()
        self.key_store[key_id] = {
            "purpose": "content_key",
            "wrapped_key": blob.encrypt(row_key, umk),
        }
        self.documents.append((key_id, content_blob))

    def set_catalog(self, catalog_path: str, umk: bytes, blob: CryptoBlob) -> None:
        row_key = b"c" * 128
        key_id = self._alloc_id()
        self.key_store[key_id] = {
            "purpose": "catalog_key",
            "wrapped_key": blob.encrypt(row_key, umk),
        }
        pointer = {
            "catalog_key": base64.b64encode(b"k" * 128).decode(),
            "catalog_path": catalog_path,
        }
        self.catalog = {
            "key_id": key_id,
            "catalog_blob": blob.encrypt_json(pointer, row_key),
        }


class FakeR2Client:
    def __init__(self, _config=None):
        self.objects = {}
        self.deleted = []

    def get_object(self, key):
        return self.objects.get(key)

    def list_objects(self, prefix, on_progress=None):
        return [(key, len(body)) for key, body in self.objects.items()]

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


def _cleaner(d1_fake, r2, engine, *, dry_run=False) -> BucketCleaner:
    cleaner = object.__new__(BucketCleaner)
    cleaner.logger = CapturingLogger()
    cleaner.dry_run = dry_run
    cleaner.engine = engine
    cleaner.blob = CryptoBlob(engine)
    cleaner.owner = OwnerInitializer(
        CF_CREDS, CF_CREDS_PATH, cleaner.logger, engine=engine, d1=d1_fake
    )
    cleaner.r2 = r2
    return cleaner


def test_deletes_stale_objects_not_referenced_by_d1(d1, engine):
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    d1.add_document("book-path", umk, blob)
    r2 = FakeR2Client()
    r2.objects = {
        f"{account.db_prefix}/documents/book-path": b"referenced",
        f"{account.db_prefix}/documents/orphan-path": b"stale",
        "unrelated/key": b"stale too",
    }

    cleaner = _cleaner(d1, r2, engine)
    cleaner.run()

    assert sorted(r2.deleted) == sorted(
        [f"{account.db_prefix}/documents/orphan-path", "unrelated/key"]
    )


def test_retains_the_catalog_object(d1, engine):
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    d1.set_catalog("catalog-path", umk, blob)
    r2 = FakeR2Client()
    r2.objects = {
        f"{account.db_prefix}/catalog/catalog-path": b"catalog",
        f"{account.db_prefix}/catalog/orphan-path": b"stale",
    }

    cleaner = _cleaner(d1, r2, engine)
    cleaner.run()

    assert r2.deleted == [f"{account.db_prefix}/catalog/orphan-path"]


def test_retains_every_object_under_the_shared_prefix(d1, engine):
    _umk, account = _account(d1, engine)
    r2 = FakeR2Client()
    r2.objects = {
        f"{account.db_prefix}/shared/{'e' * 52}": b"no matching shares row at all",
        f"{account.db_prefix}/stale": b"stale",
    }

    cleaner = _cleaner(d1, r2, engine)
    cleaner.run()

    assert r2.deleted == [f"{account.db_prefix}/stale"]


def test_reports_detailed_per_category_stats(d1, engine):
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    d1.add_document("book-path", umk, blob)
    d1.set_catalog("catalog-path", umk, blob)
    r2 = FakeR2Client()
    r2.objects = {
        f"{account.db_prefix}/documents/book-path": b"12345",
        f"{account.db_prefix}/documents/orphan-path": b"ab",
        f"{account.db_prefix}/catalog/catalog-path": b"catalog!!",
        f"{account.db_prefix}/shared/{'e' * 52}": b"shared",
        "unrelated/key": b"x",
    }

    cleaner = _cleaner(d1, r2, engine)
    cleaner.run()

    messages = cleaner.logger.info_messages
    assert "bucket total: 5 object(s), 23 byte(s)." in messages
    assert "document: 2 object(s), 7 byte(s)." in messages
    assert "catalog: 1 object(s), 9 byte(s)." in messages
    assert "shared: 1 object(s), 6 byte(s)." in messages
    assert "other: 1 object(s), 1 byte(s)." in messages
    assert "stale: 2 object(s), 3 byte(s)." in messages


def test_reads_document_references_across_multiple_pages(d1, engine, monkeypatch):
    monkeypatch.setattr(bucket_cleaner_module, "PAGE_SIZE", 2)
    umk, account = _account(d1, engine)
    blob = CryptoBlob(engine)
    for i in range(5):
        d1.add_document(f"book-{i}", umk, blob)
    r2 = FakeR2Client()
    r2.objects = {f"{account.db_prefix}/documents/book-{i}": b"x" for i in range(5)}

    cleaner = _cleaner(d1, r2, engine)
    cleaner.run()

    # All 5 references were read across 3 pages of size 2 (2, 2, 1) -- if
    # pagination dropped or duplicated a row, some of these would show up
    # as stale and get deleted.
    assert r2.deleted == []
    reads = [m for m in cleaner.logger.info_messages if "document reference(s)" in m]
    assert reads == [
        "Read 2 document reference(s)...",
        "Read 4 document reference(s)...",
        "Read 5 document reference(s)...",
    ]


def test_dry_run_deletes_nothing_but_still_reports(d1, engine):
    _umk, account = _account(d1, engine)
    r2 = FakeR2Client()
    r2.objects = {f"{account.db_prefix}/stale": b"stale"}

    cleaner = _cleaner(d1, r2, engine, dry_run=True)
    cleaner.run()

    assert r2.deleted == []
    assert f"Would delete {account.db_prefix}/stale" in cleaner.logger.verbose_messages
    assert (
        cleaner.logger.info_messages[-1]
        == "Dry run: would delete 1 object(s), 5 byte(s)."
    )
