"""--delete-txt: remove every txt (and its R2 parts) owned by the account (see docs/data_model.md)."""

import asyncio
import logging

from .creds import AdminCreds
from .crypto import Blob, hmac_sha3_256
from .db import Database
from .r2 import R2Client

logger = logging.getLogger(__name__)

# Every table that references txt(id) -- deleted explicitly rather than relying
# on ON DELETE CASCADE, since nothing in txt/db.py enables PRAGMA foreign_keys.
_CHILD_TABLES = ("txt_parts", "txt_shares", "part_count", "txt_access", "bookmarks")


class TxtDeleter:
    """Deletes every txt owned by creds.username: its R2 parts, then its DB rows.

    Owner is the account identified by creds.username -- the same admin user
    --init provisions with this credential file.
    """

    def __init__(self, db: Database, creds: AdminCreds) -> None:
        self.db = db
        self.creds = creds
        self.r2 = R2Client(creds.r2_config)

    def _owner_user_id(self) -> int:
        username_hash = hmac_sha3_256(
            self.creds.username_lookup_key, self.creds.username.encode()
        )
        row = self.db.conn.execute(
            "SELECT id FROM users WHERE username_hash = ?", (username_hash,)
        ).fetchone()
        if row is None:
            raise ValueError(
                f"no user found for username={self.creds.username!r}; run --init first"
            )
        logger.debug(
            "Resolved owner user_id=%d for username=%r", row[0], self.creds.username
        )
        return row[0]

    def _owner_umk(self, user_id: int) -> bytes:
        row = self.db.conn.execute(
            "SELECT umk FROM umk_store WHERE user_id = ?", (user_id,)
        ).fetchone()
        umk = Blob.decrypt(self.creds.user_root_key, row[0])
        logger.debug("Unwrapped umk for user_id=%d", user_id)
        return umk

    def _txt_ids(self, user_id: int) -> list[int]:
        rows = self.db.conn.execute(
            "SELECT id FROM txt WHERE user_id = ?", (user_id,)
        ).fetchall()
        return [row[0] for row in rows]

    def _txt_key(self, txt_id: int, umk: bytes) -> bytes:
        row = self.db.conn.execute(
            "SELECT txt_key FROM txt WHERE id = ?", (txt_id,)
        ).fetchone()
        return Blob.decrypt(umk, row[0])

    def _part_raw_paths(self, txt_id: int, txt_key: bytes) -> list[str]:
        rows = self.db.conn.execute(
            "SELECT path FROM txt_parts WHERE txt_id = ?", (txt_id,)
        ).fetchall()
        return [Blob.decrypt(txt_key, row[0]).decode("ascii") for row in rows]

    def _delete_txt_db_rows(self, txt_id: int) -> None:
        for table in _CHILD_TABLES:
            self.db.conn.execute(f"DELETE FROM {table} WHERE txt_id = ?", (txt_id,))
        self.db.conn.execute("DELETE FROM txt WHERE id = ?", (txt_id,))
        logger.debug("txt_id=%d: deleted DB rows", txt_id)

    def _clear_txt_metadata(self, user_id: int) -> None:
        row = self.db.conn.execute(
            "SELECT 1 FROM txt_metadata WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row is None:
            return
        self.db.conn.execute(
            "UPDATE txt_metadata SET content = NULL WHERE user_id = ?", (user_id,)
        )
        logger.debug("Cleared txt_metadata content for user_id=%d", user_id)

    async def _delete_txt(self, txt_id: int, umk: bytes) -> None:
        txt_key = self._txt_key(txt_id, umk)
        raw_paths = self._part_raw_paths(txt_id, txt_key)
        logger.info("txt_id=%d: deleting %d part(s) from R2", txt_id, len(raw_paths))
        await asyncio.gather(*(self.r2.delete_async(p) for p in raw_paths))
        self._delete_txt_db_rows(txt_id)
        self.db.conn.commit()
        logger.info("txt_id=%d: deleted (%d part(s))", txt_id, len(raw_paths))

    async def delete_all(self) -> int:
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        txt_ids = self._txt_ids(user_id)
        logger.info("Found %d txt(s) for user_id=%d", len(txt_ids), user_id)
        await asyncio.gather(*(self._delete_txt(txt_id, umk) for txt_id in txt_ids))
        self._clear_txt_metadata(user_id)
        self.db.conn.commit()
        logger.info("Finished deleting %d txt(s)", len(txt_ids))
        return len(txt_ids)
