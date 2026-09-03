"""--update-db: clears every document's access_key_id/access_blob back
to NULL (docs/data_model.md §2) -- a one-time data migration for
documents ingested before access state became lazily created
(worker/migrations/0002_nullable_access.sql, catalog_writer.py). A
single D1 `UPDATE` does this for every row at once;
`trg_documents_clear_access_key` deletes each now-orphaned `key_store`
row automatically, so there is no per-row Python work or R2 access at
all -- unlike `--clean-bucket`/`--clean-db`, this command never touches
R2 or decrypts anything.
"""

from .creds import OwnerCreds
from .leancrypto_wasm import LeancryptoEngine
from .logger import Logger
from .owner_init import OwnerInitializer

COUNT_ACCESSED_SQL = (
    "SELECT count(*) AS n FROM documents WHERE access_key_id IS NOT NULL"
)
CLEAR_ACCESS_SQL = (
    "UPDATE documents SET access_blob = NULL, access_key_id = NULL "
    "WHERE access_key_id IS NOT NULL"
)


class DbUpdater:
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
        self.owner = OwnerInitializer(
            creds, creds_path, logger, engine=LeancryptoEngine()
        )

    def run(self) -> None:
        mode = "dry run" if self.dry_run else "update mode"
        self.logger.info(f"Starting access-state reset ({mode}).")
        self.owner.load_current_owner()  # validates this is a real, initialized owner
        count = self._count_accessed()
        if self.dry_run:
            self.logger.info(
                f"Dry run: would clear access state on {count:,} document(s)."
            )
            return
        self._clear_access(count)

    def _count_accessed(self) -> int:
        row = self.owner.d1.query_one(COUNT_ACCESSED_SQL)
        return row["n"] if row else 0

    def _clear_access(self, expected: int) -> None:
        self.logger.info(f"Clearing access state on {expected:,} document(s)...")
        result = self.owner.d1.execute(CLEAR_ACCESS_SQL)
        changed = result["meta"]["changes"]
        self.logger.info(f"Cleared access state on {changed:,} document(s).")
