"""--check-catalog: read-only diagnostic reporting any drift between the
D1 owner's `documents` rows and the R2-hosted catalog object
(docs/data_model.md §2.1). A `documents` row not yet reflected in the
catalog is invisible in the Library screen until the next `--ingest` run
reconciles it -- expected only if a past ingest run was interrupted
between its D1 write and its catalog publish. A catalog entry
referencing a `document_id` that doesn't exist in `documents` shouldn't
happen at all through normal use (nothing in this design ever deletes a
document), and would be worse: the Library screen would show it and
then fail to open. Never writes to D1 or R2.
"""

from .account_data import parse_owner_account
from .catalog_writer import CatalogWriter, DocumentStore
from .creds import OwnerCreds
from .crypto_blob import CryptoBlob
from .leancrypto_wasm import LeancryptoEngine
from .logger import Logger
from .owner_init import OwnerInitializer
from .r2_client import R2Client

# Same reasoning as bucket_cleaner.py's document paging: a `d.id > ?`
# keyset seek, not OFFSET, so D1 (which bills by rows examined) touches
# each row exactly once no matter how many pages a large library takes.
PAGE_SIZE = 1000


class CatalogChecker:
    def __init__(self, creds: OwnerCreds, creds_path: str, logger: Logger):
        self.logger = logger
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)
        self.owner = OwnerInitializer(creds, creds_path, logger, engine=self.engine)
        self.r2 = R2Client(creds.r2_config)

    def run(self) -> None:
        self.logger.info("Starting catalog consistency check (read-only).")
        umk, payload = self.owner.load_current_owner()
        account = parse_owner_account(payload)
        store = DocumentStore(self.owner.d1, self.r2, self.blob, umk, account.db_prefix)
        state = CatalogWriter(store).load_state()
        document_ids = self._document_ids()
        self._report_missing(document_ids - state.covered_ids)
        self._report_orphaned(state.covered_ids - document_ids)

    def _document_ids(self) -> set[int]:
        ids: set[int] = set()
        last_id = 0
        while True:
            rows = self.owner.d1.query(
                f"SELECT id FROM documents WHERE id > {last_id} "
                f"ORDER BY id LIMIT {PAGE_SIZE}"
            )
            page_ids = [row["id"] for row in rows]
            ids.update(page_ids)
            self.logger.info(f"Read {len(ids):,} document id(s)...")
            if len(rows) < PAGE_SIZE:
                return ids
            last_id = page_ids[-1]

    def _report_missing(self, missing: set[int]) -> None:
        if not missing:
            self.logger.info("Every document is represented in the catalog.")
            return
        self.logger.info(
            f"{len(missing):,} document(s) missing from the catalog "
            f"(invisible in the Library screen until reconciled): {sorted(missing)}"
        )

    def _report_orphaned(self, orphaned: set[int]) -> None:
        if not orphaned:
            self.logger.info("Every catalog entry references a real document.")
            return
        self.logger.info(
            f"{len(orphaned):,} catalog entries reference a document_id that "
            f"doesn't exist: {sorted(orphaned)}"
        )
