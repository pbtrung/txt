"""--update-db: migrates catalog and CFI reading-state schemas.

R2 is always the source of truth. Local files are inspection/checkpoint copies,
never upload bases, because a browser may have changed reading state since an
older local file was written. Database uploads are conditional on the ETag that
was downloaded, so a concurrent browser write aborts safely and a rerun starts
again from the newer remote database.
"""

import base64
import json
from pathlib import Path

import brotli

from .creds import Creds
from .crypto_blob import CryptoBlob
from .firebase_auth import FirebaseAuth
from .ingest import ensure_reading_schema
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .opf import catalog_fields
from .r2_client import R2Client, R2Object
from .sqlite_engine import SqliteEngine
from .turso_api import TursoClient, extract_account_name


class DbUpdater:
    def __init__(self, creds: Creds, local_db_dir: Path, logger: Logger):
        self.creds = creds
        self.local_db_dir = local_db_dir
        self.logger = logger
        account_name = extract_account_name(
            creds.turso_ctl_db_url, creds.turso_ctl_db_name
        )
        self.turso = TursoClient(creds.turso_org_token, account_name)
        self.r2 = R2Client(creds.r2_config)
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)

    def run(self) -> None:
        admin_uid = self._sign_in()
        ctl = self._connect_ctl()
        admin_umk = self._admin_umk(ctl, admin_uid)
        accounts = self._reachable_accounts(ctl, admin_uid, admin_umk)
        self.logger.info(f"{len(accounts)} account(s) reachable from this admin.")
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        for for_user_id, payload in accounts:
            self._migrate_account(for_user_id, payload)

    def _sign_in(self) -> str:
        self.logger.verbose(f"Signing in to Firebase as {self.creds.firebase_email}...")
        auth = FirebaseAuth(self.creds.firebase_api_key)
        uid = auth.sign_in(self.creds.firebase_email, self.creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _connect_ctl(self) -> LibsqlClient:
        token = self.turso.mint_db_token(self.creds.turso_ctl_db_name)
        return LibsqlClient(self.creds.turso_ctl_db_url, token)

    def _admin_umk(self, ctl: LibsqlClient, admin_uid: str) -> bytes:
        ikm = base64.b64decode(self.creds.user_root_key)
        wrapped_umk = ctl.query(
            "SELECT umk FROM key_store WHERE user_id = ?", [admin_uid]
        )[0][0]
        return self.blob.decrypt(wrapped_umk, ikm)

    def _reachable_accounts(
        self, ctl: LibsqlClient, admin_uid: str, admin_umk: bytes
    ) -> list:
        rows = ctl.query(
            "SELECT for_user_id, content FROM cred_store WHERE owner_id = ?",
            [admin_uid],
        )
        return [
            (for_user_id, self.blob.decrypt_json(content, admin_umk))
            for for_user_id, content in rows
        ]

    def _migrate_account(self, uid: str, payload: dict) -> None:
        db_path = payload["db_path"]
        db_master_key = base64.b64decode(payload["db_master_key"])
        local_path = self.local_db_dir / db_path
        self.logger.info(f"[{uid}] db_path={db_path} local={local_path}")
        remote = self._download(db_path)
        engine = SqliteEngine()
        engine.open(
            db_master_key,
            initial_bytes=remote.body if remote is not None else None,
        )
        engine.exec_sql("PRAGMA page_size = 16384")
        engine.exec_sql("PRAGMA foreign_keys = ON")
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
        if not self._table_exists(engine):
            self.logger.info(f"[{uid}] no database yet, skipping.")
            return
        changed = False
        engine.exec_sql("BEGIN IMMEDIATE")
        try:
            if "metadata" in self._columns(engine):
                self._add_catalog_column(engine)
                self._populate_catalog(engine, uid)
                engine.exec_sql("ALTER TABLE txt DROP COLUMN metadata")
                changed = True
            changed = ensure_reading_schema(engine, manage_transaction=False) or changed
            engine.exec_sql("COMMIT")
        except Exception:
            engine.exec_sql("ROLLBACK")
            raise

        if not changed:
            local_path.write_bytes(engine.to_bytes())
            self.logger.info(f"[{uid}] schema already migrated; no upload needed.")
            return

        self.logger.verbose(f"[{uid}] vacuuming...")
        engine.vacuum()
        data = engine.to_bytes()
        local_path.write_bytes(data)
        self.r2.put_object(
            db_path,
            data,
            if_match=remote.etag if remote is not None else None,
            if_none_match=remote is None,
        )
        self.logger.info(f"[{uid}] migration complete.")

    def _table_exists(self, engine: SqliteEngine) -> bool:
        rows = engine.query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'txt'"
        )
        return bool(rows)

    def _columns(self, engine: SqliteEngine) -> set:
        return {row[1] for row in engine.query("PRAGMA table_info(txt)")}

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
