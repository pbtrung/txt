"""--clean-db: retries a `shares` row stuck in `state = 'deleting'`
(docs/sharing.md §3.4). `worker/sharesEndpoint.ts` only ever inserts a
row directly as `'active'`; `'deleting'` is set right before the
Worker attempts the R2 object delete, and the row stays there for
retry if that delete fails (a `503`) -- `'creating'` is a browser-local
marker that never reaches D1 at all. A `'deleting'` row is therefore
the only persisted stale state in this design: D1 alone is
authoritative here, unlike the predecessor design's separate rqlite
control store needing reconciliation against a local SQLCipher file.
"""

from .account_data import parse_owner_account
from .creds import OwnerCreds
from .crypto_blob import CryptoBlob
from .leancrypto_wasm import LeancryptoEngine
from .logger import Logger
from .owner_init import OwnerInitializer
from .r2_client import R2Client

STALE_SHARES_SQL = (
    "SELECT s.share_id_hash, k.wrapped_key AS key_wrapped, s.owner_blob "
    "FROM shares s JOIN key_store k ON k.id = s.key_id "
    "WHERE s.state = 'deleting'"
)


class DbCleaner:
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
        mode = "dry run" if self.dry_run else "clean mode"
        self.logger.info(f"Starting database cleanup ({mode}).")
        umk, payload = self.owner.load_current_owner()
        account = parse_owner_account(payload)
        stale = self.owner.d1.query(STALE_SHARES_SQL)
        for row in stale:
            self._clean_one(umk, account.db_prefix, row)
        verb = "would be" if self.dry_run else "were"
        self.logger.info(f"{len(stale)} stale share row(s) {verb} cleaned up.")

    def _clean_one(self, umk: bytes, db_prefix: str, row: dict) -> None:
        share_path = self._share_path(umk, row)
        object_key = f"{db_prefix}/shared/{share_path}"
        verb = "Would remove" if self.dry_run else "Removing"
        self.logger.verbose(f"{verb} stuck-deleting share at {object_key}...")
        if self.dry_run:
            return
        self.r2.delete_keys([object_key])
        self._delete_row(row["share_id_hash"])

    def _share_path(self, umk: bytes, row: dict) -> str:
        row_key = self.blob.decrypt(row["key_wrapped"], umk)
        payload = self.blob.decrypt_json(row["owner_blob"], row_key)
        return payload["share_path"]

    def _delete_row(self, share_id_hash: bytes) -> None:
        self.owner.d1.execute(
            "DELETE FROM shares WHERE share_id_hash = unhex(?)", [share_id_hash]
        )
