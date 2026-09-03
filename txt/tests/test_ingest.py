import base64
import json
import re

import brotli
import pytest

from txt.creds import OwnerCreds, R2Config
from txt.crypto_blob import CryptoBlob
from txt.ingest import TxtIngester
from txt.owner_init import OwnerInitializer

OWNER_EMAIL = "owner@example.com"

# Matches owner_init.py's _insert_owner() positional param order.
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
    owner_init.py and ingest.py issue -- not a general SQL engine."""

    def __init__(self):
        self.owner = None
        self.key_store = {}
        self.documents = {}
        self.catalog = None
        self._next_id = 1

    def _alloc_id(self) -> int:
        id_ = self._next_id
        self._next_id += 1
        return id_

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
            self.owner = dict(zip(OWNER_PARAM_FIELDS, params, strict=True))
            self.owner["sign_version"] = 1
            return {"meta": {}}
        if sql.startswith("INSERT INTO key_store"):
            purpose, wrapped_key = params
            id_ = self._alloc_id()
            self.key_store[id_] = {"purpose": purpose, "wrapped_key": wrapped_key}
            return {"meta": {"last_row_id": id_}}
        if sql.startswith("DELETE FROM key_store"):
            key_id = int(re.search(r"id = (\d+)", sql).group(1))
            self.key_store.pop(key_id, None)
            return {"meta": {}}
        if sql.startswith("INSERT INTO documents"):
            (content_blob,) = params
            match = re.search(r"VALUES \(\d+, (\d+), unhex\(\?\)\)", sql)
            id_ = self._alloc_id()
            self.documents[id_] = {
                "content_key_id": int(match.group(1)),
                "content_blob": content_blob,
            }
            return {"meta": {"last_row_id": id_}}
        if sql.startswith("INSERT INTO catalog"):
            (catalog_blob,) = params
            key_id = int(re.search(r"VALUES \(1, (\d+),", sql).group(1))
            self.catalog = {"key_id": key_id, "catalog_blob": catalog_blob}
            return {"meta": {}}
        if sql.startswith("UPDATE catalog"):
            (catalog_blob,) = params
            self.catalog["catalog_blob"] = catalog_blob
            return {"meta": {}}
        raise AssertionError(f"unexpected execute: {sql}")


class FakeR2Client:
    def __init__(self, _config, read_timeout=None):
        self.read_timeout = read_timeout
        self.objects = {}
        self.put_calls = []

    def get_object(self, key):
        return self.objects.get(key)

    def put_object(self, key, body, *, if_match=None, if_none_match=False):
        self.put_calls.append((key, body))
        self.objects[key] = body


CREDS = OwnerCreds(
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
    user_root_key=base64.b64encode(b"k" * 256).decode(),
)
CREDS_PATH = "unused-creds-path.json"


@pytest.fixture
def d1(engine):
    fake = FakeD1()
    OwnerInitializer(CREDS, CREDS_PATH, NullLogger(), engine=engine, d1=fake).run()
    return fake


def _write_epub(path, content=b"epub bytes"):
    path.write_bytes(b"PK\x03\x04mimetypeapplication/epub+zip" + content)


def _ingester(src, local, d1, r2, engine, logger=None):
    return TxtIngester(
        src,
        local,
        CREDS,
        CREDS_PATH,
        logger or NullLogger(),
        engine=engine,
        d1=d1,
        r2=r2,
    )


def test_ingest_fresh_directory(tmp_path, d1, engine):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")
    _write_epub(src / "b.epub", b"two")
    r2 = FakeR2Client(CREDS.r2_config)

    ingester = _ingester(src, local, d1, r2, engine)
    ingester.run()

    assert len(d1.documents) == 2
    content_puts = [k for k, _ in r2.put_calls if "/documents/" in k]
    assert len(content_puts) == 2
    catalog_puts = [k for k, _ in r2.put_calls if "/catalog/" in k]
    assert len(catalog_puts) == 1

    names = {entry["catalog"]["name"] for entry in _decode_catalog(d1, r2, ingester)}
    assert names == {"a.epub", "b.epub"}


def test_ingest_records_opf_sidecar_catalog_fields(tmp_path, d1, engine):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub")
    (src / "a.opf").write_text(
        '<package><metadata xmlns:dc="urn:dc"><dc:title>Hello</dc:title>'
        "<dc:creator>Frank Herbert</dc:creator>"
        "<dc:publisher>Ace</dc:publisher>"
        "</metadata></package>"
    )
    r2 = FakeR2Client(CREDS.r2_config)

    ingester = _ingester(src, local, d1, r2, engine)
    ingester.run()

    [entry] = _decode_catalog(d1, r2, ingester)
    assert entry["catalog"] == {
        "name": "a.epub",
        "title": "Hello",
        "authors": ["Frank Herbert"],
        "subjects": [],
        "publisher": "Ace",
    }


def test_second_run_is_a_no_op_for_unchanged_source(tmp_path, d1, engine):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")
    r2 = FakeR2Client(CREDS.r2_config)
    _ingester(src, local, d1, r2, engine).run()
    documents_after_first = dict(d1.documents)
    puts_after_first = len(r2.put_calls)

    _ingester(src, local, d1, r2, engine).run()

    assert d1.documents == documents_after_first
    assert len(r2.put_calls) == puts_after_first


def test_second_run_ingests_only_the_new_file(tmp_path, d1, engine):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")
    r2 = FakeR2Client(CREDS.r2_config)
    _ingester(src, local, d1, r2, engine).run()

    _write_epub(src / "b.epub", b"two")
    second = _ingester(src, local, d1, r2, engine)
    second.run()

    assert len(d1.documents) == 2
    names = {entry["catalog"]["name"] for entry in _decode_catalog(d1, r2, second)}
    assert names == {"a.epub", "b.epub"}


def test_crash_between_d1_write_and_catalog_rewrite_is_recovered_on_retry(
    tmp_path, d1, engine
):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")
    r2 = FakeR2Client(CREDS.r2_config)

    # Simulate a crash right after the D1 row lands but before the catalog
    # is ever touched: run the document-insert half of the pipeline
    # directly and write the checkpoint, without publishing a catalog.
    ingester = _ingester(src, local, d1, r2, engine)
    ingester._prepare_run()
    document_id = ingester._ensure_document(src / "a.epub", 1, 1)
    assert d1.catalog is None
    assert document_id in ingester.checkpoint.values()

    # Retry: a fresh ingester picks up the checkpoint and only has to
    # reconcile the catalog -- no duplicate documents/key_store rows.
    retry = _ingester(src, local, d1, r2, engine)
    retry.run()

    assert len(d1.documents) == 1
    names = {entry["catalog"]["name"] for entry in _decode_catalog(d1, r2, retry)}
    assert names == {"a.epub"}


def test_invalid_document_id_leaves_no_orphaned_key_store_rows(tmp_path, d1, engine):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub")
    r2 = FakeR2Client(CREDS.r2_config)
    ingester = _ingester(src, local, d1, r2, engine)
    ingester._prepare_run()

    real_execute = d1.execute

    def failing_documents_insert(sql, params=None):
        if sql.startswith("INSERT INTO documents"):
            raise RuntimeError("simulated D1 failure")
        return real_execute(sql, params)

    d1.execute = failing_documents_insert

    with pytest.raises(RuntimeError, match="simulated D1 failure"):
        ingester._insert_new_document(src / "a.epub", 1, 1)

    assert d1.key_store == {}


def _decode_catalog(d1_client, r2, ingester):
    engine = ingester.engine
    blob = CryptoBlob(engine)
    row_key = blob.decrypt(
        d1_client.key_store[d1_client.catalog["key_id"]]["wrapped_key"], ingester.umk
    )
    pointer = blob.decrypt_json(d1_client.catalog["catalog_blob"], row_key)
    catalog_key = base64.b64decode(pointer["catalog_key"])
    object_key = f"{ingester.account.db_prefix}/catalog/{pointer['catalog_path']}"
    data = r2.objects[object_key]
    return json.loads(brotli.decompress(blob.decrypt(data, catalog_key)))
