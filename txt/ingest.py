import json
import secrets
import time
from pathlib import Path

import brotli

from .account_session import Account, AccountSession
from .creds import Creds
from .crypto_blob import CryptoBlob
from .logger import Logger
from .opf import catalog_fields, find_opf_sidecar, parse_opf_metadata
from .r2_client import R2Client
from .random_token import to_base32_crockford
from .sqlite_engine import SqliteEngine

# docs/data_model.md §3: fixed at creation, a no-op on an already-populated database.
PAGE_SIZE = 16384  # 16 KiB
SET_PAGE_SIZE_SQL = f"PRAGMA page_size = {PAGE_SIZE}"
ENABLE_FOREIGN_KEYS_SQL = "PRAGMA foreign_keys = ON"

# docs/data_model.md §3.
CREATE_TXT_SQL = """
CREATE TABLE IF NOT EXISTS txt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_key BLOB NOT NULL,
  txt_prefix BLOB NOT NULL,
  path BLOB NOT NULL,
  catalog BLOB NOT NULL,
  last_accessed INTEGER NOT NULL,
  last_cfi TEXT,
  created_at INTEGER NOT NULL
)
"""

CREATE_TXT_BOOKMARKS_SQL = """
CREATE TABLE IF NOT EXISTS txt_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
  cfi TEXT NOT NULL,
  preview TEXT NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 100),
  created_at INTEGER NOT NULL,
  UNIQUE (txt_id, cfi)
)
"""

CREATE_TXT_BOOKMARKS_INDEX_SQL = (
    "CREATE INDEX IF NOT EXISTS idx_txt_bookmarks_txt_id ON txt_bookmarks(txt_id, id)"
)

CREATE_TXT_BOOKMARKS_CAP_TRIGGER_SQL = """
CREATE TRIGGER IF NOT EXISTS trg_txt_bookmarks_cap
AFTER INSERT ON txt_bookmarks
BEGIN
  DELETE FROM txt_bookmarks
  WHERE txt_id = NEW.txt_id
    AND id NOT IN (
      SELECT id FROM txt_bookmarks
      WHERE txt_id = NEW.txt_id
      ORDER BY id DESC
      LIMIT 20
    );
END
"""


def ensure_reading_schema(
    engine: SqliteEngine, *, manage_transaction: bool = True
) -> bool:
    """Add last_cfi and the CFI bookmark schema by inspecting actual objects.

    Legacy line bookmarks cannot be translated to EPUB CFIs. An empty legacy
    table is rebuilt; a nonempty one aborts without changing the database.
    """
    changed = False
    if manage_transaction:
        engine.exec_sql("BEGIN IMMEDIATE")
    try:
        txt_columns = {row[1] for row in engine.query("PRAGMA table_info(txt)")}
        if "last_cfi" not in txt_columns:
            engine.exec_sql("ALTER TABLE txt ADD COLUMN last_cfi TEXT")
            changed = True

        bookmark_rows = engine.query(
            "SELECT 1 FROM sqlite_master "
            "WHERE type = 'table' AND name = 'txt_bookmarks'"
        )
        if bookmark_rows:
            bookmark_columns = {
                row[1] for row in engine.query("PRAGMA table_info(txt_bookmarks)")
            }
            if "line" in bookmark_columns:
                [(count,)] = engine.query("SELECT count(*) FROM txt_bookmarks")
                if count:
                    raise ValueError(
                        "legacy txt_bookmarks contains line bookmarks; "
                        "cannot migrate them safely to EPUB CFIs"
                    )
                engine.exec_sql("DROP TRIGGER IF EXISTS trg_txt_bookmarks_cap")
                engine.exec_sql("DROP INDEX IF EXISTS idx_txt_bookmarks_txt_id")
                engine.exec_sql("DROP TABLE txt_bookmarks")
                changed = True
            elif "cfi" not in bookmark_columns:
                raise ValueError("txt_bookmarks has an unsupported schema")
        else:
            changed = True

        index_exists = engine.query(
            "SELECT 1 FROM sqlite_master "
            "WHERE type = 'index' AND name = 'idx_txt_bookmarks_txt_id'"
        )
        trigger_exists = engine.query(
            "SELECT 1 FROM sqlite_master "
            "WHERE type = 'trigger' AND name = 'trg_txt_bookmarks_cap'"
        )
        engine.exec_sql(CREATE_TXT_BOOKMARKS_SQL)
        engine.exec_sql(CREATE_TXT_BOOKMARKS_INDEX_SQL)
        engine.exec_sql(CREATE_TXT_BOOKMARKS_CAP_TRIGGER_SQL)
        changed = changed or not index_exists or not trigger_exists
        if manage_transaction:
            engine.exec_sql("COMMIT")
        return changed
    except Exception:
        if manage_transaction:
            engine.exec_sql("ROLLBACK")
        raise


class TxtIngester:
    def __init__(self, src_dir: Path, local_db_dir: Path, creds: Creds, logger: Logger):
        self.src_dir = src_dir
        self.local_db_dir = local_db_dir
        self.creds = creds
        self.logger = logger
        self.session = AccountSession(creds, logger)
        self.r2 = R2Client(creds.r2_config)
        self.engine = SqliteEngine()
        self.blob = CryptoBlob(self.engine)
        self.account: Account | None = None
        self.local_path: Path | None = None
        self.db_etag: str | None = None
        self.db_exists = False
        self.dirty = False

    def run(self) -> None:
        self.account = self.session.connect()
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        self.local_path = self.local_db_dir / self.account.db_path
        self.logger.info(
            f"db_path={self.account.db_path} db_prefix={self.account.db_prefix} "
            f"local={self.local_path}"
        )
        self._open_local_db()
        self._ensure_schema()
        self._ingest_all()
        self._finish()

    def _open_local_db(self) -> None:
        initial_bytes = self._load_initial_bytes()
        self.engine.open(self.account.db_master_key, initial_bytes=initial_bytes)

    def _load_initial_bytes(self) -> bytes | None:
        self.logger.verbose(f"Downloading current db {self.account.db_path} from R2...")
        remote = self.r2.get_object_with_etag(self.account.db_path)
        self.db_exists = remote is not None
        self.db_etag = remote.etag if remote is not None else None
        self.dirty = remote is None
        self.logger.verbose(
            "Found existing remote db, resuming from it."
            if remote
            else "No remote db either, starting fresh."
        )
        return remote.body if remote is not None else None

    def _ensure_schema(self) -> None:
        for stmt in (SET_PAGE_SIZE_SQL, ENABLE_FOREIGN_KEYS_SQL, CREATE_TXT_SQL):
            self.engine.exec_sql(stmt)
        self.dirty = ensure_reading_schema(self.engine) or self.dirty

    def _existing_names(self) -> set:
        return {
            json.loads(brotli.decompress(row[0]))["name"]
            for row in self.engine.query("SELECT catalog FROM txt")
        }

    def _ingest_all(self) -> None:
        existing = self._existing_names()
        all_paths = sorted(self.src_dir.glob("*.epub"))
        to_process = [p for p in all_paths if p.name not in existing]
        total = len(all_paths)
        self.logger.info(
            f"{len(to_process)} file(s) to ingest, {total - len(to_process)} "
            f"already done, {total} total"
        )
        processed = total - len(to_process)
        for epub_path in to_process:
            processed += 1
            self._ingest_file(epub_path, processed, total)

    def _ingest_file(self, epub_path: Path, processed: int, total: int) -> None:
        data = epub_path.read_bytes()
        txt_key = secrets.token_bytes(128)
        txt_prefix, path = secrets.token_bytes(32), secrets.token_bytes(32)
        key = self._object_key(txt_prefix, path)
        self.r2.put_object(key, self.blob.encrypt(data, txt_key))
        self._insert_txt_row(epub_path, txt_key, txt_prefix, path)
        self.dirty = True
        self.local_path.write_bytes(self.engine.to_bytes())
        self.logger.info(
            f"[{processed}/{total}] {epub_path.name} ({len(data)} byte(s)) -> {key} "
            f"db_path={self.account.db_path} db_prefix={self.account.db_prefix}"
        )

    def _object_key(self, txt_prefix: bytes, path: bytes) -> str:
        return (
            f"{self.account.db_prefix}/{to_base32_crockford(txt_prefix)}"
            f"/{to_base32_crockford(path)}"
        )

    def _insert_txt_row(
        self, epub_path: Path, txt_key: bytes, txt_prefix: bytes, path: bytes
    ) -> None:
        now = int(time.time() * 1000)
        payload = self._catalog_payload(epub_path)
        catalog = brotli.compress(json.dumps(payload).encode())
        self.engine.execute(
            "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [txt_key, txt_prefix, path, catalog, now, now],
        )

    def _catalog_payload(self, epub_path: Path) -> dict:
        """{name, title, authors, subjects, publisher} -- just what the
        Library screen needs to search/browse (docs/data_model.md §3.1).
        Full metadata for display comes from the EPUB's own internal OPF
        instead, parsed client-side when a book is actually opened.
        """
        opf_path = find_opf_sidecar(epub_path)
        opf_metadata = parse_opf_metadata(opf_path) if opf_path is not None else {}
        return {"name": epub_path.name, **catalog_fields(opf_metadata, epub_path.name)}

    def _finish(self) -> None:
        try:
            if self.dirty:
                self.logger.verbose("Vacuuming local db...")
                self.engine.vacuum()
            data = self.engine.to_bytes()
            self.local_path.write_bytes(data)
            if self.dirty:
                self.logger.verbose(f"Uploading local db to {self.account.db_path}...")
                self.r2.put_object(
                    self.account.db_path,
                    data,
                    if_match=self.db_etag if self.db_exists else None,
                    if_none_match=not self.db_exists,
                )
            else:
                self.logger.verbose("Database unchanged; no upload needed.")
        finally:
            self.engine.close()
        self.logger.info(f"Ingest complete: db_path={self.account.db_path}")
