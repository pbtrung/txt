"""--update-db: migrates catalog and CFI reading-state schemas.

R2 is always the source of truth. Local files are inspection/checkpoint copies,
never upload bases, because a browser may have changed reading state since an
older local file was written. Database uploads are conditional on the ETag that
was downloaded, so a concurrent browser write aborts safely and a rerun starts
again from the newer remote database.
"""

import json
from pathlib import Path

import brotli

from .account_data import StorageAccount
from .control_session import ControlFactories, ControlSession
from .creds import Creds
from .database_schema import (
    PAGE_SIZE,
    configure_database,
    ensure_reading_schema,
    table_columns,
    table_exists,
    validate_schema,
)
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .opf import catalog_fields
from .r2_client import R2Client, R2Object
from .sqlite_engine import SqliteEngine
from .turso_api import TursoClient


class DbUpdater:
    def __init__(self, creds: Creds, local_db_dir: Path, logger: Logger):
        self.creds = creds
        self.local_db_dir = local_db_dir
        self.logger = logger
        self.control = ControlSession(
            creds,
            logger,
            factories=ControlFactories(FirebaseAuth, TursoClient, LibsqlClient),
            engine=LeancryptoEngine(),
        )
        self.r2 = R2Client(creds.r2_config)

    def run(self) -> None:
        admin_uid, ctl, admin_umk = self.control.admin_context()
        accounts = self.control.reachable_accounts(
            ctl, admin_uid, admin_umk, complete=True
        )
        self.logger.info(f"{len(accounts)} account(s) reachable from this admin.")
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        for account in accounts:
            self._migrate_account(account)

    def _migrate_account(self, account: StorageAccount) -> None:
        uid, db_path = account.uid, account.db_path
        local_path = self.local_db_dir / db_path
        self.logger.info(f"[{uid}] db_path={db_path} local={local_path}")
        remote = self._download(db_path)
        if remote is None:
            self.logger.verbose(f"[{uid}] R2 database object does not exist.")
        else:
            self.logger.verbose(
                f"[{uid}] downloaded {len(remote.body)} byte(s), etag={remote.etag}."
            )
        self.logger.verbose(f"[{uid}] opening and decrypting database...")
        engine = SqliteEngine()
        engine.open(
            account.db_master_key,
            initial_bytes=remote.body if remote is not None else None,
        )
        configure_database(engine)
        try:
            self._migrate_db(engine, uid, db_path, local_path, remote)
        finally:
            engine.close()

    def _download(self, db_path: str) -> R2Object | None:
        self.logger.verbose(f"Downloading {db_path} from R2...")
        return self.r2.get_object_with_etag(db_path)

    def _migrate_db(
        self,
        engine: SqliteEngine,
        uid: str,
        db_path: str,
        local_path: Path,
        remote: R2Object | None,
    ) -> None:
        self.logger.verbose(f"[{uid}] checking for txt schema...")
        if not self._table_exists(engine):
            self.logger.info(f"[{uid}] no database yet, skipping.")
            return
        initial_columns = self._columns(engine)
        self.logger.verbose(
            f"[{uid}] current txt columns: {', '.join(sorted(initial_columns))}."
        )
        changed = False
        engine.exec_sql("BEGIN IMMEDIATE")
        try:
            if "metadata" in initial_columns:
                self.logger.verbose(f"[{uid}] migrating metadata to catalog...")
                self._add_catalog_column(engine)
                self._populate_catalog(engine, uid)
                engine.exec_sql("ALTER TABLE txt DROP COLUMN metadata")
                changed = True
            else:
                self.logger.verbose(f"[{uid}] catalog schema already present.")
            self.logger.verbose(f"[{uid}] ensuring CFI reading-state schema...")
            changed = ensure_reading_schema(engine, manage_transaction=False) or changed
            self.logger.verbose(f"[{uid}] validating complete database schema...")
            self._validate_schema(engine, uid)
            engine.exec_sql("COMMIT")
        except Exception:
            engine.exec_sql("ROLLBACK")
            raise

        if not changed:
            self.logger.verbose(f"[{uid}] writing verified local checkpoint...")
            local_path.write_bytes(engine.to_bytes())
            self.logger.info(f"[{uid}] schema already migrated; no upload needed.")
            return

        self.logger.verbose(f"[{uid}] vacuuming...")
        engine.vacuum()
        data = engine.to_bytes()
        local_path.write_bytes(data)
        self.logger.verbose(
            f"[{uid}] uploading {len(data)} byte(s) with R2 precondition..."
        )
        self.r2.put_object(
            db_path,
            data,
            if_match=remote.etag if remote is not None else None,
            if_none_match=remote is None,
        )
        self.logger.info(f"[{uid}] migration complete.")

    def _table_exists(self, engine: SqliteEngine) -> bool:
        return table_exists(engine, "txt")

    def _columns(self, engine: SqliteEngine) -> set:
        return table_columns(engine, "txt")

    def _add_catalog_column(self, engine: SqliteEngine) -> None:
        if "catalog" not in self._columns(engine):
            engine.exec_sql("ALTER TABLE txt ADD COLUMN catalog BLOB")

    def _populate_catalog(self, engine: SqliteEngine, uid: str) -> None:
        rows = engine.query("SELECT id, metadata FROM txt WHERE catalog IS NULL")
        self.logger.verbose(f"[{uid}] {len(rows)} row(s) to migrate.")
        for row_id, metadata in rows:
            old_payload = json.loads(brotli.decompress(metadata))
            name = old_payload.get("name", "")
            fields = catalog_fields(old_payload.get("metadata", {}), name)
            catalog = brotli.compress(json.dumps({"name": name, **fields}).encode())
            engine.execute("UPDATE txt SET catalog = ? WHERE id = ?", [catalog, row_id])

    def _validate_schema(self, engine: SqliteEngine, uid: str) -> None:
        try:
            stats = validate_schema(engine)
        except ValueError as error:
            raise ValueError(f"[{uid}] {error}") from error
        self.logger.info(
            f"[{uid}] schema check passed: page_size={PAGE_SIZE}, "
            f"txt_rows={stats.txt_rows}, bookmarks={stats.bookmarks}."
        )
