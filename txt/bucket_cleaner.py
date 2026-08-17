"""Remove R2 objects not referenced by any account reachable by an admin."""

from .account_data import StorageAccount
from .control_session import (
    ControlFactories,
    ControlSession,
    load_reachable_accounts,
    unwrap_umk,
)
from .creds import Creds
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .r2_client import R2Client
from .random_token import to_base32_crockford
from .sqlite_engine import SqliteEngine
from .turso_api import TursoClient


class BucketCleaner:
    def __init__(self, creds: Creds, logger: Logger, dry_run: bool = False):
        if creds.r2_config is None:
            raise ValueError("--clean-bucket requires r2_config in creds.json")
        self.creds = creds
        self.logger = logger
        self.dry_run = dry_run
        self.control = ControlSession(
            creds,
            logger,
            factories=ControlFactories(FirebaseAuth, TursoClient, LibsqlClient),
            engine=LeancryptoEngine(),
        )
        self.r2 = R2Client(creds.r2_config)
        self.blob = self.control.blob

    def run(self) -> None:
        self.logger.info(
            f"Starting bucket cleanup ({'dry run' if self.dry_run else 'delete mode'})."
        )
        admin_uid = self._sign_in()
        ctl = self._connect_ctl()
        admin_umk = self._admin_umk(ctl, admin_uid)
        accounts = self._reachable_accounts(ctl, admin_uid, admin_umk)
        if not accounts:
            raise ValueError(
                "No accounts are reachable from this admin; refusing to clean bucket"
            )

        self.logger.info(
            f"Building allowlist from {len(accounts)} account database(s)..."
        )
        allowlist = self._storage_allowlist(accounts)
        self.logger.info(f"Allowlist contains {len(allowlist)} exact R2 object key(s).")
        self.logger.info("Listing all R2 bucket objects...")
        bucket_keys = set(
            self.r2.list_keys(
                "",
                lambda count: self.logger.info(f"Listed {count:,} bucket object(s)..."),
            )
        )
        self.logger.info(f"Finished listing {len(bucket_keys):,} bucket object(s).")
        retained = bucket_keys & allowlist
        stale = sorted(bucket_keys - retained)

        self.logger.info(
            f"{len(accounts)} account(s), {len(bucket_keys)} bucket object(s), "
            f"{len(retained)} retained, {len(stale)} stale."
        )
        for key in stale:
            action = "Would delete" if self.dry_run else "Deleting"
            self.logger.verbose(f"{action} {key}")

        if self.dry_run:
            self.logger.info(f"Dry run: would delete {len(stale)} object(s).")
            return
        if stale:
            self.logger.info(f"Deleting {len(stale):,} stale object(s)...")
        self.r2.delete_keys(
            stale,
            lambda count: self.logger.info(
                f"Deleted {count:,}/{len(stale):,} stale object(s)..."
            ),
        )
        self.logger.info(f"Deleted {len(stale)} object(s).")

    def _sign_in(self) -> str:
        return self.control.sign_in()

    def _connect_ctl(self) -> LibsqlClient:
        return self.control.connect()

    def _admin_umk(self, ctl: LibsqlClient, admin_uid: str) -> bytes:
        return unwrap_umk(ctl, admin_uid, self.creds.user_root_key, self.blob)

    def _reachable_accounts(
        self, ctl: LibsqlClient, admin_uid: str, admin_umk: bytes
    ) -> list[StorageAccount]:
        return load_reachable_accounts(
            ctl, admin_uid, admin_umk, self.blob, require_all=True
        )

    def _storage_allowlist(self, accounts: list[StorageAccount]) -> set[str]:
        allowlist: set[str] = set()
        for index, account in enumerate(accounts, start=1):
            uid = account.uid
            self.logger.info(
                f"[{index}/{len(accounts)}] Reading database references "
                f"for uid={uid}..."
            )
            content_keys = self._content_keys(
                uid, account.db_path, account.db_prefix, account.db_master_key
            )
            allowlist.add(account.db_path)
            allowlist.update(content_keys)
            self.logger.info(
                f"[{index}/{len(accounts)}] uid={uid}, db_path={account.db_path}, "
                f"db_prefix={account.db_prefix}/, "
                f"{len(content_keys)} referenced content object(s)"
            )
        return allowlist

    def _content_keys(
        self, uid: str, db_path: str, db_prefix: str, db_master_key: bytes
    ) -> set[str]:
        self.logger.verbose(f"[{uid}] downloading db_path={db_path} from R2...")
        data = self.r2.get_object(db_path)
        if data is None:
            self.logger.verbose(
                f"[{uid}] db_path={db_path} does not exist; "
                "no content objects are referenced yet"
            )
            return set()
        if not data:
            raise ValueError(f"Account uid={uid} has an empty database at {db_path}")

        engine = SqliteEngine()
        engine.open(db_master_key, initial_bytes=data)
        try:
            # SQLCipher encrypts page 1, so SQLite cannot infer the database's
            # non-default page size from its header. This must be reapplied
            # before the first schema read, just as ingest and --update-db do.
            engine.exec_sql("PRAGMA page_size = 16384")
            table_exists = engine.query(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'txt'"
            )
            rows = (
                engine.query("SELECT txt_prefix, path FROM txt") if table_exists else []
            )
        finally:
            engine.close()

        content_keys = set()
        for txt_prefix, path in rows:
            txt_prefix = self._key_bytes(uid, "txt_prefix", txt_prefix)
            path = self._key_bytes(uid, "path", path)
            content_keys.add(
                f"{db_prefix}/{to_base32_crockford(txt_prefix)}"
                f"/{to_base32_crockford(path)}"
            )
        return content_keys

    def _key_bytes(self, uid: str, field: str, value) -> bytes:
        if not isinstance(value, (bytes, bytearray, memoryview)) or len(value) != 32:
            raise ValueError(f"Account uid={uid} has an invalid txt.{field} value")
        return bytes(value)
