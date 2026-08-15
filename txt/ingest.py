import json
import secrets
import time
from pathlib import Path

import brotli

from .account_session import Account, AccountSession
from .creds import Creds
from .crypto_blob import CryptoBlob
from .logger import Logger
from .opf import find_opf_sidecar, parse_opf_metadata
from .r2_client import R2Client
from .random_token import to_base32_crockford
from .sqlite_engine import SqliteEngine

# docs/data_model.md §3: fixed at creation, a no-op on an already-populated database.
PAGE_SIZE = 16384  # 16 KiB
SET_PAGE_SIZE_SQL = f"PRAGMA page_size = {PAGE_SIZE}"

# docs/data_model.md §3.
CREATE_TXT_SQL = """
CREATE TABLE IF NOT EXISTS txt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_key BLOB NOT NULL,
  txt_prefix BLOB NOT NULL,
  path BLOB NOT NULL,
  metadata BLOB NOT NULL,
  last_accessed INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)
"""

CREATE_TXT_BOOKMARKS_SQL = """
CREATE TABLE IF NOT EXISTS txt_bookmarks (
  id INTEGER PRIMARY KEY,
  txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  preview TEXT NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 180),
  created_at INTEGER NOT NULL,
  UNIQUE (txt_id, line)
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
        if self.local_path.exists():
            self.logger.verbose(f"Resuming from local db {self.local_path}...")
            return self.local_path.read_bytes()
        self.logger.verbose(
            f"No local db yet, checking R2 for {self.account.db_path}..."
        )
        remote = self.r2.get_object(self.account.db_path)
        self.logger.verbose(
            "Found existing remote db, resuming from it."
            if remote
            else "No remote db either, starting fresh."
        )
        return remote

    def _ensure_schema(self) -> None:
        for stmt in (
            SET_PAGE_SIZE_SQL,
            CREATE_TXT_SQL,
            CREATE_TXT_BOOKMARKS_SQL,
            CREATE_TXT_BOOKMARKS_INDEX_SQL,
            CREATE_TXT_BOOKMARKS_CAP_TRIGGER_SQL,
        ):
            self.engine.exec_sql(stmt)

    def _existing_names(self) -> set:
        return {
            json.loads(brotli.decompress(row[0]))["name"]
            for row in self.engine.query("SELECT metadata FROM txt")
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
        payload = self._metadata_payload(epub_path)
        metadata = brotli.compress(json.dumps(payload).encode())
        self.engine.execute(
            "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [txt_key, txt_prefix, path, metadata, now, now],
        )

    def _metadata_payload(self, epub_path: Path) -> dict:
        payload = {"name": epub_path.name}
        opf_path = find_opf_sidecar(epub_path)
        if opf_path is not None:
            opf_metadata = parse_opf_metadata(opf_path)
            if opf_metadata:
                payload["metadata"] = opf_metadata
        return payload

    def _finish(self) -> None:
        self.logger.verbose("Vacuuming local db...")
        self.engine.vacuum()
        data = self.engine.to_bytes()
        self.local_path.write_bytes(data)
        self.logger.verbose(f"Uploading local db to {self.account.db_path}...")
        self.r2.put_object(self.account.db_path, data)
        self.engine.close()
        self.logger.info(f"Ingest complete: db_path={self.account.db_path}")
