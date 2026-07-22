"""Shared owner/key resolution for --txt-ingest, --txt-download, and --txt-delete (see docs/data_model.md)."""

import json
import logging

from .creds import AdminCreds
from .crypto import Blob
from .db import Database
from .r2 import R2Client

logger = logging.getLogger(__name__)


class TxtOwner:
    """Resolves the account identified by creds.username and its keys.

    Owner is the account identified by creds.username -- the same admin user
    --init provisions with this credential file. Base class for TxtIngester,
    TxtDownloader, and TxtDeleter, which otherwise each need the same handful
    of lookups to get from a credential file to an unwrapped umk/txt_key.
    """

    def __init__(self, db: Database, creds: AdminCreds) -> None:
        self.db = db
        self.creds = creds
        self.r2 = R2Client(creds.r2_config)

    def _owner_user_id(self) -> int:
        username_hash = self.creds.username_hash()
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
        if row is None:
            raise ValueError(
                f"no umk_store row for user_id={user_id}; run --init first"
            )
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
        if row is None:
            raise ValueError(f"no txt row for txt_id={txt_id}")
        return Blob.decrypt(umk, row[0])

    def _part_raw_paths(self, txt_id: int, txt_key: bytes) -> list[str]:
        rows = self.db.conn.execute(
            "SELECT path FROM txt_parts WHERE txt_id = ? ORDER BY part_num ASC",
            (txt_id,),
        ).fetchall()
        return [Blob.decrypt(txt_key, row[0]).decode("ascii") for row in rows]

    def _txt_metadata_key_and_content(
        self, user_id: int, umk: bytes
    ) -> tuple[bytes | None, dict]:
        """(txt_metadata_key, content) for user_id, or (None, {}) if there's no
        txt_metadata row yet, or (key, {}) if the row exists but content is
        still NULL (no txt ingested yet) -- shared by TxtIngester (which needs
        the key to persist new entries, and treats a missing row as an error
        since --init always creates one) and TxtDownloader (which only reads,
        and tolerates either being absent)."""
        row = self.db.conn.execute(
            "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            return None, {}
        key_blob, content_blob = row
        txt_metadata_key = Blob.decrypt(umk, key_blob)
        if content_blob is None:
            return txt_metadata_key, {}
        content = json.loads(
            Blob.decrypt(txt_metadata_key, content_blob, compressed=True)
        )
        return txt_metadata_key, content
