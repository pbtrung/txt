"""--download: reconstruct every txt owned by the account into a directory (see docs/data_model.md)."""

import asyncio
import json
import logging
from pathlib import Path

import brotli

from .creds import AdminCreds
from .crypto import Blob, hmac_sha3_256
from .db import Database
from .r2 import R2Client

logger = logging.getLogger(__name__)


class TxtDownloader:
    """Fetches, decrypts, and concatenates every txt owned by creds.username.

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

    def _txt_names(self, user_id: int, umk: bytes) -> dict[int, str]:
        row = self.db.conn.execute(
            "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if row is None or row[1] is None:
            logger.debug("No txt_metadata content for user_id=%d", user_id)
            return {}
        txt_metadata_key = Blob.decrypt(umk, row[0])
        content = json.loads(
            Blob.decrypt(txt_metadata_key, row[1], compressed=True)
        )
        names = {int(txt_id): entry["name"] for txt_id, entry in content.items()}
        logger.debug("Loaded %d name(s) from txt_metadata", len(names))
        return names

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

    async def _fetch_part(self, txt_key: bytes, raw_path: str) -> bytes:
        body = await self.r2.get_async(raw_path)
        compressed = Blob.decrypt(txt_key, body)
        return brotli.decompress(compressed)

    async def _download_txt(
        self, txt_id: int, umk: bytes, dst: Path, names: dict[int, str]
    ) -> Path:
        txt_key = self._txt_key(txt_id, umk)
        raw_paths = self._part_raw_paths(txt_id, txt_key)
        logger.info("txt_id=%d: fetching %d part(s)", txt_id, len(raw_paths))
        parts = await asyncio.gather(
            *(self._fetch_part(txt_key, raw_path) for raw_path in raw_paths)
        )
        content = b"".join(parts)
        name = names.get(txt_id, f"txt_{txt_id}.txt")
        out_path = dst / name
        out_path.write_bytes(content)
        logger.info(
            "txt_id=%d: wrote %s (%d bytes from %d part(s))",
            txt_id,
            out_path,
            len(content),
            len(raw_paths),
        )
        return out_path

    async def download_all(self, dst: Path) -> list[Path]:
        dst.mkdir(parents=True, exist_ok=True)
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        names = self._txt_names(user_id, umk)
        txt_ids = self._txt_ids(user_id)
        logger.info("Found %d txt(s) for user_id=%d", len(txt_ids), user_id)
        paths = await asyncio.gather(
            *(self._download_txt(txt_id, umk, dst, names) for txt_id in txt_ids)
        )
        paths = list(paths)
        logger.info("Finished downloading %d txt(s) to %s", len(paths), dst)
        return paths
