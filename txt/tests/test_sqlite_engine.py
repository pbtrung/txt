import secrets

import pytest

from txt.sqlite_engine import SqliteEngine

# docs/crypto.md's key provisioning range: SQLCipher keys here must be 256-8192 bytes.
VALID_KEY_LEN = 256


@pytest.fixture
def key():
    return secrets.token_bytes(VALID_KEY_LEN)


@pytest.fixture
def engine(key):
    eng = SqliteEngine()
    eng.open(key)
    yield eng
    eng.close()


def test_round_trip_through_bytes(key, engine):
    engine.exec_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    engine.execute("INSERT INTO t (v) VALUES (?)", ["hello world"])
    data = engine.to_bytes()

    reopened = SqliteEngine()
    reopened.open(key, initial_bytes=data)
    assert reopened.query("SELECT id, v FROM t") == [(1, "hello world")]
    reopened.close()


def test_serialized_bytes_are_not_plaintext_sqlite(key, engine):
    engine.exec_sql("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    assert engine.to_bytes()[:16] != b"SQLite format 3\x00"


def test_wrong_key_cannot_read_back(key, engine):
    engine.exec_sql("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    data = engine.to_bytes()

    wrong = SqliteEngine()
    wrong.open(secrets.token_bytes(VALID_KEY_LEN), initial_bytes=data)
    with pytest.raises(ValueError):
        wrong.query("SELECT id FROM t")
    wrong.close()


def test_undersized_key_raises():
    # sqlite3_key() itself would silently leave the connection unkeyed
    # (plaintext) rather than fail outright; we raise instead, since a
    # db_master_key this size can only mean a bug upstream, and silently
    # falling through to plaintext storage is the wrong failure mode here.
    eng = SqliteEngine()
    with pytest.raises(ValueError):
        eng.open(secrets.token_bytes(8))  # below the 256-byte minimum
    eng.close()


def test_bind_and_column_types_round_trip(engine):
    engine.exec_sql("CREATE TABLE t (i INTEGER, s TEXT, b BLOB, n INTEGER)")
    engine.execute(
        "INSERT INTO t (i, s, b, n) VALUES (?, ?, ?, ?)",
        [7, "abc", b"\x00\x01\x02", None],
    )
    row = engine.query("SELECT i, s, b, n FROM t")[0]
    assert row == (7, "abc", b"\x00\x01\x02", None)


def test_empty_and_memoryview_values_remain_blobs(engine):
    engine.exec_sql("CREATE TABLE t (empty_text TEXT, empty_blob BLOB, view BLOB)")
    engine.execute("INSERT INTO t VALUES (?, ?, ?)", ["", b"", memoryview(b"view")])

    assert engine.query("SELECT empty_text, empty_blob, view FROM t") == [
        ("", b"", b"view")
    ]


def test_last_insert_rowid(engine):
    engine.exec_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    engine.execute("INSERT INTO t (v) VALUES (?)", ["a"])
    engine.execute("INSERT INTO t (v) VALUES (?)", ["b"])
    assert engine.last_insert_rowid() == 2


def test_vacuum_preserves_data(engine):
    engine.exec_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    engine.execute("INSERT INTO t (v) VALUES (?)", ["a"])
    engine.execute("DELETE FROM t WHERE v = 'a'")
    engine.execute("INSERT INTO t (v) VALUES (?)", ["b"])
    engine.vacuum()
    assert engine.query("SELECT v FROM t") == [("b",)]


def test_bad_sql_raises(engine):
    with pytest.raises(ValueError):
        engine.exec_sql("NOT VALID SQL")


def test_query_step_error_raises(engine):
    with pytest.raises(ValueError, match="step failed"):
        engine.query("SELECT abs(-9223372036854775808)")
