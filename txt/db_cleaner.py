"""--clean-db: removes stale-state share rows from both the owner's
SQLCipher database and the rqlite control database, then vacuums both.

A `txt_shares`/`shares` row that never reached its terminal state -- stuck
`creating` after a failed upload or registration, or stuck `deleting` after a
failed R2 delete or interrupted gateway call (docs/sharing.md) -- is a
candidate for cleanup. Unlike the gateway, which only ever sees a
grant-decrypted object path for one request, this command holds the owner's
plaintext `db_prefix`/`share_prefix`/`share_path` locally, so it can delete
the R2 object, the rqlite row, and the local row together.

A stuck `creating` row whose control row is already `active` means
registration actually succeeded after all; that row is healed to `active`
locally rather than destroyed. Every other stale row is removed outright: a
`creating` row with no active registration was never publicly readable, and
a `deleting` row -- whatever the control row's state -- reflects the owner's
already-recorded intent to revoke it.

Vacuuming is unconditional: it runs every time, independent of --dry-run and
of whether any stale row was found. --dry-run only gates the stale-row
removal/healing itself.
"""

import hashlib
from dataclasses import dataclass
from pathlib import Path

from .account_data import StorageAccount, parse_storage_account
from .creds import OwnerCreds
from .database_schema import configure_page_size, open_database, table_exists
from .logger import Logger
from .owner_init import OwnerInitializer
from .r2_client import R2Client, R2Object
from .random_token import to_base32_crockford
from .sqlite_engine import SqliteEngine


@dataclass(frozen=True)
class StaleShare:
    row_id: int
    state: str
    object_path: str
    share_id_hash: bytes
    object_path_hash: bytes


class DbCleaner:
    def __init__(
        self,
        creds: OwnerCreds,
        creds_path: str,
        local_db_dir: Path,
        logger: Logger,
        *,
        dry_run: bool = False,
    ):
        self.local_db_dir = local_db_dir
        self.logger = logger
        self.dry_run = dry_run
        self.owner = OwnerInitializer(creds, creds_path, logger)
        self.rqlite = self.owner.rqlite
        self.r2 = R2Client(creds.r2_config)

    def run(self) -> None:
        mode = "dry run" if self.dry_run else "clean mode"
        self.logger.info(f"Starting database cleanup ({mode}).")
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        uid, _umk, payload = self.owner.load_current_owner()
        account = parse_storage_account(uid, payload)
        remote = self._download(account)
        if remote is not None:
            self._clean_sqlcipher(account, remote)
        else:
            self.logger.verbose(f"[{uid}] no database at {account.db_path} yet.")
        self._vacuum_control(uid)

    def _download(self, account: StorageAccount) -> R2Object | None:
        self.logger.verbose(f"[{account.uid}] downloading {account.db_path} from R2...")
        return self.r2.get_object_with_etag(account.db_path)

    def _clean_sqlcipher(self, account: StorageAccount, remote: R2Object) -> None:
        with open_database(
            account.db_master_key,
            remote.body,
            engine_factory=SqliteEngine,
            configure=configure_page_size,
        ) as engine:
            if table_exists(engine, "txt_shares"):
                self._clean_shares(account, engine)
            else:
                self.logger.verbose(f"[{account.uid}] no txt_shares table yet.")
            self._vacuum_sqlcipher(account, engine, remote)

    def _clean_shares(self, account: StorageAccount, engine: SqliteEngine) -> None:
        local_hashes = self._local_share_hashes(engine)
        control_by_id = self._control_rows_by_share_id()
        for share in self._stale_local_shares(account, engine):
            control = control_by_id.get(share.share_id_hash)
            self._clean_one(account.uid, engine, share, control)
        self._clean_orphan_control_rows(account.uid, local_hashes)

    def _local_share_hashes(self, engine: SqliteEngine) -> set[bytes]:
        rows = engine.query("SELECT share_id FROM txt_shares")
        return {hashlib.sha256(bytes(row[0])).digest() for row in rows}

    def _control_rows_by_share_id(self) -> dict[bytes, dict]:
        rows = self.rqlite.query(
            "SELECT share_id_hash, object_path_hash, state FROM shares"
        )
        return {row["share_id_hash"]: row for row in rows}

    def _stale_local_shares(
        self, account: StorageAccount, engine: SqliteEngine
    ) -> list[StaleShare]:
        rows = engine.query(
            "SELECT id, share_id, share_prefix, share_path, state FROM txt_shares "
            "WHERE state IN ('creating', 'deleting')"
        )
        return [self._to_stale_share(account.db_prefix, row) for row in rows]

    def _to_stale_share(self, db_prefix: str, row: tuple) -> StaleShare:
        row_id, share_id, share_prefix, share_path, state = row
        share_id = bytes(share_id)
        object_path = _object_path(db_prefix, bytes(share_prefix), bytes(share_path))
        return StaleShare(
            row_id=row_id,
            state=state,
            object_path=object_path,
            share_id_hash=hashlib.sha256(share_id).digest(),
            object_path_hash=hashlib.sha256(object_path.encode()).digest(),
        )

    def _clean_one(
        self, uid: str, engine: SqliteEngine, share: StaleShare, control: dict | None
    ) -> None:
        if share.state == "creating" and self._is_active(control):
            self._heal_local_share(uid, engine, share)
            return
        self._remove_share(uid, engine, share, control)

    def _is_active(self, control: dict | None) -> bool:
        return control is not None and control["state"] == "active"

    def _heal_local_share(
        self, uid: str, engine: SqliteEngine, share: StaleShare
    ) -> None:
        verb = "Would correct" if self.dry_run else "Correcting"
        self.logger.verbose(
            f"[{uid}] {verb} local state for {share.object_path}: registered "
            "active server-side, so healing to 'active' instead of removing."
        )
        if self.dry_run:
            return
        engine.execute(
            "UPDATE txt_shares SET state = 'active' WHERE id = ?", [share.row_id]
        )

    def _remove_share(
        self, uid: str, engine: SqliteEngine, share: StaleShare, control: dict | None
    ) -> None:
        verb = "Would remove" if self.dry_run else "Removing"
        self.logger.verbose(f"[{uid}] {verb} stale share at {share.object_path}...")
        if self.dry_run:
            return
        self.r2.delete_keys([share.object_path])
        if (
            control is not None
            and control["object_path_hash"] == share.object_path_hash
        ):
            self._delete_control_row(share.share_id_hash, share.object_path_hash)
        engine.execute("DELETE FROM txt_shares WHERE id = ?", [share.row_id])

    def _delete_control_row(
        self, share_id_hash: bytes, object_path_hash: bytes
    ) -> None:
        self.rqlite.execute(
            "DELETE FROM shares WHERE share_id_hash = :share_id_hash "
            "AND object_path_hash = :object_path_hash",
            {"share_id_hash": share_id_hash, "object_path_hash": object_path_hash},
        )

    def _clean_orphan_control_rows(self, uid: str, local_hashes: set[bytes]) -> None:
        rows = self.rqlite.query(
            "SELECT share_id_hash, object_path_hash FROM shares "
            "WHERE state = 'deleting'"
        )
        orphans = [row for row in rows if row["share_id_hash"] not in local_hashes]
        if orphans:
            self.logger.verbose(
                f"[{uid}] {len(orphans)} orphaned control-only stale share row(s)."
            )
        for row in orphans:
            self._clean_orphan_row(uid, row)

    def _clean_orphan_row(self, uid: str, row: dict) -> None:
        verb = "Would remove" if self.dry_run else "Removing"
        self.logger.verbose(
            f"[{uid}] {verb} an orphaned control-only stale share row "
            "(no matching local record; its R2 object cannot be identified)."
        )
        if self.dry_run:
            return
        self._delete_control_row(row["share_id_hash"], row["object_path_hash"])

    def _vacuum_sqlcipher(
        self, account: StorageAccount, engine: SqliteEngine, remote: R2Object
    ) -> None:
        self.logger.verbose(f"[{account.uid}] vacuuming SQLCipher database...")
        engine.vacuum()
        data = engine.to_bytes()
        (self.local_db_dir / account.db_path).write_bytes(data)
        self.r2.put_object(account.db_path, data, if_match=remote.etag)
        self.logger.info(
            f"[{account.uid}] SQLCipher database vacuumed and uploaded "
            f"({len(data)} byte(s))."
        )

    def _vacuum_control(self, uid: str) -> None:
        self.logger.verbose(f"[{uid}] vacuuming control database...")
        self.rqlite.vacuum()
        self.logger.info(f"[{uid}] control database vacuumed.")


def _object_path(db_prefix: str, share_prefix: bytes, share_path: bytes) -> str:
    prefix, path = to_base32_crockford(share_prefix), to_base32_crockford(share_path)
    return f"{db_prefix}/shared/{prefix}/{path}"
