"""--txt-delete: remove every txt (and its R2 parts) owned by the account (see docs/data_model.md)."""

import asyncio
import logging

from .owner import TxtOwner

logger = logging.getLogger(__name__)

# Every table that references txt(id) -- deleted explicitly rather than relying
# on ON DELETE CASCADE, since nothing in txt/db.py enables PRAGMA foreign_keys.
_CHILD_TABLES = ("txt_parts", "txt_shares", "part_count", "txt_access", "bookmarks")


class TxtDeleter(TxtOwner):
    """Deletes every txt owned by creds.username: its R2 parts, then its DB rows."""

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
