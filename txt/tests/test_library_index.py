import json
import secrets
import sqlite3

import brotli

from txt.crypto_blob import CryptoBlob
from txt.library_index import LibraryIndexBuilder


class FakeBB:
    """A stand-in for BBEngine exposing only the one query LibraryIndexBuilder
    issues -- txt/txt_meta rows, joined the same way the real BB would."""

    def __init__(self, docs):
        self.docs = docs  # list of (txt_id, metadata_dict_or_None)

    def query(self, sql, params=None):
        assert "FROM txt LEFT JOIN txt_meta" in sql
        return [
            (txt_id, brotli.compress(json.dumps(metadata).encode()) if metadata is not None else None)
            for txt_id, metadata in self.docs
        ]


def _decrypt_and_open(engine, encrypted, lib_idx_key):
    blob = CryptoBlob(engine)
    raw = brotli.decompress(blob.decrypt(encrypted, lib_idx_key))
    conn = sqlite3.connect(":memory:")
    conn.deserialize(raw)
    return conn


def test_library_index_round_trips_docs_and_terms(engine):
    lib_idx_key = secrets.token_bytes(128)
    docs = [
        (1, {"title": "Book One", "creator": [{"text": "Author A"}, {"text": "Author B"}], "subject": "Fiction"}),
        (2, {"title": "Book Two", "calibre:title_sort": "Book Two Sorted", "publisher": "Acme"}),
        (3, None),
    ]
    builder = LibraryIndexBuilder(FakeBB(docs), CryptoBlob(engine), lib_idx_key)

    encrypted, doc_count, content_hash = builder.build(built_at_version=7)

    assert doc_count == 3
    assert len(content_hash) == 16
    conn = _decrypt_and_open(engine, encrypted, lib_idx_key)

    rows = conn.execute("SELECT txt_id, title, sort_key FROM doc ORDER BY txt_id").fetchall()
    assert rows == [(1, "Book One", "Book One"), (2, "Book Two", "Book Two Sorted"), (3, "", None)]

    authors = conn.execute(
        "SELECT term.name FROM doc_term JOIN term ON term.id = doc_term.term_id "
        "WHERE doc_term.doc_id = 1 AND doc_term.kind = 1 ORDER BY doc_term.ord"
    ).fetchall()
    assert authors == [("Author A",), ("Author B",)]

    built = conn.execute("SELECT built_at_version, doc_count FROM built WHERE id = 1").fetchone()
    assert built == (7, 3)
    conn.close()


def test_library_index_interns_shared_terms(engine):
    lib_idx_key = secrets.token_bytes(128)
    docs = [(1, {"creator": "Shared Author"}), (2, {"creator": "Shared Author"})]
    builder = LibraryIndexBuilder(FakeBB(docs), CryptoBlob(engine), lib_idx_key)

    encrypted, _doc_count, _hash = builder.build(built_at_version=1)
    conn = _decrypt_and_open(engine, encrypted, lib_idx_key)

    terms = conn.execute("SELECT id, kind, name FROM term").fetchall()
    assert len(terms) == 1
    doc_terms = conn.execute("SELECT doc_id, term_id FROM doc_term ORDER BY doc_id").fetchall()
    assert doc_terms == [(1, terms[0][0]), (2, terms[0][0])]
    conn.close()


def test_library_index_wrong_key_fails_to_decrypt(engine):
    builder = LibraryIndexBuilder(FakeBB([(1, {"title": "Book"})]), CryptoBlob(engine), secrets.token_bytes(128))
    encrypted, _doc_count, _hash = builder.build(built_at_version=1)

    try:
        CryptoBlob(engine).decrypt(encrypted, secrets.token_bytes(128))
        assert False, "expected decryption to fail under the wrong key"
    except ValueError:
        pass
