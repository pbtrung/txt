"""Shared owner/key resolution for --txt-ingest, --txt-download, and --txt-delete (see docs/data_model.md)."""

import logging

from .creds import AdminCreds
from .crypto import Blob, hmac_sha3_256
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
            "SELECT path FROM txt_parts WHERE txt_id = ? ORDER BY part_num ASC",
            (txt_id,),
        ).fetchall()
        return [Blob.decrypt(txt_key, row[0]).decode("ascii") for row in rows]
