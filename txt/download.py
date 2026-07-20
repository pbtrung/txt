"""--txt-download: reconstruct every txt owned by the account into a directory (see docs/data_model.md)."""

import asyncio
import json
import logging
from pathlib import Path

import brotli

from .crypto import Blob
from .owner import TxtOwner

logger = logging.getLogger(__name__)


class TxtDownloader(TxtOwner):
    """Fetches, decrypts, and concatenates every txt owned by creds.username."""

    def _txt_names(self, user_id: int, umk: bytes) -> dict[int, str]:
        row = self.db.conn.execute(
            "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if row is None or row[1] is None:
            logger.debug("No txt_metadata content for user_id=%d", user_id)
            return {}
        txt_metadata_key = Blob.decrypt(umk, row[0])
        content = json.loads(Blob.decrypt(txt_metadata_key, row[1], compressed=True))
        names = {int(txt_id): entry["name"] for txt_id, entry in content.items()}
        logger.debug("Loaded %d name(s) from txt_metadata", len(names))
        return names

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
        # Fetches all start concurrently (create_task), but are awaited and
        # written in part_num order, one at a time, so at most one part's
        # decompressed bytes -- not the whole document -- is ever in memory.
        tasks = [
            asyncio.create_task(self._fetch_part(txt_key, raw_path))
            for raw_path in raw_paths
        ]
        name = names.get(txt_id, f"txt_{txt_id}.txt")
        out_path = dst / name
        total = 0
        try:
            with out_path.open("wb") as f:
                for task in tasks:
                    part = await task
                    f.write(part)
                    total += len(part)
        except Exception as exc:
            for task in tasks:
                task.cancel()
            out_path.unlink(missing_ok=True)
            raise RuntimeError(
                f"txt_id={txt_id}: failed to fetch part(s) from R2 after retries; "
                f"deleted partial file {out_path}"
            ) from exc
        logger.info(
            "txt_id=%d: wrote %s (%d bytes from %d part(s))",
            txt_id,
            out_path,
            total,
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
        # One txt at a time -- its parts still fetch concurrently -- rather than
        # every txt's parts in flight at once.
        paths = [
            await self._download_txt(txt_id, umk, dst, names) for txt_id in txt_ids
        ]
        logger.info("Finished downloading %d txt(s) to %s", len(paths), dst)
        return paths
