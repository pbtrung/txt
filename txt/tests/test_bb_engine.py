import secrets

import pytest

from txt.bb_engine import PAGE_SIZE, BBEngine


@pytest.fixture
def bb():
    engine = BBEngine()
    engine.open(secrets.token_bytes(256))
    yield engine
    engine.close()


def test_open_sets_pragmas(bb):
    assert bb.query("PRAGMA page_size;") == [(str(PAGE_SIZE),)]
    assert bb.query("PRAGMA journal_mode;") == [("memory",)]


def test_create_and_query_round_trip(bb):
    bb.exec_sql("CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT, c BLOB);")
    bb.execute("INSERT INTO t(a, b, c) VALUES (?, ?, ?)", [1, "hello", b"\x00\x01\x02"])
    bb.execute("INSERT INTO t(a, b, c) VALUES (?, ?, ?)", [2, "world", b"\xff\xfe"])

    rows = bb.query("SELECT a, b, c FROM t ORDER BY a;")
    assert rows == [(1, "hello", b"\x00\x01\x02"), (2, "world", b"\xff\xfe")]


def test_write_dirties_pages(bb):
    assert bb.drain_dirty_pages() == {}  # opening/pragma-ing alone writes nothing
    bb.exec_sql("CREATE TABLE t(a INTEGER);")
    dirty = bb.drain_dirty_pages()
    assert 1 in dirty
    assert all(len(data) == PAGE_SIZE for data in dirty.values())
    assert bb.drain_dirty_pages() == {}


def test_full_round_trip_through_reassembled_pages():
    key = secrets.token_bytes(256)

    first = BBEngine()
    first.open(key)
    first.exec_sql("CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT);")
    first.execute("INSERT INTO t(a, b) VALUES (?, ?)", [1, "row one"])
    first.execute("INSERT INTO t(a, b) VALUES (?, ?)", [2, "row two"])
    all_pages = dict(first.dirty_pages)
    first.close()

    second = BBEngine()
    second.load_pages(all_pages)
    second.open(key)
    rows = second.query("SELECT a, b FROM t ORDER BY a;")
    second.close()

    assert rows == [(1, "row one"), (2, "row two")]


def test_wrong_key_cannot_read_reassembled_pages():
    key = secrets.token_bytes(256)

    first = BBEngine()
    first.open(key)
    first.exec_sql("CREATE TABLE t(a INTEGER);")
    first.execute("INSERT INTO t(a) VALUES (?)", [1])
    all_pages = dict(first.dirty_pages)
    first.close()

    second = BBEngine()
    second.load_pages(all_pages)
    with pytest.raises(ValueError):
        second.open(secrets.token_bytes(256))
    second.close()
