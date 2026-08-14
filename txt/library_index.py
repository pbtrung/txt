"""Builds the library index (docs/data_model.md §8): a small stdlib-sqlite3
file projecting BB's txt/txt_meta, brotli-compressed and encrypted under an
HKDF subkey of db_master_key -- never the SQLCipher page key.
"""

import hashlib
import json
import sqlite3
import time

import brotli

from .crypto_blob import CryptoBlob

INDEX_SCHEMA = 1
AUTHOR, SUBJECT, PUBLISHER = 1, 2, 3

SCHEMA_SQL = """
CREATE TABLE doc (txt_id INTEGER PRIMARY KEY, title TEXT NOT NULL, sort_key TEXT);
CREATE TABLE term (id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, name TEXT NOT NULL);
CREATE UNIQUE INDEX idx_term_kind_name ON term(kind, name);
CREATE TABLE doc_term (doc_id INTEGER NOT NULL, kind INTEGER NOT NULL, ord INTEGER NOT NULL,
    term_id INTEGER NOT NULL, PRIMARY KEY (doc_id, kind, ord)) WITHOUT ROWID;
CREATE INDEX idx_doc_term_term ON doc_term(term_id, doc_id);
CREATE TABLE built (id INTEGER PRIMARY KEY CHECK (id = 1), index_schema INTEGER NOT NULL,
    built_at_version INTEGER NOT NULL, built_at INTEGER NOT NULL, doc_count INTEGER NOT NULL);
"""


def _text(value) -> str:
    return value["text"] if isinstance(value, dict) else value


def _as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _title(metadata: dict) -> str:
    titles = _as_list(metadata.get("title"))
    return _text(titles[0]) if titles else ""


class LibraryIndexBuilder:
    def __init__(self, bb, blob: CryptoBlob, db_master_key: bytes):
        self.bb = bb
        self.blob = blob
        self.db_master_key = db_master_key

    def build(self, built_at_version: int) -> tuple[bytes, int, bytes]:
        conn = sqlite3.connect(":memory:")
        try:
            doc_count = self._populate(conn, built_at_version)
            conn.commit()
            conn.execute("VACUUM")
            raw = conn.serialize()
        finally:
            conn.close()
        compressed = brotli.compress(raw, quality=5)
        encrypted = self.blob.encrypt(compressed, self._derive_key())
        return encrypted, doc_count, hashlib.blake2b(encrypted, digest_size=16).digest()

    def _derive_key(self) -> bytes:
        return self.blob.engine.hkdf_sha3_512(self.db_master_key, b"", b"library-index", 64)

    def _populate(self, conn: sqlite3.Connection, built_at_version: int) -> int:
        conn.executescript(SCHEMA_SQL)
        rows = self.bb.query(
            "SELECT txt.id, txt_meta.metadata FROM txt LEFT JOIN txt_meta ON txt_meta.txt_id = txt.id"
        )
        for txt_id, metadata_blob in rows:
            self._insert_doc(conn, txt_id, metadata_blob)
        conn.execute(
            "INSERT INTO built (id, index_schema, built_at_version, built_at, doc_count) VALUES (1, ?, ?, ?, ?)",
            (INDEX_SCHEMA, built_at_version, int(time.time() * 1000), len(rows)),
        )
        return len(rows)

    def _insert_doc(self, conn: sqlite3.Connection, txt_id: int, metadata_blob) -> None:
        metadata = self._decode_metadata(metadata_blob)
        title = _title(metadata)
        sort_key = metadata.get("calibre:title_sort", title or None)
        conn.execute("INSERT INTO doc (txt_id, title, sort_key) VALUES (?, ?, ?)", (txt_id, title, sort_key))
        self._insert_terms(conn, txt_id, AUTHOR, metadata.get("creator"))
        self._insert_terms(conn, txt_id, SUBJECT, metadata.get("subject"))
        self._insert_terms(conn, txt_id, PUBLISHER, metadata.get("publisher"))

    def _decode_metadata(self, metadata_blob) -> dict:
        if metadata_blob is None:
            return {}
        return json.loads(brotli.decompress(metadata_blob))

    def _insert_terms(self, conn: sqlite3.Connection, txt_id: int, kind: int, value) -> None:
        for ord_, name in enumerate(_text(v) for v in _as_list(value)):
            term_id = self._intern_term(conn, kind, name)
            conn.execute(
                "INSERT INTO doc_term (doc_id, kind, ord, term_id) VALUES (?, ?, ?, ?)",
                (txt_id, kind, ord_, term_id),
            )

    def _intern_term(self, conn: sqlite3.Connection, kind: int, name: str) -> int:
        conn.execute("INSERT OR IGNORE INTO term (kind, name) VALUES (?, ?)", (kind, name))
        return conn.execute("SELECT id FROM term WHERE kind = ? AND name = ?", (kind, name)).fetchone()[0]
