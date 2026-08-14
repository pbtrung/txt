"""--collect-garbage: reclaims everything no longer needed to serve the
current live state (docs/data_model.md §6.4) -- superseded BB page
versions, retired bundles, and orphaned R2 objects under t/, b/, and i/.
Every deletion targets something already superseded/orphaned, so a run
that's interrupted midway leaves live data untouched and is safe to rerun.
"""

import base64
import time

from .account_session import AccountSession
from .bb_engine import BBEngine
from .creds import Creds
from .crypto_blob import CryptoBlob
from .ingest import CREATE_TXT_META_SQL, CREATE_TXT_PARTS_SQL, CREATE_TXT_SQL
from .libsql_client import LibsqlClient
from .logger import Logger
from .r2_client import R2Client

HEARTBEAT_INTERVAL_MS = 30_000
SNAPSHOT_EXPIRY_MS = 3 * HEARTBEAT_INTERVAL_MS

# Same reasoning as ingest.py's MAX_PAGES_PER_BATCH: Turso's Hrana endpoint
# can time out on an oversized request, so every multi-row AA read or write
# here goes through _delete_in_pages/_delete_in_batches rather than one
# unbounded SELECT, DELETE, or batch call.
GC_BATCH_SIZE = 200


class GarbageCollector:
    def __init__(self, creds: Creds, logger: Logger):
        self.creds = creds
        self.logger = logger
        self.session = AccountSession(creds, logger)
        self.bb = BBEngine()
        self.blob = CryptoBlob(self.bb)
        self.r2 = None
        self.db_prefix = None
        self.umk = None

    def run(self) -> None:
        self.logger.info("Starting garbage collection...")
        self._validate_creds()
        self.r2 = R2Client(self.creds.r2_config)
        uid, account_type, aa = self.session.connect()
        ikm = base64.b64decode(self.creds.user_root_key)
        self.umk = self._require(self.session.read_umk(aa, self.blob, ikm), "key_store")
        db_master_key = self._require(
            self.session.read_db_master_key(aa, uid, account_type, self.blob, self.umk),
            "cred_store",
        )
        self.db_prefix = self._require_db_prefix(aa)
        self._expire_stale_snapshots(aa)
        head_version = self._read_head_version(aa)
        gc_horizon = self._compute_gc_horizon(aa, head_version)
        self._collect_page_versions(aa, gc_horizon)
        self._collect_bundles(aa)
        self._collect_library_index_orphans(aa)
        self._collect_part_orphans(aa, db_master_key)
        self.logger.info("Garbage collection complete")

    def _validate_creds(self) -> None:
        if self.creds.r2_config is None:
            raise ValueError("creds.json is missing r2_config")
        if not self.creds.user_root_key:
            raise ValueError("creds.json has no user_root_key; run --init-db first")

    def _require(self, value, table: str):
        if value is None:
            raise ValueError(f"account has no {table}; run --init-db first")
        return value

    def _require_db_prefix(self, aa: LibsqlClient) -> str:
        rows = aa.query("SELECT db_prefix FROM meta WHERE id = 1")
        if not rows:
            raise ValueError("account has no meta row; run --init-db first")
        return self.blob.decrypt(rows[0][0], self.umk).decode()

    def _read_head_version(self, aa: LibsqlClient) -> int:
        rows = aa.query("SELECT head_version FROM meta WHERE id = 1")
        return rows[0][0] if rows else 0

    def _expire_stale_snapshots(self, aa: LibsqlClient) -> None:
        cutoff = int(time.time() * 1000) - SNAPSHOT_EXPIRY_MS
        count = self._delete_in_pages(
            aa,
            "SELECT snapshot_id FROM snapshots WHERE heartbeat_at < ?",
            [cutoff],
            "DELETE FROM snapshots WHERE snapshot_id = ?",
        )
        self.logger.verbose(f"expired {count} stale snapshot(s)")

    def _compute_gc_horizon(self, aa: LibsqlClient, head_version: int) -> int:
        rows = aa.query("SELECT MIN(version) FROM snapshots")
        horizon = rows[0][0] if rows and rows[0][0] is not None else head_version
        self.logger.verbose(f"gc_horizon={horizon} (head_version={head_version})")
        return horizon

    def _collect_page_versions(self, aa: LibsqlClient, gc_horizon: int) -> None:
        count = self._delete_in_pages(
            aa,
            "SELECT page_no, version_created FROM page_versions "
            "WHERE version_deleted IS NOT NULL AND version_deleted <= ?",
            [gc_horizon],
            "DELETE FROM page_versions WHERE page_no = ? AND version_created = ?",
        )
        self.logger.info(f"Deleted {count} superseded page version(s)")

    def _delete_in_pages(
        self, aa: LibsqlClient, select_sql: str, select_args: list, delete_sql: str
    ) -> int:
        # Bounds both sides of the round trip: the SELECT itself is capped
        # by LIMIT so a huge backlog can't return an oversized response,
        # and each fetched page is deleted as its own small batch before
        # the next SELECT runs.
        total = 0
        while True:
            rows = aa.query(f"{select_sql} LIMIT {GC_BATCH_SIZE}", select_args)
            if not rows:
                return total
            aa.batch([(delete_sql, list(row)) for row in rows])
            total += len(rows)

    def _delete_in_batches(self, aa: LibsqlClient, sql: str, key_rows: list) -> None:
        for i in range(0, len(key_rows), GC_BATCH_SIZE):
            chunk = key_rows[i : i + GC_BATCH_SIZE]
            aa.batch([(sql, list(keys)) for keys in chunk])

    def _collect_bundles(self, aa: LibsqlClient) -> None:
        rows = aa.query("SELECT bundle_key, bundle_enc_key, retired_at FROM bundles")
        live_keys, retired = set(), []
        for wrapped_key, wrapped_enc_key, retired_at in rows:
            enc_key = self.blob.decrypt(wrapped_enc_key, self.umk)
            key = self.blob.decrypt(wrapped_key, enc_key).decode()
            if retired_at is None:
                live_keys.add(key)
            else:
                retired.append((wrapped_key, key))
        self._delete_retired_bundles(aa, retired)
        self._sweep_orphans(f"{self.db_prefix}/b/", live_keys, "Bundle")

    def _delete_retired_bundles(self, aa: LibsqlClient, retired: list) -> None:
        if not retired:
            self.logger.verbose("no retired bundles to delete")
            return
        # R2 deletes are their own concern (delete_keys already chunks at
        # S3's own 1000-key limit) -- only the AA-side row deletes need
        # Turso's smaller per-batch cap.
        self.r2.delete_keys([f"{self.db_prefix}/b/{key}" for _wrapped, key in retired])
        self._delete_in_batches(
            aa, "DELETE FROM bundles WHERE bundle_key = ?", [[wrapped] for wrapped, _key in retired]
        )
        self.logger.verbose(f"deleted {len(retired)} retired bundle(s)")

    def _collect_library_index_orphans(self, aa: LibsqlClient) -> None:
        rows = aa.query("SELECT object_key FROM library_index WHERE id = 1")
        live_keys = set()
        if rows:
            live_keys.add(self.blob.decrypt(rows[0][0], self.umk).decode())
        self._sweep_orphans(f"{self.db_prefix}/i/", live_keys, "Library index")

    def _sweep_orphans(self, prefix: str, live_keys: set, label: str) -> None:
        live_full = {f"{prefix}{key}" for key in live_keys}
        orphans = [key for key in self.r2.list_keys(prefix) if key not in live_full]
        if orphans:
            self.r2.delete_keys(orphans)
        self.logger.info(f"{label} cleanup: removed {len(orphans)} orphan object(s)")

    def _collect_part_orphans(self, aa: LibsqlClient, db_master_key: bytes) -> None:
        self._open_bb_readonly(aa, db_master_key)
        live_prefixes = {
            prefix.decode() for (prefix,) in self.bb.query("SELECT prefix FROM txt")
        }
        root = f"{self.db_prefix}/t/"
        orphans = [
            key for key in self.r2.list_keys(root) if self._doc_prefix(key, root) not in live_prefixes
        ]
        if orphans:
            self.r2.delete_keys(orphans)
        self.logger.info(f"Document parts cleanup: removed {len(orphans)} orphan object(s)")

    def _doc_prefix(self, key: str, root: str) -> str:
        return key[len(root) :].split("/", 1)[0]

    def _open_bb_readonly(self, aa: LibsqlClient, db_master_key: bytes) -> None:
        head_version = self._read_head_version(aa)
        rows = aa.query(
            "SELECT page_no, data FROM page_versions WHERE version_created <= ? "
            "AND (version_deleted IS NULL OR version_deleted > ?)",
            [head_version, head_version],
        )
        self.bb.load_pages({page_no: data for page_no, data in rows})
        self.bb.open(db_master_key)
        self.bb.exec_sql(CREATE_TXT_SQL)
        self.bb.exec_sql(CREATE_TXT_META_SQL)
        self.bb.exec_sql(CREATE_TXT_PARTS_SQL)
