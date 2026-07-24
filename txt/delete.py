"""--txt-delete/--txt-delete-id: remove txt (and its R2 parts) owned by the account (see docs/data_model.md)."""

import asyncio
import json
import logging

from .crypto import Blob
from .owner import TxtOwner

logger = logging.getLogger(__name__)

# Every table that references txt(id) via a txt_id column -- deleted
# explicitly rather than relying on ON DELETE CASCADE, since nothing in
# txt/db.py enables PRAGMA foreign_keys. txt_access/bookmarks are handled
# separately below: each is one JSON blob per user keyed by txt_id, not a row
# per txt_id (see docs/data_model.md), so there's no txt_id column to delete by.
_CHILD_TABLES = ("txt_parts", "txt_shares", "part_count")

# (table, key_column, content_column) for the two per-user JSON-blob tables.
_JSON_BLOB_TABLES = (
    ("txt_access", "txt_access_key", "access"),
    ("bookmarks", "bookmark_key", "bookmark"),
)


class TxtDeleter(TxtOwner):
    """Deletes txt(s) owned by creds.username: their R2 parts, then their DB rows.

    delete_one deletes a single txt_id, leaving the rest of the account
    untouched; delete_all wipes every txt owned by the account.
    """

    def _scrub_txt_id_entry(
        self,
        table: str,
        key_column: str,
        content_column: str,
        user_id: int,
        umk: bytes,
        txt_id: int,
    ) -> None:
        row = self.db.conn.execute(
            f"SELECT {key_column}, {content_column} FROM {table} WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            return
        key_blob, content_blob = row
        key = Blob.decrypt(umk, key_blob)
        content = json.loads(Blob.decrypt(key, content_blob, compressed=True))
        if str(txt_id) not in content:
            return
        del content[str(txt_id)]
        new_blob = Blob.encrypt(key, json.dumps(content).encode(), compressed=True)
        self.db.conn.execute(
            f"UPDATE {table} SET {content_column} = ? WHERE user_id = ?",
            (new_blob, user_id),
        )
        logger.debug(
            "Removed txt_id=%d entry from %s (user_id=%d)", txt_id, table, user_id
        )

    def _delete_txt_db_rows(self, txt_id: int, user_id: int, umk: bytes) -> None:
        for table in _CHILD_TABLES:
            self.db.conn.execute(f"DELETE FROM {table} WHERE txt_id = ?", (txt_id,))
        for table, key_column, content_column in _JSON_BLOB_TABLES:
            self._scrub_txt_id_entry(
                table, key_column, content_column, user_id, umk, txt_id
            )
        self.db.conn.execute("DELETE FROM txt WHERE id = ?", (txt_id,))
        logger.debug("txt_id=%d: deleted DB rows", txt_id)

    async def _scrub_txt_metadata_entry(self, user_id: int, umk: bytes, txt_id: int) -> None:
        # txt_metadata isn't in _JSON_BLOB_TABLES: its content lives in this
        # user's (single, reused) R2 object, not inline, so it needs its own
        # read-modify-write instead of the generic helper above (see
        # owner.py's _txt_metadata_key_and_content/_write_txt_metadata_content).
        txt_metadata_key, content, raw_path = await self._txt_metadata_key_and_content(
            user_id, umk
        )
        if txt_metadata_key is None or str(txt_id) not in content:
            return
        del content[str(txt_id)]
        await self._write_txt_metadata_content(user_id, txt_metadata_key, content, raw_path)
        logger.debug(
            "Removed txt_id=%d entry from txt_metadata (user_id=%d)", txt_id, user_id
        )

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

    async def _delete_txt(self, txt_id: int, user_id: int, umk: bytes) -> None:
        txt_key = self._txt_key(txt_id, umk)
        raw_paths = self._part_raw_paths(txt_id, txt_key)
        logger.info("txt_id=%d: deleting %d part(s) from R2", txt_id, len(raw_paths))
        await asyncio.gather(*(self.r2.delete_async(p) for p in raw_paths))
        self._delete_txt_db_rows(txt_id, user_id, umk)
        self.db.conn.commit()
        logger.info("txt_id=%d: deleted (%d part(s))", txt_id, len(raw_paths))

    async def delete_one(self, txt_id: int) -> None:
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        if txt_id not in self._txt_ids(user_id):
            raise ValueError(
                f"txt_id={txt_id} not found for username={self.creds.username!r}"
            )
        await self._delete_txt(txt_id, user_id, umk)
        # txt_metadata isn't in _JSON_BLOB_TABLES: delete_all nulls it out in
        # one shot once every txt is gone (see _clear_txt_metadata) rather than
        # paying to rewrite the whole blob per txt_id, but a single-txt delete
        # has no such later step, so it must scrub its own entry here.
        await self._scrub_txt_metadata_entry(user_id, umk, txt_id)
        logger.info("txt_id=%d: deleted", txt_id)

    async def delete_all(self) -> int:
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        txt_ids = self._txt_ids(user_id)
        logger.info("Found %d txt(s) for user_id=%d", len(txt_ids), user_id)
        # One txt at a time -- its parts still delete concurrently -- rather
        # than every txt's parts in flight at once.
        for txt_id in txt_ids:
            await self._delete_txt(txt_id, user_id, umk)
        # Resolved before clearing, and only deleted from R2 after the NULL
        # is safely committed -- deleting first and failing the commit would
        # leave txt_metadata.content pointing at a now-gone R2 object.
        metadata_raw_path = self._txt_metadata_raw_path(user_id, umk)
        self._clear_txt_metadata(user_id)
        self.db.conn.commit()
        if metadata_raw_path is not None:
            await self.r2.delete_async(metadata_raw_path)
        logger.info("Finished deleting %d txt(s)", len(txt_ids))
        return len(txt_ids)
