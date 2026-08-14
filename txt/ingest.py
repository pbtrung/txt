"""--ingest: turn a directory of .epub files into real txt/txt_meta/
txt_parts rows in BB, with part payloads uploaded to R2, resumable at
the file-name level and gated so a partial upload never reaches BB.
"""

import base64
import json
import secrets
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import brotli

from .account_session import AccountSession
from .bb_engine import PAGE_SIZE, BBEngine
from .bundle import BundleBuilder
from .creds import Creds
from .crypto_blob import CryptoBlob
from .libsql_client import LibsqlClient
from .library_index import LibraryIndexBuilder
from .logger import Logger
from .opf import find_opf_sidecar, parse_opf_metadata
from .r2_client import R2Client
from .random_token import generate_random_prefix

BUNDLE_STALE_FRACTION = 0.25

MIN_PART_SIZE = 49999
MAX_PART_SIZE = 99999
MAX_UPLOAD_WORKERS = 20
MAX_PAGES_PER_BATCH = 20

CREATE_TXT_SQL = """CREATE TABLE IF NOT EXISTS txt (
    id INTEGER PRIMARY KEY AUTOINCREMENT, txt_key BLOB NOT NULL,
    prefix BLOB NOT NULL, name TEXT NOT NULL, n_parts INTEGER NOT NULL,
    created_at INTEGER NOT NULL)"""

CREATE_TXT_META_SQL = """CREATE TABLE IF NOT EXISTS txt_meta (
    txt_id INTEGER PRIMARY KEY REFERENCES txt(id) ON DELETE CASCADE,
    metadata BLOB NOT NULL)"""

CREATE_TXT_PARTS_SQL = """CREATE TABLE IF NOT EXISTS txt_parts (
    txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL, path BLOB NOT NULL,
    PRIMARY KEY (txt_id, part_num)) WITHOUT ROWID"""


def split_parts(size: int) -> list:
    """[(offset, length), ...], each 49999-99999 bytes (docs/data_model.md §7)."""
    if size == 0:
        return [(0, 0)]
    n = -(-size // MAX_PART_SIZE)
    part_size = -(-size // n)
    parts, offset = [], 0
    while offset < size:
        length = min(part_size, size - offset)
        parts.append((offset, length))
        offset += length
    return parts


class TxtIngester:
    def __init__(self, input_dir: Path, creds: Creds, logger: Logger):
        self.input_dir = input_dir
        self.creds = creds
        self.logger = logger
        self.session = AccountSession(creds, logger)
        self.bb = BBEngine()
        self.blob = CryptoBlob(self.bb)
        self.r2 = None
        self.db_prefix = None
        self.head_version = 0
        self.umk = None
        self.db_master_key = None

    def run(self) -> None:
        self._validate_creds()
        self.r2 = R2Client(self.creds.r2_config)
        uid, account_type, aa = self.session.connect()
        ikm = self._decode_user_root_key()
        self.umk = self._require_umk(aa, ikm)
        self.db_master_key = self._require_db_master_key(aa, uid, account_type, self.umk)
        self.db_prefix = self._require_db_prefix(aa, self.umk)
        self._open_bb(aa, self.db_master_key)
        self._ingest_all(aa)
        self._rebuild_derived_artifacts(aa)
        self.logger.info(f"Ingest complete: {self.input_dir}")

    def _validate_creds(self) -> None:
        if self.creds.r2_config is None:
            raise ValueError("creds.json is missing r2_config")
        if not self.creds.user_root_key:
            raise ValueError("creds.json has no user_root_key; run --init-db first")

    def _decode_user_root_key(self) -> bytes:
        return base64.b64decode(self.creds.user_root_key)

    def _require_umk(self, aa: LibsqlClient, ikm: bytes) -> bytes:
        umk = self.session.read_umk(aa, self.blob, ikm)
        if umk is None:
            raise ValueError("account has no key_store; run --init-db first")
        return umk

    def _require_db_master_key(self, aa: LibsqlClient, uid: str, account_type: str, umk: bytes) -> bytes:
        key = self.session.read_db_master_key(aa, uid, account_type, self.blob, umk)
        if key is None:
            raise ValueError("account has no cred_store; run --init-db first")
        return key

    def _require_db_prefix(self, aa: LibsqlClient, umk: bytes) -> str:
        rows = aa.query("SELECT db_prefix FROM meta WHERE id = 1")
        if not rows:
            raise ValueError("account has no meta row; run --init-db first")
        return self.blob.decrypt(rows[0][0], umk).decode()

    def _open_bb(self, aa: LibsqlClient, db_master_key: bytes) -> None:
        self.head_version = self._read_head_version(aa)
        self.bb.load_pages(self._load_existing_pages(aa, self.head_version))
        self.bb.open(db_master_key)
        self.bb.exec_sql(CREATE_TXT_SQL)
        self.bb.exec_sql(CREATE_TXT_META_SQL)
        self.bb.exec_sql(CREATE_TXT_PARTS_SQL)

    def _read_head_version(self, aa: LibsqlClient) -> int:
        rows = aa.query("SELECT head_version FROM meta WHERE id = 1")
        return rows[0][0] if rows else 0

    def _load_existing_pages(self, aa: LibsqlClient, head_version: int) -> dict:
        rows = aa.query(
            "SELECT page_no, data FROM page_versions WHERE version_created <= ? "
            "AND (version_deleted IS NULL OR version_deleted > ?)",
            [head_version, head_version],
        )
        return {page_no: data for page_no, data in rows}

    def _ingest_all(self, aa: LibsqlClient) -> None:
        existing = {row[0] for row in self.bb.query("SELECT name FROM txt")}
        epub_paths = sorted(p for p in self.input_dir.glob("*.epub") if p.name not in existing)
        self.logger.verbose(f"{len(epub_paths)} file(s) to ingest, {len(existing)} already done")
        for epub_path in epub_paths:
            self._ingest_file(aa, epub_path)

    def _ingest_file(self, aa: LibsqlClient, epub_path: Path) -> None:
        self.logger.verbose(f"Ingesting {epub_path.name}...")
        data = epub_path.read_bytes()
        txt_key = secrets.token_bytes(128)
        prefix = generate_random_prefix()
        parts = split_parts(len(data))
        part_paths = self._upload_parts(data, parts, txt_key, prefix)
        if part_paths is None:
            self.logger.info(f"{epub_path.name}: a part upload failed, skipping (retried next run)")
            return
        self._write_bb_rows(epub_path, txt_key, prefix, part_paths)
        self._flush_pages(aa, self.bb.drain_dirty_pages())
        self.logger.info(f"{epub_path.name}: ingested ({len(parts)} part(s))")

    def _upload_parts(self, data: bytes, parts: list, txt_key: bytes, prefix: str) -> list | None:
        # Encryption runs sequentially, before any thread starts: the wasmtime
        # Store behind self.blob isn't safe to call concurrently from
        # multiple threads. Only the network upload itself is parallelized.
        part_paths = [generate_random_prefix() for _ in parts]
        ciphertexts = [self.blob.encrypt(data[o : o + n], txt_key) for o, n in parts]
        failed = False
        jobs = list(zip(part_paths, ciphertexts))
        with ThreadPoolExecutor(max_workers=min(MAX_UPLOAD_WORKERS, len(jobs))) as pool:
            futures = [pool.submit(self._upload_one_part, prefix, path, ct) for path, ct in jobs]
            for future in as_completed(futures):
                if future.exception() is not None:
                    self.logger.verbose(f"part upload failed: {future.exception()}")
                    failed = True
        return None if failed else part_paths

    def _upload_one_part(self, prefix: str, path: str, ciphertext: bytes) -> None:
        self.r2.put_object(f"{self.db_prefix}/t/{prefix}/{path}", ciphertext)

    def _write_bb_rows(self, epub_path: Path, txt_key: bytes, prefix: str, part_paths: list) -> None:
        now = int(time.time() * 1000)
        self.bb.execute(
            "INSERT INTO txt (txt_key, prefix, name, n_parts, created_at) VALUES (?, ?, ?, ?, ?)",
            [txt_key, prefix.encode(), epub_path.name, len(part_paths), now],
        )
        txt_id = self.bb.last_insert_rowid()
        self._write_txt_meta(txt_id, epub_path)
        for part_num, path in enumerate(part_paths, start=1):
            self.bb.execute(
                "INSERT INTO txt_parts (txt_id, part_num, path) VALUES (?, ?, ?)",
                [txt_id, part_num, path.encode()],
            )

    def _write_txt_meta(self, txt_id: int, epub_path: Path) -> None:
        opf_path = find_opf_sidecar(epub_path)
        if opf_path is None:
            return
        metadata = parse_opf_metadata(opf_path)
        compressed = brotli.compress(json.dumps(metadata).encode())
        self.bb.execute("INSERT INTO txt_meta (txt_id, metadata) VALUES (?, ?)", [txt_id, compressed])

    def _flush_pages(self, aa: LibsqlClient, dirty_pages: dict) -> None:
        if not dirty_pages:
            return
        self.head_version += 1
        version = self.head_version
        items = list(dirty_pages.items())
        chunks = [items[i : i + MAX_PAGES_PER_BATCH] for i in range(0, len(items), MAX_PAGES_PER_BATCH)]
        for i, chunk in enumerate(chunks):
            self._flush_chunk(aa, chunk, version, first=(i == 0), last=(i == len(chunks) - 1))

    def _flush_chunk(self, aa: LibsqlClient, chunk: list, version: int, first: bool, last: bool) -> None:
        statements = [self._version_stmt(version)] if first else []
        for page_no, data in chunk:
            statements.append(self._supersede_stmt(page_no, version))
            statements.append(self._insert_page_stmt(page_no, version, data))
        if last:
            statements.append(("UPDATE meta SET head_version = ? WHERE id = 1", [version]))
        aa.batch(statements)

    def _version_stmt(self, version: int) -> tuple:
        sql = "INSERT INTO versions (version, parent_version, committed_at, page_count) VALUES (?, ?, ?, ?)"
        return sql, [version, version - 1, int(time.time() * 1000), self.bb.page_count()]

    def _supersede_stmt(self, page_no: int, version: int) -> tuple:
        sql = "UPDATE page_versions SET version_deleted = ? WHERE page_no = ? AND version_deleted IS NULL AND version_created < ?"
        return sql, [version, page_no, version]

    def _insert_page_stmt(self, page_no: int, version: int, data: bytes) -> tuple:
        sql = "INSERT INTO page_versions (page_no, version_created, data) VALUES (?, ?, ?)"
        return sql, [page_no, version, data]

    def _rebuild_derived_artifacts(self, aa: LibsqlClient) -> None:
        self._try_rebuild(aa, self._rebuild_bundle, "bundle")
        self._try_rebuild(aa, self._rebuild_library_index, "library index")

    def _try_rebuild(self, aa: LibsqlClient, rebuild: callable, label: str) -> None:
        # Both are derived, best-effort artifacts (docs/data_model.md §6.3, §8.2):
        # their AA row is only written after a successful R2 PUT, so a failure
        # here leaves no partial state and is safe to retry on the next run.
        try:
            rebuild(aa)
        except Exception as exc:
            self.logger.info(f"{label} rebuild failed, will retry next run: {exc}")

    def _rebuild_bundle(self, aa: LibsqlClient) -> None:
        live_page_count = self.bb.page_count()
        current = aa.query("SELECT bundle_key, built_at_version FROM bundles WHERE retired_at IS NULL")
        if current and not self._bundle_stale(aa, current[0][1], live_page_count):
            return
        self._build_and_write_bundle(aa, current)

    def _bundle_stale(self, aa: LibsqlClient, built_at_version: int, live_page_count: int) -> bool:
        rows = aa.query(
            "SELECT COUNT(DISTINCT page_no) FROM page_versions WHERE version_created > ? OR version_deleted > ?",
            [built_at_version, built_at_version],
        )
        changed = rows[0][0] if rows else 0
        return live_page_count > 0 and changed > BUNDLE_STALE_FRACTION * live_page_count

    def _build_and_write_bundle(self, aa: LibsqlClient, current: list) -> None:
        live_pages = self._load_live_pages_with_version(aa)
        bundle_enc_key = secrets.token_bytes(128)
        builder = BundleBuilder(self.blob, bundle_enc_key)
        encrypted, map_rows, hot_page_count = builder.build(live_pages, PAGE_SIZE, self.head_version)
        key = generate_random_prefix()
        self.r2.put_object(f"{self.db_prefix}/b/{key}", encrypted)
        if current:
            aa.execute("UPDATE bundles SET retired_at = ? WHERE bundle_key = ?", [int(time.time() * 1000), current[0][0]])
        self._insert_bundle_row(aa, key, bundle_enc_key, len(encrypted), map_rows, hot_page_count)

    def _insert_bundle_row(
        self, aa: LibsqlClient, key: str, bundle_enc_key: bytes, byte_size: int, map_rows: int, page_count: int
    ) -> None:
        wrapped_key = self.blob.encrypt(key.encode(), self.umk)
        wrapped_enc_key = self.blob.encrypt(bundle_enc_key, self.umk)
        aa.execute(
            "INSERT INTO bundles (bundle_key, bundle_enc_key, built_at_version, byte_size, map_rows, page_count, built_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [wrapped_key, wrapped_enc_key, self.head_version, byte_size, map_rows, page_count, int(time.time() * 1000)],
        )

    def _load_live_pages_with_version(self, aa: LibsqlClient) -> dict:
        rows = aa.query(
            "SELECT page_no, version_created, data FROM page_versions WHERE version_created <= ? "
            "AND (version_deleted IS NULL OR version_deleted > ?)",
            [self.head_version, self.head_version],
        )
        return {page_no: (version_created, data) for page_no, version_created, data in rows}

    def _rebuild_library_index(self, aa: LibsqlClient) -> None:
        rows = aa.query("SELECT object_key, lib_idx_key, built_at_version FROM library_index WHERE id = 1")
        if rows and rows[0][2] == self.head_version:
            return
        key, lib_idx_key = self._existing_or_new_index_keys(rows)
        builder = LibraryIndexBuilder(self.bb, self.blob, lib_idx_key)
        encrypted, doc_count, content_hash = builder.build(self.head_version)
        self.r2.put_object(f"{self.db_prefix}/i/{key}", encrypted)
        self._upsert_library_index_row(aa, rows, key, lib_idx_key, len(encrypted), doc_count, content_hash)

    def _existing_or_new_index_keys(self, rows: list) -> tuple:
        if rows:
            return self.blob.decrypt(rows[0][0], self.umk).decode(), self.blob.decrypt(rows[0][1], self.umk)
        return generate_random_prefix(), secrets.token_bytes(128)

    def _upsert_library_index_row(
        self, aa: LibsqlClient, rows: list, key: str, lib_idx_key: bytes, byte_size: int, doc_count: int, content_hash: bytes
    ) -> None:
        now = int(time.time() * 1000)
        if rows:
            aa.execute(
                "UPDATE library_index SET built_at_version = ?, byte_size = ?, doc_count = ?, "
                "content_hash = ?, built_at = ? WHERE id = 1",
                [self.head_version, byte_size, doc_count, content_hash, now],
            )
            return
        wrapped_key = self.blob.encrypt(key.encode(), self.umk)
        wrapped_lib_idx_key = self.blob.encrypt(lib_idx_key, self.umk)
        aa.execute(
            "INSERT INTO library_index "
            "(id, object_key, lib_idx_key, built_at_version, byte_size, doc_count, content_hash, built_at) "
            "VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
            [wrapped_key, wrapped_lib_idx_key, self.head_version, byte_size, doc_count, content_hash, now],
        )
