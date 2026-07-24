"""Shared owner/key resolution for --txt-ingest, --txt-download, and --txt-delete (see docs/data_model.md)."""

import json
import logging
import os

from . import base32
from . import constants as c
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

    def _txt_metadata_row(self, user_id: int) -> tuple[bytes, bytes | None] | None:
        return self.db.conn.execute(
            "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
            (user_id,),
        ).fetchone()

    async def _txt_metadata_key_and_content(
        self, user_id: int, umk: bytes
    ) -> tuple[bytes | None, dict, str | None]:
        """(txt_metadata_key, content, raw_path) for user_id.

        raw_path is the single, stable R2 object this user's txt_metadata
        content lives at -- each user has at most one, reused in place for
        every future update (see _write_txt_metadata_content) rather than
        replaced -- or None if there's nothing to reuse yet: no txt_metadata
        row at all (None, {}, None; shared by TxtIngester, which treats this
        as an error since --init always creates one, and TxtDownloader, which
        tolerates it), content is still NULL (key, {}, None; no txt ingested
        yet), or content is still in the pre-R2-indirection inline format
        from before this format existed (key, content, None) -- distinguished
        from a wrapped path purely by size: a wrapped path blob is always
        small (~184 bytes, see constants.TXT_METADATA_LEGACY_THRESHOLD),
        while inline JSON content is realistically always bigger, once
        there's more than a token amount ingested.
        """
        row = self._txt_metadata_row(user_id)
        if row is None:
            return None, {}, None
        key_blob, content_blob = row
        txt_metadata_key = Blob.decrypt(umk, key_blob)
        if content_blob is None:
            return txt_metadata_key, {}, None
        if len(content_blob) >= c.TXT_METADATA_LEGACY_THRESHOLD:
            content = json.loads(
                Blob.decrypt(txt_metadata_key, content_blob, compressed=True)
            )
            return txt_metadata_key, content, None
        raw_path = Blob.decrypt(txt_metadata_key, content_blob).decode("ascii")
        body = await self.r2.get_async(raw_path)
        content = json.loads(Blob.decrypt(txt_metadata_key, body, compressed=True))
        return txt_metadata_key, content, raw_path

    def _txt_metadata_raw_path(self, user_id: int, umk: bytes) -> str | None:
        """Like _txt_metadata_key_and_content, but resolves only the current
        R2 raw_path (if any) without fetching/decrypting its content -- for
        callers (TxtBucketCleaner, TxtDeleter._clear_txt_metadata) that only
        need to know what object to treat as known/delete, not what's in it.
        """
        row = self._txt_metadata_row(user_id)
        if row is None:
            return None
        key_blob, content_blob = row
        if content_blob is None or len(content_blob) >= c.TXT_METADATA_LEGACY_THRESHOLD:
            return None
        txt_metadata_key = Blob.decrypt(umk, key_blob)
        return Blob.decrypt(txt_metadata_key, content_blob).decode("ascii")

    def _safe_rollback(self, label: str) -> None:
        # rollback() can itself raise (e.g. a broken Hrana stream) -- never
        # let that skip whatever R2 cleanup the caller does next.
        try:
            self.db.conn.rollback()
        except Exception as exc:
            logger.warning("%s: rollback failed: %s", label, exc)

    async def _write_txt_metadata_content(
        self, user_id: int, txt_metadata_key: bytes, content: dict, raw_path: str | None
    ) -> str:
        """Persists content as this user's txt_metadata R2 object.

        Each user has exactly one such object, so an existing raw_path is
        just overwritten in place -- no DB write needed, since the path
        itself never changes once established. raw_path is None only the
        first time this account's content is written to R2 (a brand new
        account, or one migrating off the pre-R2-indirection inline format):
        that case generates a fresh path, uploads to it, and writes+commits
        its wrapped pointer into txt_metadata.content -- rolling the DB back
        and deleting the just-uploaded object if that commit fails, so
        nothing is left orphaned or half-pointed-to.

        Returns the raw_path now in effect (unchanged, unless a fresh one was
        just established).
        """
        body = Blob.encrypt(
            txt_metadata_key, json.dumps(content).encode(), compressed=True
        )
        if raw_path is not None:
            await self.r2.put_async(raw_path, body)
            return raw_path
        new_raw_path = base32.encode(os.urandom(c.RAW_PATH_LEN))
        await self.r2.put_async(new_raw_path, body)
        try:
            path_blob = Blob.encrypt(txt_metadata_key, new_raw_path.encode("ascii"))
            self.db.conn.execute(
                "UPDATE txt_metadata SET content = ? WHERE user_id = ?",
                (path_blob, user_id),
            )
            self.db.conn.commit()
        except Exception:
            self._safe_rollback(f"txt_metadata for user_id={user_id}")
            await self.r2.delete_async(new_raw_path)
            raise
        return new_raw_path
