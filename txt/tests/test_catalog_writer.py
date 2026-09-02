import re

import pytest

from txt.catalog_writer import CatalogWriter, DocumentStore
from txt.crypto_blob import CryptoBlob


class FakeD1:
    """A minimal in-memory stand-in matching exactly the SQL shapes
    catalog_writer.py issues -- not a general SQL engine."""

    def __init__(self):
        self.key_store = {}
        self.documents = {}
        self.bookmarks = {}
        self.catalog = None
        self._next_id = 1

    def _alloc_id(self) -> int:
        id_ = self._next_id
        self._next_id += 1
        return id_

    def query_one(self, sql, _params=None):
        if sql.startswith("SELECT key_id, catalog_blob FROM catalog"):
            return self.catalog
        if sql.startswith("SELECT wrapped_key FROM key_store"):
            key_id = int(re.search(r"id = (\d+)", sql).group(1))
            row = self.key_store.get(key_id)
            return {"wrapped_key": row["wrapped_key"]} if row else None
        raise AssertionError(f"unexpected query_one: {sql}")

    def execute(self, sql, params=None):
        sql = sql.strip()
        if sql.startswith("INSERT INTO key_store"):
            return self._insert_key(sql, params)
        if sql.startswith("DELETE FROM key_store"):
            key_id = int(re.search(r"id = (\d+)", sql).group(1))
            self.key_store.pop(key_id, None)
            return {"meta": {}}
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

    def _insert_key(self, sql, params):
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
    def __init__(self):
        self.objects = {}
        self.put_calls = []

    def get_object(self, key):
        return self.objects.get(key)

    def put_object(self, key, body, *, if_match=None, if_none_match=False):
        self.put_calls.append((key, body))
        self.objects[key] = body


@pytest.fixture
def store(engine):
    return DocumentStore(
        FakeD1(), FakeR2Client(), CryptoBlob(engine), b"u" * 128, "prefix"
    )


def test_insert_document_defaults_to_unread_access_state(store):
    document_id = store.insert_document(b"c" * 128, "path123")

    row = store.d1.documents[document_id]
    access_row_key = store.unwrap_key(row["access_key_id"])
    payload = store.blob.decrypt_json(row["access_blob"], access_row_key)
    assert payload == {"last_accessed": 0, "last_cfi": None}


def test_insert_document_preserves_supplied_reading_state(store):
    document_id = store.insert_document(
        b"c" * 128, "path123", last_accessed=1234, last_cfi="epubcfi(/6/2)"
    )

    row = store.d1.documents[document_id]
    access_row_key = store.unwrap_key(row["access_key_id"])
    payload = store.blob.decrypt_json(row["access_blob"], access_row_key)
    assert payload == {"last_accessed": 1234, "last_cfi": "epubcfi(/6/2)"}


def test_insert_document_failure_leaves_no_orphaned_key_store_rows(store):
    def failing_insert(sql, params=None):
        if sql.startswith("INSERT INTO documents"):
            raise RuntimeError("simulated D1 failure")
        return FakeD1.execute(store.d1, sql, params)

    store.d1.execute = failing_insert

    with pytest.raises(RuntimeError, match="simulated D1 failure"):
        store.insert_document(b"c" * 128, "path123")

    assert store.d1.key_store == {}


def test_insert_bookmark_round_trips_cfi_page_and_preview(store):
    bookmark_id = store.insert_bookmark(7, "epubcfi(/6/4)", 12, "Fear.", 555)

    row = store.d1.bookmarks[bookmark_id]
    assert row["document_id"] == 7
    assert row["created_at"] == 555
    row_key = store.unwrap_key(row["key_id"])
    payload = store.blob.decrypt_json(row["bookmark_blob"], row_key)
    assert payload == {"cfi": "epubcfi(/6/4)", "page_number": 12, "preview": "Fear."}


def test_insert_bookmark_failure_leaves_no_orphaned_key_store_row(store):
    def failing_insert(sql, params=None):
        if sql.startswith("INSERT INTO bookmarks"):
            raise RuntimeError("simulated D1 failure")
        return FakeD1.execute(store.d1, sql, params)

    store.d1.execute = failing_insert

    with pytest.raises(RuntimeError, match="simulated D1 failure"):
        store.insert_bookmark(7, "epubcfi(/6/4)", None, "", 0)

    assert store.d1.key_store == {}


def test_catalog_state_covered_ids_track_existing_entries(store):
    catalog = CatalogWriter(store)
    state = catalog.load_state()
    assert state.existing_key_id is None
    assert state.covered_ids == set()

    added = catalog.add_entry(state, 1, {"name": "a.epub"})
    assert added is True
    assert state.covered_ids == {1}

    added_again = catalog.add_entry(state, 1, {"name": "a.epub"})
    assert added_again is False
    assert len(state.entries) == 1


def test_publish_then_load_round_trips_entries(store):
    catalog = CatalogWriter(store)
    state = catalog.load_state()
    catalog.add_entry(state, 1, {"name": "a.epub"})
    catalog.publish(state)

    reloaded = CatalogWriter(store).load_state()
    assert reloaded.existing_key_id is not None
    assert reloaded.entries == [{"document_id": 1, "catalog": {"name": "a.epub"}}]

    catalog.add_entry(reloaded, 2, {"name": "b.epub"})
    catalog.publish(reloaded)
    twice_reloaded = CatalogWriter(store).load_state()
    assert {entry["document_id"] for entry in twice_reloaded.entries} == {1, 2}
