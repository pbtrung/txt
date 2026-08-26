"""Remove R2 objects not referenced by the singleton owner's database."""

from .account_data import StorageAccount, parse_storage_account
from .creds import OwnerCreds
from .database_schema import configure_page_size, open_database, table_exists
from .logger import Logger
from .owner_init import OwnerInitializer
from .r2_client import R2Client
from .random_token import to_base32_crockford
from .sqlite_engine import SqliteEngine


class BucketCleaner:
    def __init__(
        self, creds: OwnerCreds, creds_path: str, logger: Logger, dry_run: bool = False
    ):
        self.logger = logger
        self.dry_run = dry_run
        self.control_backup_prefix = creds.rqlite_control_backup
        self.owner = OwnerInitializer(creds, creds_path, logger)
        self.r2 = R2Client(creds.r2_config)

    def run(self) -> None:
        self.logger.info(
            f"Starting bucket cleanup ({'dry run' if self.dry_run else 'delete mode'})."
        )
        account = self._load_account()
        allowlist = self._build_allowlist(account)
        bucket_keys = self._bucket_keys()
        stale = self._stale_keys(account, allowlist, bucket_keys)
        self._report_stale(stale)
        self._delete_stale(stale)

    def _load_account(self) -> StorageAccount:
        uid, _umk, payload = self.owner.load_current_owner()
        return parse_storage_account(uid, payload)

    def _build_allowlist(self, account: StorageAccount) -> set[str]:
        self.logger.info(f"Reading database references for uid={account.uid}...")
        keys = self._content_keys(
            account.uid, account.db_path, account.db_prefix, account.db_master_key
        )
        allowlist = {account.db_path, *keys}
        self.logger.info(f"Allowlist contains {len(allowlist)} exact R2 object key(s).")
        return allowlist

    def _bucket_keys(self) -> set[str]:
        self.logger.info("Listing all R2 bucket objects...")
        bucket_keys = set(
            self.r2.list_keys(
                "",
                lambda count: self.logger.info(f"Listed {count:,} bucket object(s)..."),
            )
        )
        self.logger.info(f"Finished listing {len(bucket_keys):,} bucket object(s).")
        return bucket_keys

    def _stale_keys(
        self, account: StorageAccount, allowlist: set[str], bucket_keys: set[str]
    ) -> list[str]:
        shared = self._shared_keys(account, bucket_keys)
        backups = self._control_backups(bucket_keys)
        retained = (bucket_keys & allowlist) | shared | backups
        stale = sorted(bucket_keys - retained)
        self.logger.info(
            f"{len(bucket_keys)} bucket object(s), {len(retained)} retained "
            f"({len(shared)} shared, {len(backups)} control backup(s)), "
            f"{len(stale)} stale."
        )
        return stale

    def _shared_keys(self, account: StorageAccount, bucket_keys: set[str]) -> set[str]:
        # Public-share deletion is authorized by rqlite and performed by the
        # trusted gateway. The generic R2 cleaner cannot prove that an object
        # is unregistered (and an R2 database rollback could hide its local
        # txt_shares row), so it must never garbage-collect this namespace.
        prefix = f"{account.db_prefix}/shared/"
        return {key for key in bucket_keys if key.startswith(prefix)}

    def _control_backups(self, bucket_keys: set[str]) -> set[str]:
        return {
            key for key in bucket_keys if key.startswith(self.control_backup_prefix)
        }

    def _report_stale(self, stale: list[str]) -> None:
        for key in stale:
            action = "Would delete" if self.dry_run else "Deleting"
            self.logger.verbose(f"{action} {key}")

    def _delete_stale(self, stale: list[str]) -> None:
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

    def _content_keys(
        self, uid: str, db_path: str, db_prefix: str, db_master_key: bytes
    ) -> set[str]:
        data = self._database_bytes(uid, db_path)
        if data is None:
            return set()
        with open_database(
            db_master_key,
            data,
            engine_factory=SqliteEngine,
            configure=configure_page_size,
        ) as engine:
            rows = self._content_rows(engine)
        return self._content_object_keys(uid, db_prefix, rows)

    def _database_bytes(self, uid: str, db_path: str) -> bytes | None:
        self.logger.verbose(f"[{uid}] downloading db_path={db_path} from R2...")
        data = self.r2.get_object(db_path)
        if data is None:
            self._warn_no_database(uid, db_path)
            return None
        if not data:
            raise ValueError(f"Account uid={uid} has an empty database at {db_path}")
        return data

    def _warn_no_database(self, uid: str, db_path: str) -> None:
        self.logger.verbose(
            f"[{uid}] db_path={db_path} does not exist; "
            "no content objects are referenced yet"
        )
        self.logger.info(
            f"[{uid}] no database found at {db_path}; every bucket object "
            "outside the shared/control-backup prefixes will be treated as "
            "stale. If --ingest has already uploaded content, run "
            "--update-db first so those references are known."
        )

    def _content_rows(self, engine: SqliteEngine) -> list:
        if not table_exists(engine, "txt"):
            return []
        return engine.query("SELECT txt_prefix, path FROM txt")

    def _content_object_keys(self, uid: str, db_prefix: str, rows: list) -> set[str]:
        keys = set()
        for txt_prefix, path in rows:
            txt_prefix = self._key_bytes(uid, "txt_prefix", txt_prefix)
            path = self._key_bytes(uid, "path", path)
            keys.add(
                f"{db_prefix}/{to_base32_crockford(txt_prefix)}"
                f"/{to_base32_crockford(path)}"
            )
        return keys

    def _key_bytes(self, uid: str, field: str, value) -> bytes:
        if not isinstance(value, (bytes, bytearray, memoryview)) or len(value) != 32:
            raise ValueError(f"Account uid={uid} has an invalid txt.{field} value")
        return bytes(value)
