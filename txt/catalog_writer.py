"""Generic D1+R2 write helpers used by --ingest: minting per-row
key_store keys, inserting a documents/bookmarks row, and maintaining the
singleton R2-hosted catalog object (docs/data_model.md §2.1, §3).
Neither class touches the local filesystem or a source format --
callers supply already-read bytes/fields."""

import base64
import json
import secrets
import time
from dataclasses import dataclass, field

import brotli

from .random_token import to_base32_crockford


@dataclass
class CatalogState:
    existing_key_id: int | None
    row_key: bytes
    catalog_key: bytes
    catalog_path: str
    entries: list[dict]
    covered_ids: set = field(default_factory=set)

    def __post_init__(self):
        self.covered_ids = {entry["document_id"] for entry in self.entries}


class DocumentStore:
    """Mints key_store rows and inserts one documents/bookmarks row at a
    time, rolling back its own key_store rows if the documents insert
    fails (there is nothing else in this schema that reconciles a
    dangling key_store row)."""

    def __init__(self, d1, r2, blob, umk: bytes, db_prefix: str):
        self.d1, self.r2, self.blob = d1, r2, blob
        self.umk, self.db_prefix = umk, db_prefix

    def upload_content(self, path: str, data: bytes, content_key: bytes) -> str:
        object_key = self.content_object_key(path)
        self.put_content(object_key, self.encrypt_content(data, content_key))
        return object_key

    def content_object_key(self, path: str) -> str:
        return f"{self.db_prefix}/documents/{path}"

    def encrypt_content(self, data: bytes, content_key: bytes) -> bytes:
        return self.blob.encrypt(data, content_key)

    def put_content(self, object_key: str, encrypted: bytes) -> None:
        self.r2.put_object(object_key, encrypted, if_none_match=True)

    def insert_document(self, content_key: bytes, path: str) -> int:
        content_key_id, content_blob = self._content_key_and_blob(content_key, path)
        return self._insert_document_row_or_cleanup(content_key_id, content_blob)

    def _content_key_and_blob(self, content_key: bytes, path: str) -> tuple[int, bytes]:
        row_key = secrets.token_bytes(128)
        key_id = self.insert_key("content_key", row_key)
        return key_id, self._content_blob(path, content_key, row_key)

    def insert_key(self, purpose: str, plain_key: bytes) -> int:
        # Each wrapped key is a fresh random ciphertext, so it identifies
        # exactly the row this insert writes (D1Client.insert_row()).
        wrapped_key = self.blob.encrypt(plain_key, self.umk)
        return self.d1.insert_row(
            "INSERT INTO key_store (purpose, wrapped_key, created_at) "
            f"VALUES (?, unhex(?), {_now_ms()})",
            [purpose, wrapped_key],
            "SELECT id FROM key_store WHERE wrapped_key = unhex(?)",
            [wrapped_key],
        )

    def unwrap_key(self, key_id: int) -> bytes:
        row = self.d1.query_one(
            f"SELECT wrapped_key FROM key_store WHERE id = {key_id}"
        )
        return self.blob.decrypt(row["wrapped_key"], self.umk)

    def delete_key(self, key_id: int) -> None:
        self.d1.execute(f"DELETE FROM key_store WHERE id = {key_id}", idempotent=True)

    def _content_blob(self, path: str, content_key: bytes, content_row_key: bytes):
        return self.blob.encrypt_json(
            {"content_key": base64.b64encode(content_key).decode(), "path": path},
            content_row_key,
        )

    def _insert_document_row_or_cleanup(self, content_key_id, content_blob) -> int:
        try:
            return self._insert_document_row(content_key_id, content_blob)
        except Exception:
            self.delete_key(content_key_id)
            raise

    def _insert_document_row(self, content_key_id, content_blob) -> int:
        # access_key_id/access_blob start NULL -- a document costs no
        # key_store row for reading state until PATCH
        # /v1/documents/:id/access (worker/documentsEndpoint.ts) writes to
        # it for the first time.
        return self.d1.insert_row(
            "INSERT INTO documents (created_at, content_key_id, content_blob) "
            f"VALUES ({_now_ms()}, {content_key_id}, unhex(?))",
            [content_blob],
            "SELECT id FROM documents WHERE content_blob = unhex(?)",
            [content_blob],
        )


class CatalogWriter:
    QUERY = "SELECT key_id, catalog_blob FROM catalog WHERE singleton = 1"

    def __init__(self, store: DocumentStore):
        self.store = store

    def load_state(self) -> CatalogState:
        row = self.store.d1.query_one(self.QUERY)
        if row is None:
            return CatalogState(
                None,
                secrets.token_bytes(128),
                secrets.token_bytes(128),
                _new_path(),
                [],
            )
        return self._load_existing(row)

    def _load_existing(self, row: dict) -> CatalogState:
        row_key = self.store.unwrap_key(row["key_id"])
        pointer = self.store.blob.decrypt_json(row["catalog_blob"], row_key)
        catalog_key = base64.b64decode(pointer["catalog_key"])
        catalog_path = pointer["catalog_path"]
        entries = self._download_entries(catalog_path, catalog_key)
        return CatalogState(row["key_id"], row_key, catalog_key, catalog_path, entries)

    def _download_entries(self, catalog_path: str, catalog_key: bytes) -> list[dict]:
        object_key = f"{self.store.db_prefix}/catalog/{catalog_path}"
        data = self.store.r2.get_object(object_key)
        if data is None:
            return []
        return json.loads(brotli.decompress(self.store.blob.decrypt(data, catalog_key)))

    def add_entry(self, state: CatalogState, document_id: int, catalog: dict) -> bool:
        if document_id in state.covered_ids:
            return False
        state.entries.append({"document_id": document_id, "catalog": catalog})
        state.covered_ids.add(document_id)
        return True

    def publish(self, state: CatalogState) -> None:
        self._upload_object(state)
        catalog_blob = self._pointer_blob(state)
        if state.existing_key_id is None:
            self._create_row(state, catalog_blob)
        else:
            self._update_row(state.existing_key_id, catalog_blob)

    def _upload_object(self, state: CatalogState) -> None:
        object_key = f"{self.store.db_prefix}/catalog/{state.catalog_path}"
        data = self.store.blob.encrypt(
            brotli.compress(json.dumps(state.entries).encode()), state.catalog_key
        )
        self.store.r2.put_object(object_key, data)

    def _pointer_blob(self, state: CatalogState) -> bytes:
        return self.store.blob.encrypt_json(
            {
                "catalog_key": base64.b64encode(state.catalog_key).decode(),
                "catalog_path": state.catalog_path,
            },
            state.row_key,
        )

    def _create_row(self, state: CatalogState, catalog_blob: bytes) -> None:
        key_id = self.store.insert_key("catalog_key", state.row_key)
        self.store.d1.insert_row(
            "INSERT INTO catalog (singleton, key_id, catalog_blob, updated_at) "
            f"VALUES (1, {key_id}, unhex(?), {_now_ms()})",
            [catalog_blob],
            f"SELECT singleton AS id FROM catalog WHERE key_id = {key_id}",
            [],
        )

    def _update_row(self, key_id: int, catalog_blob: bytes) -> None:
        self.store.d1.execute(
            f"UPDATE catalog SET catalog_blob = unhex(?), updated_at = {_now_ms()} "
            f"WHERE singleton = 1 AND key_id = {key_id}",
            [catalog_blob],
            idempotent=True,  # sets absolute values; a replay changes nothing
        )


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_path() -> str:
    return to_base32_crockford(secrets.token_bytes(32))
