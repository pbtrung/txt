"""Builds a bundle object (docs/data_model.md §6.3): header + page map + hot
pages + index, encrypted under a fresh, dedicated bundle_enc_key.
"""

import hashlib
import struct

from .crypto_blob import CryptoBlob

FORMAT_VERSION = 1
MAGIC = b"TXBN"
HEADER_FMT = "<4sHI" + "Q" * 7 + "16s16s16s"
HEADER_LEN = struct.calcsize(HEADER_FMT)
MAP_ENTRY_FMT = "<IQ"
INDEX_ENTRY_FMT = "<IQQI"


def _checksum(data: bytes) -> bytes:
    return hashlib.blake2b(data, digest_size=16).digest()


class BundleBuilder:
    def __init__(self, blob: CryptoBlob, bundle_enc_key: bytes):
        self.blob = blob
        self.bundle_enc_key = bundle_enc_key

    def build(
        self, live_pages: dict, hot_page_nos, page_size: int, built_at_version: int
    ) -> tuple[bytes, int, int]:
        """live_pages: page_no -> (version_created, data). hot_page_nos: an
        iterable of page numbers to carry whole (docs/data_model.md's dbstat
        scan -- see TxtIngester._scan_hot_page_nos), intersected here with
        live_pages so a stale or out-of-range entry can't blow up the build.
        Returns (encrypted_bytes, map_rows, hot_page_count)."""
        hot_page_nos = sorted(set(hot_page_nos) & live_pages.keys())
        page_map = self._build_page_map(live_pages)
        hot_pages, index = self._build_hot_and_index(live_pages, hot_page_nos)
        header = self._build_header(
            page_size, built_at_version, page_map, hot_pages, index
        )
        encrypted = self.blob.encrypt(
            header + page_map + hot_pages + index, self.bundle_enc_key
        )
        return encrypted, len(live_pages), len(hot_page_nos)

    def _build_page_map(self, live_pages: dict) -> bytes:
        return b"".join(
            struct.pack(MAP_ENTRY_FMT, page_no, version_created)
            for page_no, (version_created, _data) in sorted(live_pages.items())
        )

    def _build_hot_and_index(
        self, live_pages: dict, hot_page_nos: list
    ) -> tuple[bytes, bytes]:
        hot_pages, index, offset = bytearray(), bytearray(), 0
        for page_no in hot_page_nos:
            version_created, data = live_pages[page_no]
            hot_pages += data
            index += struct.pack(
                INDEX_ENTRY_FMT, page_no, version_created, offset, len(data)
            )
            offset += len(data)
        return bytes(hot_pages), bytes(index)

    def _build_header(
        self,
        page_size: int,
        built_at_version: int,
        page_map: bytes,
        hot_pages: bytes,
        index: bytes,
    ) -> bytes:
        map_off = HEADER_LEN
        hot_off = map_off + len(page_map)
        index_off = hot_off + len(hot_pages)
        return struct.pack(
            HEADER_FMT,
            MAGIC,
            FORMAT_VERSION,
            page_size,
            built_at_version,
            map_off,
            len(page_map),
            hot_off,
            len(hot_pages),
            index_off,
            len(index),
            _checksum(page_map),
            _checksum(hot_pages),
            _checksum(index),
        )
