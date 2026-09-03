import base64
import json
import re
import secrets

import brotli
import pytest

from txt.creds import OwnerCreds, R2Config
from txt.crypto_blob import CryptoBlob
from txt.database_schema import (
    CREATE_TXT_BOOKMARKS_SQL,
    CREATE_TXT_SQL,
    configure_database,
)
from txt.migrate_rql import (
    RqlMigrator,
    RqlMigratorDeps,
    RqlOwnerCreds,
    load_rql_creds,
)
from txt.owner_init import OwnerInitializer
from txt.random_token import to_base32_crockford
from txt.sqlite_engine import SqliteEngine

OWNER_EMAIL = "owner@example.com"
FIREBASE_UID = "old-owner-uid"

# Matches owner_init.py's _insert_owner() positional param order (new/D1 side).
OWNER_PARAM_FIELDS = [
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
    """A minimal in-memory stand-in matching exactly the SQL shapes
    owner_init.py/catalog_writer.py issue -- not a general SQL engine."""

    def __init__(self):
        self.owner = None
        self.key_store = {}
        self.documents = {}
        self.bookmarks = {}
        self.catalog = None
        self._next_id = 1

    def _alloc_id(self) -> int:
        id_ = self._next_id
        self._next_id += 1
        return id_

    def query(self, sql, _params=None):
        if sql.startswith("SELECT id, content_key_id, content_blob FROM documents"):
            threshold = int(re.search(r"id > (\d+)", sql).group(1))
            return [
                {
                    "id": id_,
                    "content_key_id": doc["content_key_id"],
                    "content_blob": doc["content_blob"],
                }
                for id_, doc in sorted(self.documents.items())
                if id_ > threshold
            ]
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
        if sql.startswith("DELETE FROM key_store"):
            key_id = int(re.search(r"id = (\d+)", sql).group(1))
            self.key_store.pop(key_id, None)
            return {"meta": {}}
        return self._execute_content(sql, params)

    def _execute_content(self, sql, params):
        if sql.startswith("INSERT INTO documents"):
            return self._insert_document(sql, params)
        if sql.startswith("INSERT INTO bookmarks"):
            return self._insert_bookmark(sql, params)
        if sql.startswith("INSERT INTO catalog"):
            return self._insert_catalog(sql, params)
        if sql.startswith("UPDATE catalog"):
            (catalog_blob,) = params
            self.catalog["catalog_blob"] = catalog_blob
            return {"meta": {}}
        raise AssertionError(f"unexpected execute: {sql}")

    def _insert_owner(self, params):
        self.owner = dict(zip(OWNER_PARAM_FIELDS, params, strict=True))
        self.owner["sign_version"] = 1
        return {"meta": {}}

    def _insert_key(self, params):
        purpose, wrapped_key = params
        id_ = self._alloc_id()
        self.key_store[id_] = {"purpose": purpose, "wrapped_key": wrapped_key}
        return {"meta": {"last_row_id": id_}}

    def _insert_document(self, sql, params):
        content_blob, access_blob = params
        match = re.search(
            r"VALUES \(\d+, (\d+), unhex\(\?\), (\d+), unhex\(\?\)\)", sql
        )
        id_ = self._alloc_id()
        self.documents[id_] = {
            "content_key_id": int(match.group(1)),
            "content_blob": content_blob,
            "access_key_id": int(match.group(2)),
            "access_blob": access_blob,
        }
        return {"meta": {"last_row_id": id_}}

    def _insert_bookmark(self, sql, params):
        (bookmark_blob,) = params
        match = re.search(r"VALUES \((\d+), (\d+), (\d+), unhex\(\?\)\)", sql)
        id_ = self._alloc_id()
        self.bookmarks[id_] = {
            "document_id": int(match.group(1)),
            "created_at": int(match.group(2)),
            "key_id": int(match.group(3)),
            "bookmark_blob": bookmark_blob,
        }
        return {"meta": {"last_row_id": id_}}

    def _insert_catalog(self, sql, params):
        (catalog_blob,) = params
        key_id = int(re.search(r"VALUES \(1, (\d+),", sql).group(1))
        self.catalog = {"key_id": key_id, "catalog_blob": catalog_blob}
        return {"meta": {}}


class FakeR2Client:
    def __init__(self, _config=None, read_timeout=None):
        self.objects = {}
        self.put_calls = []

    def get_object(self, key):
        return self.objects.get(key)

    def put_object(self, key, body, *, if_match=None, if_none_match=False):
        self.put_calls.append((key, body))
        self.objects[key] = body


class FakeRqlite:
    def __init__(self, row):
        self.row = row

    def query_one(self, _sql, _params=None):
        return self.row


class FakeAuth:
    def __init__(self, _api_key):
        pass

    def sign_in(self, _email, _password):
        return FIREBASE_UID


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

RQL_ROOT_KEY = b"r" * 256
RQL_CREDS = RqlOwnerCreds(
    rqlite_admin_username="admin",
    rqlite_admin_password="secret",
    rqlite_operator_url="https://api.example.com/operator/rqlite",
    firebase_email="owner@example.com",
    firebase_password="pw",
    firebase_api_key="key",
    user_root_key=base64.b64encode(RQL_ROOT_KEY).decode(),
    r2_config=R2Config(
        endpoint="https://old-account.r2.cloudflarestorage.com",
        read_write_access_key_id="old-rw-id",
        read_write_secret_access_key="old-rw-secret",
        region="auto",
        bucket="old-books",
    ),
)

OLD_DB_PATH = "a" * 52
OLD_DB_PREFIX = "b" * 52


def _old_owner_control_row(engine, umk: bytes) -> dict:
    blob = CryptoBlob(engine)
    payload = {
        "user_handle": base64.b64encode(b"h" * 32).decode(),
        "display_name": "Trung",
        "db_master_key": base64.b64encode(b"m" * 256).decode(),
        "db_path": OLD_DB_PATH,
        "db_prefix": OLD_DB_PREFIX,
    }
    return {
        "firebase_uid": FIREBASE_UID,
        "wrapped_umk": blob.encrypt(umk, RQL_ROOT_KEY),
        "encrypted_credentials": blob.encrypt_json(payload, umk),
    }, base64.b64decode(payload["db_master_key"])


def _catalog_blob(name: str) -> bytes:
    payload = {
        "name": name,
        "title": name,
        "authors": [],
        "subjects": [],
        "publisher": None,
    }
    return brotli.compress(json.dumps(payload).encode())


def _old_database_bytes(db_master_key: bytes, rows: list[dict]) -> bytes:
    engine = SqliteEngine()
    engine.open(db_master_key)
    # page_size must be set before the first CREATE TABLE -- SQLite only
    # honors PRAGMA page_size on an empty database.
    configure_database(engine)
    engine.exec_sql(CREATE_TXT_SQL)
    engine.exec_sql(CREATE_TXT_BOOKMARKS_SQL)
    for row in rows:
        _insert_old_txt_row(engine, row)
    data = engine.to_bytes()
    engine.close()
    return data


def _insert_old_txt_row(engine, row: dict) -> None:
    engine.execute(
        "INSERT INTO txt (id, txt_key, txt_prefix, path, catalog, last_accessed, "
        "last_cfi, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        [
            row["id"],
            row["txt_key"],
            row["txt_prefix"],
            row["path"],
            _catalog_blob(row["name"]),
            row.get("last_accessed", 0),
            row.get("last_cfi"),
        ],
    )
    for bookmark in row.get("bookmarks", []):
        engine.execute(
            "INSERT INTO txt_bookmarks (txt_id, cfi, page_number, preview, "
            "created_at) VALUES (?, ?, ?, ?, ?)",
            [
                row["id"],
                bookmark["cfi"],
                bookmark.get("page_number"),
                bookmark.get("preview", ""),
                bookmark["created_at"],
            ],
        )


@pytest.fixture
def d1(engine):
    fake = FakeD1()
    OwnerInitializer(
        CF_CREDS, CF_CREDS_PATH, NullLogger(), engine=engine, d1=fake
    ).run()
    return fake


def _row(id_, name, *, last_accessed=0, last_cfi=None, bookmarks=()):
    return {
        "id": id_,
        "name": name,
        "txt_key": bytes([id_]) * 128,
        "txt_prefix": bytes([id_]) * 32,
        "path": bytes([id_ + 100]) * 32,
        "last_accessed": last_accessed,
        "last_cfi": last_cfi,
        "bookmarks": list(bookmarks),
    }


def _migrator(tmp_path, d1_fake, r2_old, r2_new, engine, *, limit=None):
    return RqlMigrator(
        RQL_CREDS,
        CF_CREDS,
        CF_CREDS_PATH,
        tmp_path / "local",
        NullLogger(),
        limit=limit,
        deps=RqlMigratorDeps(
            engine=engine,
            rqlite=None,  # set per-test via .rqlite override below
            auth_factory=FakeAuth,
            d1=d1_fake,
            r2_old=r2_old,
            r2_new=r2_new,
        ),
    )


def _setup_old_system(engine, rows, content: dict[bytes, bytes]):
    umk_old = b"o" * 128
    owner_row, db_master_key = _old_owner_control_row(engine, umk_old)
    r2_old = FakeR2Client()
    r2_old.objects[OLD_DB_PATH] = _old_database_bytes(db_master_key, rows)
    for key, value in content.items():
        r2_old.objects[key] = value
    return FakeRqlite(owner_row), r2_old


def _content_key(row, _blob: CryptoBlob) -> str:
    prefix = to_base32_crockford(row["txt_prefix"])
    path = to_base32_crockford(row["path"])
    return f"{OLD_DB_PREFIX}/{prefix}/{path}"


def test_migrates_documents_reading_state_bookmarks_and_catalog(tmp_path, d1, engine):
    blob = CryptoBlob(engine)
    rows = [
        _row(
            1,
            "a.epub",
            last_accessed=111,
            last_cfi="epubcfi(/6/2)",
            bookmarks=[
                {
                    "cfi": "epubcfi(/6/2)",
                    "page_number": 3,
                    "preview": "Fear.",
                    "created_at": 42,
                }
            ],
        ),
        _row(2, "b.epub"),
    ]
    content = {
        _content_key(row, blob): blob.encrypt(
            f"epub-{row['id']}".encode(), row["txt_key"]
        )
        for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite
    migrator.run()

    assert len(d1.documents) == 2
    assert len(d1.bookmarks) == 1
    content_puts = [k for k, _ in r2_new.put_calls if "/documents/" in k]
    assert len(content_puts) == 2

    doc1 = d1.documents[migrator.checkpoint["1"]["document_id"]]
    access_row_key = blob.decrypt(
        d1.key_store[doc1["access_key_id"]]["wrapped_key"], migrator.store_new.umk
    )
    access = blob.decrypt_json(doc1["access_blob"], access_row_key)
    assert access == {"last_accessed": 111, "last_cfi": "epubcfi(/6/2)"}

    bookmark = next(iter(d1.bookmarks.values()))
    bookmark_row_key = blob.decrypt(
        d1.key_store[bookmark["key_id"]]["wrapped_key"], migrator.store_new.umk
    )
    payload = blob.decrypt_json(bookmark["bookmark_blob"], bookmark_row_key)
    assert payload == {"cfi": "epubcfi(/6/2)", "page_number": 3, "preview": "Fear."}

    names = {
        entry["catalog"]["name"] for entry in _decode_catalog(d1, r2_new, migrator)
    }
    assert names == {"a.epub", "b.epub"}


def test_a_lost_checkpoint_entry_is_recovered_by_content_match(tmp_path, d1, engine):
    blob = CryptoBlob(engine)
    rows = [_row(1, "1.epub"), _row(2, "2.epub")]
    content = {
        _content_key(row, blob): blob.encrypt(
            f"epub-{row['id']}".encode(), row["txt_key"]
        )
        for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite
    migrator._prepare_run()

    # Simulate the exact race this recovers from: row 2's content already
    # made it into D1/R2 from a prior, interrupted run -- the D1 insert
    # succeeded, but the process died before a checkpoint entry for it was
    # ever written, so this run's checkpoint has no record of it at all
    # (and, since reaching bookmarks requires that very entry, none of
    # its bookmarks were touched either).
    content_key = secrets.token_bytes(128)
    path = to_base32_crockford(secrets.token_bytes(32))
    migrator.store_new.upload_content(path, b"epub-2", content_key)
    orphan_document_id = migrator.store_new.insert_document(content_key, path)

    migrator.run()

    # Row 1 migrates normally; row 2 is matched to the orphan by content
    # and reuses it instead of uploading a duplicate.
    assert len(d1.documents) == 2
    content_puts = [k for k, _ in r2_new.put_calls if "/documents/" in k]
    assert len(content_puts) == 2  # the orphan's own upload, plus row 1's
    assert migrator.checkpoint["2"]["document_id"] == orphan_document_id
    assert migrator.checkpoint["1"]["document_id"] != orphan_document_id


def test_limit_migrates_only_the_first_n_documents_by_ascending_id(
    tmp_path, d1, engine
):
    blob = CryptoBlob(engine)
    rows = [_row(i, f"{i}.epub") for i in range(1, 6)]
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine, limit=2)
    migrator.rqlite = rqlite
    migrator.run()

    assert len(d1.documents) == 2
    names = {
        entry["catalog"]["name"] for entry in _decode_catalog(d1, r2_new, migrator)
    }
    assert names == {"1.epub", "2.epub"}


def test_migrates_more_than_one_batch_of_new_documents(tmp_path, d1, engine):
    blob = CryptoBlob(engine)
    rows = [_row(i, f"{i}.epub") for i in range(1, 24)]  # > BATCH_SIZE (10)
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite
    migrator.run()

    assert len(d1.documents) == 23
    content_puts = [k for k, _ in r2_new.put_calls if "/documents/" in k]
    assert len(content_puts) == 23
    names = {
        entry["catalog"]["name"] for entry in _decode_catalog(d1, r2_new, migrator)
    }
    assert names == {f"{i}.epub" for i in range(1, 24)}


def test_catalog_is_published_once_per_batch_not_once_per_run(tmp_path, d1, engine):
    blob = CryptoBlob(engine)
    rows = [_row(i, f"{i}.epub") for i in range(1, 24)]  # 23 rows -> 3 batches of 10
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite
    migrator.run()

    # A run migrating thousands of documents can take a long time, so the
    # catalog object must grow visibly along the way -- one PUT per batch,
    # not one PUT at the very end of the whole run.
    db_prefix = migrator.account_new.db_prefix
    catalog_puts = [k for k, _ in r2_new.put_calls if f"{db_prefix}/catalog/" in k]
    assert len(catalog_puts) == 3


def test_catalog_stays_complete_across_multiple_runs_each_spanning_several_batches(
    tmp_path, d1, engine
):
    blob = CryptoBlob(engine)
    rows = [_row(i, f"{i}.epub") for i in range(1, 26)]  # 25 rows, > BATCH_SIZE
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    first = _migrator(tmp_path, d1, r2_old, r2_new, engine, limit=12)
    first.rqlite = rqlite
    first.run()
    assert len(d1.documents) == 12

    second = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    second.rqlite = rqlite
    second.run()

    assert len(d1.documents) == 25
    names = {entry["catalog"]["name"] for entry in _decode_catalog(d1, r2_new, second)}
    assert names == {f"{i}.epub" for i in range(1, 26)}


def test_catalog_still_publishes_completed_batches_when_a_later_batch_fails(
    tmp_path, d1, engine
):
    blob = CryptoBlob(engine)
    rows = [_row(i, f"{i}.epub") for i in range(1, 16)]  # 15 rows, > BATCH_SIZE
    # Only the first 10 rows' content actually exists in the old bucket --
    # the second batch (rows 11-15) will fail to download.
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows[:10]
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite

    with pytest.raises(ValueError, match="missing rqlite content object"):
        migrator.run()

    # The first batch's documents were inserted and checkpointed...
    assert len(d1.documents) == 10
    # ...and the catalog was published for them despite the second
    # batch's failure -- not silently left stale until some future run
    # happens to complete with no error at all (docs/data_model.md
    # §2.1's write-order/recovery guarantee, which this run's own
    # failure must not defeat).
    names = {
        entry["catalog"]["name"] for entry in _decode_catalog(d1, r2_new, migrator)
    }
    assert names == {f"{i}.epub" for i in range(1, 11)}


def test_rerun_with_nothing_new_still_repairs_a_stale_catalog(tmp_path, d1, engine):
    blob = CryptoBlob(engine)
    rows = [_row(i, f"{i}.epub") for i in range(1, 21)]  # 20 rows
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite
    migrator.run()
    assert len(d1.documents) == 20

    # Simulate the catalog having gone stale relative to D1/the checkpoint
    # (e.g. every run after the first happened to crash before ever
    # reaching catalog reconciliation): overwrite the published catalog
    # object with only its first 3 entries, in place, keeping the same
    # pointer/catalog_key so the row itself still resolves.
    row_key = blob.decrypt(
        d1.key_store[d1.catalog["key_id"]]["wrapped_key"], migrator.store_new.umk
    )
    pointer = blob.decrypt_json(d1.catalog["catalog_blob"], row_key)
    catalog_key = base64.b64decode(pointer["catalog_key"])
    object_key = f"{migrator.account_new.db_prefix}/catalog/{pointer['catalog_path']}"
    stale_entries = json.loads(
        brotli.decompress(blob.decrypt(r2_new.objects[object_key], catalog_key))
    )[:3]
    r2_new.objects[object_key] = blob.encrypt(
        brotli.compress(json.dumps(stale_entries).encode()), catalog_key
    )

    # A fresh migrator instance (same checkpoint file, same D1/R2) with
    # nothing left to migrate should still notice the gap and republish
    # the full catalog -- not silently leave it stale forever just
    # because there's nothing new in --limit's sense to process.
    rerun = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    rerun.rqlite = rqlite
    rerun.run()

    assert len(d1.documents) == 20  # unchanged -- nothing re-inserted
    names = {entry["catalog"]["name"] for entry in _decode_catalog(d1, r2_new, rerun)}
    assert names == {f"{i}.epub" for i in range(1, 21)}


def test_second_run_resumes_and_finishes_remaining_documents(tmp_path, d1, engine):
    blob = CryptoBlob(engine)
    rows = [_row(i, f"{i}.epub") for i in range(1, 4)]
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    first = _migrator(tmp_path, d1, r2_old, r2_new, engine, limit=2)
    first.rqlite = rqlite
    first.run()
    assert len(d1.documents) == 2

    second = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    second.rqlite = rqlite
    second.run()

    assert len(d1.documents) == 3
    names = {entry["catalog"]["name"] for entry in _decode_catalog(d1, r2_new, second)}
    assert names == {"1.epub", "2.epub", "3.epub"}


def test_second_run_is_a_no_op_for_already_migrated_documents(tmp_path, d1, engine):
    blob = CryptoBlob(engine)
    rows = [_row(1, "a.epub")]
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()
    first = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    first.rqlite = rqlite
    first.run()
    documents_after_first = dict(d1.documents)
    puts_after_first = len(r2_new.put_calls)

    second = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    second.rqlite = rqlite
    second.run()

    assert d1.documents == documents_after_first
    assert len(r2_new.put_calls) == puts_after_first


def test_crash_between_document_insert_and_bookmarks_is_recovered_on_retry(
    tmp_path, d1, engine
):
    blob = CryptoBlob(engine)
    rows = [
        _row(
            1,
            "a.epub",
            bookmarks=[
                {
                    "cfi": "epubcfi(/6/2)",
                    "page_number": 1,
                    "preview": "",
                    "created_at": 1,
                }
            ],
        )
    ]
    content = {
        _content_key(row, blob): blob.encrypt(b"x", row["txt_key"]) for row in rows
    }
    rqlite, r2_old = _setup_old_system(engine, rows, content)
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite
    migrator._prepare_run()
    checkpoint_entry = migrator._insert_new_document(
        1, rows[0]["txt_key"], rows[0]["txt_prefix"], rows[0]["path"], 0, None
    )
    assert checkpoint_entry["bookmarks_done"] is False
    assert len(d1.bookmarks) == 0

    retry = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    retry.rqlite = rqlite
    retry.run()

    assert len(d1.documents) == 1
    assert len(d1.bookmarks) == 1


def test_rejects_a_firebase_uid_mismatch(tmp_path, d1, engine):
    umk_old = b"o" * 128
    owner_row, _ = _old_owner_control_row(engine, umk_old)
    owner_row["firebase_uid"] = "someone-else"
    rqlite = FakeRqlite(owner_row)
    r2_old, r2_new = FakeR2Client(), FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite

    with pytest.raises(ValueError, match="different Firebase account"):
        migrator.run()


def test_raises_on_a_missing_content_object(tmp_path, d1, engine):
    rows = [_row(1, "a.epub")]
    rqlite, r2_old = _setup_old_system(
        engine, rows, {}
    )  # content object never uploaded
    r2_new = FakeR2Client()

    migrator = _migrator(tmp_path, d1, r2_old, r2_new, engine)
    migrator.rqlite = rqlite

    with pytest.raises(ValueError, match="missing rqlite content object"):
        migrator.run()


def test_load_rql_creds_validates_operator_url(tmp_path):
    path = tmp_path / "rql_creds.json"
    data = {
        "rqlite_admin_username": "admin",
        "rqlite_admin_password": "secret",
        "rqlite_operator_url": "http://api.example.com/operator/rqlite",
        "firebase_email": "a@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "user_root_key": base64.b64encode(b"r" * 256).decode(),
        "r2_config": {
            "endpoint": "https://old.r2.cloudflarestorage.com",
            "read_write_access_key_id": "id",
            "read_write_secret_access_key": "secret",
            "region": "auto",
            "bucket": "old-books",
        },
    }
    path.write_text(json.dumps(data))

    with pytest.raises(ValueError, match="rqlite_operator_url"):
        load_rql_creds(str(path))

    data["rqlite_operator_url"] = "https://api.example.com/operator/rqlite"
    path.write_text(json.dumps(data))
    creds = load_rql_creds(str(path))
    assert creds.rqlite_operator_url == "https://api.example.com/operator/rqlite"


def _decode_catalog(d1_client, r2, migrator):
    blob = migrator.blob
    row_key = blob.decrypt(
        d1_client.key_store[d1_client.catalog["key_id"]]["wrapped_key"],
        migrator.store_new.umk,
    )
    pointer = blob.decrypt_json(d1_client.catalog["catalog_blob"], row_key)
    catalog_key = base64.b64decode(pointer["catalog_key"])
    object_key = f"{migrator.account_new.db_prefix}/catalog/{pointer['catalog_path']}"
    data = r2.objects[object_key]
    return json.loads(brotli.decompress(blob.decrypt(data, catalog_key)))
