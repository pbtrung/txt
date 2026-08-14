import secrets
import struct

from txt.bundle import HEADER_FMT, HEADER_LEN, INDEX_ENTRY_FMT, MAGIC, MAP_ENTRY_FMT, BundleBuilder
from txt.crypto_blob import CryptoBlob

PAGE_SIZE = 32768


def _decrypt(engine, encrypted, db_master_key):
    blob = CryptoBlob(engine)
    key = engine.hkdf_sha3_512(db_master_key, b"", b"bundle", 64)
    return blob.decrypt(encrypted, key)


def test_bundle_round_trips_small_db_carries_every_page_whole(engine):
    db_master_key = secrets.token_bytes(256)
    live_pages = {
        1: (5, secrets.token_bytes(PAGE_SIZE)),
        2: (3, secrets.token_bytes(PAGE_SIZE)),
        3: (5, secrets.token_bytes(PAGE_SIZE)),
    }

    builder = BundleBuilder(CryptoBlob(engine), db_master_key)
    encrypted, map_rows, hot_page_count = builder.build(live_pages, PAGE_SIZE, built_at_version=5)

    assert map_rows == 3
    assert hot_page_count == 3  # whole small DB carried

    raw = _decrypt(engine, encrypted, db_master_key)
    magic, fmt_version, page_size, built_at_version = struct.unpack_from(HEADER_FMT, raw)[0:4]
    assert magic == MAGIC
    assert page_size == PAGE_SIZE
    assert built_at_version == 5

    map_off, map_len, hot_off, hot_len, index_off, index_len = struct.unpack_from(HEADER_FMT, raw)[4:10]
    map_entries = [
        struct.unpack_from(MAP_ENTRY_FMT, raw, map_off + i * struct.calcsize(MAP_ENTRY_FMT))
        for i in range(map_len // struct.calcsize(MAP_ENTRY_FMT))
    ]
    assert sorted(map_entries) == [(1, 5), (2, 3), (3, 5)]

    entry_size = struct.calcsize(INDEX_ENTRY_FMT)
    for i in range(index_len // entry_size):
        page_no, version_created, offset, length = struct.unpack_from(INDEX_ENTRY_FMT, raw, index_off + i * entry_size)
        assert raw[hot_off + offset : hot_off + offset + length] == live_pages[page_no][1]
        assert version_created == live_pages[page_no][0]


def test_bundle_over_budget_only_carries_page_one(engine):
    db_master_key = secrets.token_bytes(256)
    live_pages = {n: (1, secrets.token_bytes(64)) for n in range(1, 100)}

    builder = BundleBuilder(CryptoBlob(engine), db_master_key)
    _encrypted, map_rows, hot_page_count = builder.build(live_pages, PAGE_SIZE, built_at_version=1)

    assert map_rows == 99
    assert hot_page_count == 1


def test_bundle_wrong_key_fails_to_decrypt(engine):
    live_pages = {1: (1, secrets.token_bytes(PAGE_SIZE))}
    builder = BundleBuilder(CryptoBlob(engine), secrets.token_bytes(256))
    encrypted, _map_rows, _hot = builder.build(live_pages, PAGE_SIZE, built_at_version=1)

    blob = CryptoBlob(engine)
    wrong_key = engine.hkdf_sha3_512(secrets.token_bytes(256), b"", b"bundle", 64)
    try:
        blob.decrypt(encrypted, wrong_key)
        assert False, "expected decryption to fail under the wrong key"
    except ValueError:
        pass


def test_header_len_matches_struct_calcsize():
    assert HEADER_LEN == struct.calcsize(HEADER_FMT)
