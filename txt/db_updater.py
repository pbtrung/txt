"""--update-db: migrates catalog and CFI reading-state schemas.

R2 is always the source of truth. Local files are inspection/checkpoint copies,
never upload bases, because a browser may have changed reading state since an
older local file was written. Database uploads are conditional on the ETag that
was downloaded, so a concurrent browser write aborts safely and a rerun starts
again from the newer remote database.
"""

import json
from dataclasses import dataclass
from pathlib import Path

import brotli

from .account_data import StorageAccount, parse_storage_account
from .creds import OwnerCreds
from .database_schema import (
    ACCESS_RESET_MIGRATION,
    PAGE_SIZE,
    ensure_migration_table,
    ensure_reading_schema,
    ensure_share_schema,
    migration_applied,
    open_database,
    record_migration,
    table_columns,
    table_exists,
    validate_schema,
)
from .logger import Logger
from .opf import catalog_fields
from .owner_init import OwnerInitializer
from .r2_client import R2Client, R2Object
from .sqlite_engine import SqliteEngine


@dataclass(frozen=True)
class MigrationTarget:
    uid: str
    db_path: str
    local_path: Path
    remote: R2Object | None


class DbUpdater:
    def __init__(
        self, creds: OwnerCreds, creds_path: str, local_db_dir: Path, logger: Logger
    ):
        self.local_db_dir = local_db_dir
        self.logger = logger
        self.owner = OwnerInitializer(creds, creds_path, logger)
        self.r2 = R2Client(creds.r2_config)

    def run(self) -> None:
        uid, _umk, payload = self.owner.load_current_owner()
        account = parse_storage_account(uid, payload)
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        self._migrate_account(account)

    def _migrate_account(self, account: StorageAccount) -> None:
        uid, db_path = account.uid, account.db_path
        local_path = self.local_db_dir / db_path
        self.logger.info(f"[{uid}] db_path={db_path} local={local_path}")
        remote = self._download(db_path)
        self._log_download(uid, remote)
        data = remote.body if remote is not None else None
        self.logger.verbose(f"[{uid}] opening and decrypting database...")
        with open_database(
            account.db_master_key, data, engine_factory=SqliteEngine
        ) as engine:
            target = MigrationTarget(uid, db_path, local_path, remote)
            self._migrate_db(engine, target)

    def _log_download(self, uid: str, remote: R2Object | None) -> None:
        if remote is None:
            self.logger.verbose(f"[{uid}] R2 database object does not exist.")
        else:
            self.logger.verbose(
                f"[{uid}] downloaded {len(remote.body)} byte(s), etag={remote.etag}."
            )

    def _download(self, db_path: str) -> R2Object | None:
        self.logger.verbose(f"Downloading {db_path} from R2...")
        return self.r2.get_object_with_etag(db_path)

    def _migrate_db(self, engine: SqliteEngine, target: MigrationTarget) -> None:
        columns = self._migration_columns(engine, target.uid)
        if columns is None:
            return
        changed = self._apply_migrations(engine, target.uid, columns)
        if changed:
            self._publish(engine, target)
        else:
            self._write_checkpoint(engine, target.uid, target.local_path)

    def _migration_columns(self, engine: SqliteEngine, uid: str) -> set | None:
        self.logger.verbose(f"[{uid}] checking for txt schema...")
        if not self._table_exists(engine):
            self.logger.info(f"[{uid}] no database yet, skipping.")
            return None
        columns = self._columns(engine)
        self.logger.verbose(
            f"[{uid}] current txt columns: {', '.join(sorted(columns))}."
        )
        return columns

    def _apply_migrations(self, engine, uid: str, columns: set) -> bool:
        engine.exec_sql("BEGIN IMMEDIATE")
        try:
            changed = self._migrate_catalog(engine, uid, columns)
            reset_access = self._needs_access_reset(engine)
            changed = self._migrate_reading_state(engine, uid, changed, reset_access)
            changed = self._migrate_shares(engine, uid, changed)
            self.logger.verbose(f"[{uid}] validating complete database schema...")
            self._validate_schema(engine, uid)
            engine.exec_sql("COMMIT")
            return changed
        except Exception:
            engine.exec_sql("ROLLBACK")
            raise

    def _migrate_reading_state(self, engine, uid, changed, reset_access) -> bool:
        self.logger.verbose(f"[{uid}] ensuring CFI reading-state schema...")
        changed = ensure_reading_schema(engine, manage_transaction=False) or changed
        if not reset_access:
            return changed
        self.logger.verbose(f"[{uid}] resetting legacy last_accessed values...")
        engine.exec_sql("UPDATE txt SET last_accessed = 0")
        record_migration(engine, ACCESS_RESET_MIGRATION)
        return True

    def _needs_access_reset(self, engine) -> bool:
        ensure_migration_table(engine)
        return not migration_applied(engine, ACCESS_RESET_MIGRATION)

    def _migrate_shares(self, engine, uid: str, changed: bool) -> bool:
        self.logger.verbose(f"[{uid}] ensuring administrator-share schema...")
        return ensure_share_schema(engine) or changed

    def _migrate_catalog(self, engine, uid: str, columns: set) -> bool:
        if "metadata" not in columns:
            self.logger.verbose(f"[{uid}] catalog schema already present.")
            return False
        self.logger.verbose(f"[{uid}] migrating metadata to catalog...")
        self._add_catalog_column(engine)
        self._populate_catalog(engine, uid)
        engine.exec_sql("ALTER TABLE txt DROP COLUMN metadata")
        return True

    def _write_checkpoint(self, engine, uid: str, local_path: Path) -> None:
        self.logger.verbose(f"[{uid}] writing verified local checkpoint...")
        local_path.write_bytes(engine.to_bytes())
        self.logger.info(f"[{uid}] schema already migrated; no upload needed.")

    def _publish(self, engine, target: MigrationTarget) -> None:
        self.logger.verbose(f"[{target.uid}] vacuuming...")
        engine.vacuum()
        data = engine.to_bytes()
        target.local_path.write_bytes(data)
        self.logger.verbose(
            f"[{target.uid}] uploading {len(data)} byte(s) with R2 precondition..."
        )
        self.r2.put_object(
            target.db_path,
            data,
            if_match=target.remote.etag if target.remote is not None else None,
            if_none_match=target.remote is None,
        )
        self.logger.info(f"[{target.uid}] migration complete.")

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
            f"txt_rows={stats.txt_rows}, bookmarks={stats.bookmarks}, "
            f"shares={stats.shares}."
        )
