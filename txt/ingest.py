import json
import secrets
import time
from pathlib import Path

import brotli

from .account_data import StorageAccount, parse_storage_account
from .creds import OwnerCreds
from .crypto_blob import CryptoBlob
from .database_schema import ensure_database_schema
from .logger import Logger
from .opf import catalog_fields, find_opf_sidecar, parse_opf_metadata
from .owner_init import OwnerInitializer
from .r2_client import R2Client, R2DownloadError
from .random_token import to_base32_crockford
from .sqlite_engine import SqliteEngine

DOWNLOAD_ATTEMPTS = 3
DOWNLOAD_PROGRESS_INTERVAL = 1
DOWNLOAD_READ_TIMEOUT = 15
DOWNLOAD_RETRY_DELAYS = (1, 2)


class DownloadProgressLogger:
    def __init__(self, logger: Logger, attempt: int):
        self.logger = logger
        self.attempt = attempt
        self.started = time.monotonic()
        self.last_progress = self.started
        self.reported_body = False

    def __call__(self, downloaded: int, total: int | None) -> None:
        now = time.monotonic()
        elapsed = now - self.started
        if downloaded == 0:
            self.logger.verbose(self._response_message(total))
            return
        if not self._should_report(downloaded, total, now):
            return
        self.logger.verbose(self._progress_message(downloaded, total, elapsed))
        self.reported_body = True
        self.last_progress = now

    def _should_report(self, downloaded: int, total: int | None, now: float) -> bool:
        complete = total is not None and downloaded >= total
        return (
            not self.reported_body
            or complete
            or now - self.last_progress >= DOWNLOAD_PROGRESS_INTERVAL
        )

    def _response_message(self, total: int | None) -> str:
        size = _format_bytes(total) if total is not None else "unknown size"
        return f"Current db download attempt {self.attempt}: response received, {size}."

    def _progress_message(self, downloaded: int, total: int | None, elapsed) -> str:
        amount = _download_amount(downloaded, total)
        rate = _format_bytes(downloaded / elapsed) if elapsed > 0 else "unknown"
        return (
            f"Current db download attempt {self.attempt}: {amount} in "
            f"{elapsed:.1f}s ({rate}/s)."
        )


class TxtIngester:
    def __init__(
        self,
        src_dir: Path,
        local_db_dir: Path,
        creds: OwnerCreds,
        creds_path: str,
        logger: Logger,
    ):
        self.src_dir, self.local_db_dir = src_dir, local_db_dir
        self.logger = logger
        self.owner = OwnerInitializer(creds, creds_path, logger)
        self.r2 = R2Client(creds.r2_config, read_timeout=DOWNLOAD_READ_TIMEOUT)
        self.engine = SqliteEngine()
        self.blob = CryptoBlob(self.engine)
        self._reset_run_state()

    def _reset_run_state(self) -> None:
        self.account: StorageAccount | None = None
        self.local_path: Path | None = None
        self.db_etag: str | None = None
        self.db_exists = False
        self.dirty = False

    def run(self) -> None:
        self._prepare_run()
        self._open_local_db()
        try:
            self._ingest_open_database()
        finally:
            self.engine.close()
        self.logger.info(f"Ingest complete: db_path={self.account.db_path}")

    def _prepare_run(self) -> None:
        uid, _umk, payload = self.owner.load_current_owner()
        self.account = parse_storage_account(uid, payload)
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        self.local_path = self.local_db_dir / self.account.db_path
        self.logger.info(
            f"db_path={self.account.db_path} db_prefix={self.account.db_prefix} "
            f"local={self.local_path}"
        )

    def _ingest_open_database(self) -> None:
        self._ensure_schema()
        self._ingest_all()
        self._finish()

    def _open_local_db(self) -> None:
        initial_bytes = self._load_initial_bytes()
        self.engine.open(self.account.db_master_key, initial_bytes=initial_bytes)

    def _load_initial_bytes(self) -> bytes | None:
        remote = self._download_current_db()
        self.db_exists = remote is not None
        self.db_etag = remote.etag if remote is not None else None
        self.dirty = remote is None
        self.logger.verbose(
            f"Downloaded current db: {_format_bytes(len(remote.body))}, "
            f"etag={remote.etag}."
            if remote
            else "No remote db, starting fresh."
        )
        return remote.body if remote is not None else None

    def _download_current_db(self):
        key = self.account.db_path
        for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
            self.logger.verbose(
                f"Downloading current db {key} from R2 "
                f"(attempt {attempt}/{DOWNLOAD_ATTEMPTS}, "
                f"{DOWNLOAD_READ_TIMEOUT}s read timeout)..."
            )
            try:
                return self.r2.get_object_with_etag(
                    key, on_progress=DownloadProgressLogger(self.logger, attempt)
                )
            except R2DownloadError as error:
                self._retry_download(error, attempt)

    def _retry_download(self, error: R2DownloadError, attempt: int) -> None:
        if attempt == DOWNLOAD_ATTEMPTS:
            raise RuntimeError(
                f"Downloading current db failed after {DOWNLOAD_ATTEMPTS} attempts: "
                f"{error}"
            ) from error
        delay = DOWNLOAD_RETRY_DELAYS[attempt - 1]
        self.logger.info(f"{error}; retrying in {delay}s...")
        time.sleep(delay)

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
            [txt_key, txt_prefix, path, catalog, 0, now],
        )

    def _catalog_payload(self, epub_path: Path) -> dict:
        """{name, title, authors, subjects, publisher} -- just what the
        Library screen needs to search/browse (docs/data_model.md §2.1).
        Full metadata for display comes from the EPUB's own internal OPF
        instead, parsed client-side when a book is actually opened.
        """
        opf_path = find_opf_sidecar(epub_path)
        opf_metadata = parse_opf_metadata(opf_path) if opf_path is not None else {}
        return {"name": epub_path.name, **catalog_fields(opf_metadata, epub_path.name)}

    def _finish(self) -> None:
        data = self._final_database_bytes()
        self.local_path.write_bytes(data)
        self._upload_database(data)

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


def _download_amount(downloaded: int, total: int | None) -> str:
    if total is None:
        return f"{_format_bytes(downloaded)} downloaded"
    percent = downloaded / total * 100 if total else 100
    return f"{_format_bytes(downloaded)}/{_format_bytes(total)} ({percent:.1f}%)"


def _format_bytes(value: int | float) -> str:
    if value >= 1024 * 1024:
        return f"{value / (1024 * 1024):.1f} MiB"
    if value >= 1024:
        return f"{value / 1024:.1f} KiB"
    return f"{value:.0f} B"
