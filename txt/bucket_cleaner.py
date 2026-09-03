"""--clean-bucket: removes R2 objects not referenced by the D1 owner's
documents/catalog rows (docs/data_model.md). The entire
`{db_prefix}/shared/` prefix is always retained regardless of any
`shares` row's state: the browser uploads a shared copy to R2 before
registering it with `POST /v1/shares` (docs/sharing.md §4), so an
object can legitimately exist there moments before its row is written,
and this tool has no way to tell that apart from an abandoned upload.
"""

from .account_data import parse_owner_account
from .creds import OwnerCreds
from .crypto_blob import CryptoBlob
from .leancrypto_wasm import LeancryptoEngine
from .logger import Logger
from .owner_init import OwnerInitializer
from .r2_client import R2Client

DOCUMENT_KEYS_SQL = (
    "SELECT k.wrapped_key AS key_wrapped, d.content_blob "
    "FROM documents d JOIN key_store k ON k.id = d.content_key_id"
)
CATALOG_ROW_SQL = "SELECT key_id, catalog_blob FROM catalog WHERE singleton = 1"


class BucketCleaner:
    def __init__(
        self,
        creds: OwnerCreds,
        creds_path: str,
        logger: Logger,
        *,
        dry_run: bool = False,
    ):
        self.logger = logger
        self.dry_run = dry_run
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)
        self.owner = OwnerInitializer(creds, creds_path, logger, engine=self.engine)
        self.r2 = R2Client(creds.r2_config)

    def run(self) -> None:
        self.logger.info(
            f"Starting bucket cleanup ({'dry run' if self.dry_run else 'delete mode'})."
        )
        umk, payload = self.owner.load_current_owner()
        account = parse_owner_account(payload)
        allowlist = self._build_allowlist(umk, account.db_prefix)
        bucket_keys = self._bucket_keys()
        stale = self._stale_keys(account.db_prefix, allowlist, bucket_keys)
        self._report_stale(stale)
        self._delete_stale(stale)

    def _build_allowlist(self, umk: bytes, db_prefix: str) -> set[str]:
        self.logger.info("Reading D1 references...")
        keys = self._document_keys(umk, db_prefix)
        catalog_path = self._catalog_path(umk)
        if catalog_path is not None:
            keys.add(f"{db_prefix}/catalog/{catalog_path}")
        self.logger.info(f"Allowlist contains {len(keys)} exact R2 object key(s).")
        return keys

    def _document_keys(self, umk: bytes, db_prefix: str) -> set[str]:
        rows = self.owner.d1.query(DOCUMENT_KEYS_SQL)
        return {self._document_path(row, umk, db_prefix) for row in rows}

    def _document_path(self, row: dict, umk: bytes, db_prefix: str) -> str:
        row_key = self.blob.decrypt(row["key_wrapped"], umk)
        content = self.blob.decrypt_json(row["content_blob"], row_key)
        return f"{db_prefix}/documents/{content['path']}"

    def _catalog_path(self, umk: bytes) -> str | None:
        # Only the pointer's own path is needed here, not the catalog
        # object's contents -- unlike catalog_writer.CatalogWriter.load_state(),
        # this never downloads/decrypts the (potentially large) R2 object.
        row = self.owner.d1.query_one(CATALOG_ROW_SQL)
        if row is None:
            return None
        key_row = self.owner.d1.query_one(
            f"SELECT wrapped_key FROM key_store WHERE id = {row['key_id']}"
        )
        row_key = self.blob.decrypt(key_row["wrapped_key"], umk)
        pointer = self.blob.decrypt_json(row["catalog_blob"], row_key)
        return pointer["catalog_path"]

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
        self, db_prefix: str, allowlist: set[str], bucket_keys: set[str]
    ) -> list[str]:
        shared_prefix = f"{db_prefix}/shared/"
        shared = {key for key in bucket_keys if key.startswith(shared_prefix)}
        retained = (bucket_keys & allowlist) | shared
        stale = sorted(bucket_keys - retained)
        self.logger.info(
            f"{len(bucket_keys)} bucket object(s), {len(retained)} retained "
            f"({len(shared)} shared), {len(stale)} stale."
        )
        return stale

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
