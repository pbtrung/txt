import json
import secrets
import time
from pathlib import Path

import brotli

from .account_session import Account, AccountSession
from .creds import Creds
from .crypto_blob import CryptoBlob
from .database_schema import ensure_database_schema
from .logger import Logger
from .opf import catalog_fields, find_opf_sidecar, parse_opf_metadata
from .r2_client import R2Client
from .random_token import to_base32_crockford
from .sqlite_engine import SqliteEngine


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
        self.dirty = ensure_database_schema(self.engine) or self.dirty

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
            data = self._final_database_bytes()
            self.local_path.write_bytes(data)
            self._upload_database(data)
        finally:
            self.engine.close()
        self.logger.info(f"Ingest complete: db_path={self.account.db_path}")

    def _final_database_bytes(self) -> bytes:
        if self.dirty:
            self.logger.verbose("Vacuuming local db...")
            self.engine.vacuum()
        return self.engine.to_bytes()

    def _upload_database(self, data: bytes) -> None:
        if not self.dirty:
            self.logger.verbose("Database unchanged; no upload needed.")
            return
        self.logger.verbose(f"Uploading local db to {self.account.db_path}...")
        self.r2.put_object(
            self.account.db_path,
            data,
            if_match=self.db_etag if self.db_exists else None,
            if_none_match=not self.db_exists,
        )
