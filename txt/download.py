"""--txt-download: reconstruct every txt owned by the account into a directory (see docs/data_model.md)."""

import asyncio
import json
import logging
from pathlib import Path

import brotli

from .crypto import Blob
from .opf import metadata_sidecar_name
from .owner import TxtOwner

logger = logging.getLogger(__name__)


class TxtDownloader(TxtOwner):
    """Fetches, decrypts, and concatenates every txt owned by creds.username."""

    def _txt_entries(self, user_id: int, umk: bytes) -> dict[int, dict]:
        _txt_metadata_key, content = self._txt_metadata_key_and_content(user_id, umk)
        entries = {int(txt_id): entry for txt_id, entry in content.items()}
        logger.debug("Loaded %d txt_metadata entry(ies)", len(entries))
        return entries

    async def _fetch_part(self, txt_key: bytes, raw_path: str) -> bytes:
        body = await self.r2.get_async(raw_path)
        compressed = Blob.decrypt(txt_key, body)
        return brotli.decompress(compressed)

    def _start_part_fetches(self, txt_key: bytes, raw_paths: list[str]) -> list:
        # Fetches all start concurrently; awaited/written in part_num order
        # later (see _write_parts_to_file) so at most one part's decompressed
        # bytes -- not the whole document -- is ever in memory.
        return [
            asyncio.create_task(self._fetch_part(txt_key, raw_path))
            for raw_path in raw_paths
        ]

    @staticmethod
    async def _write_parts_to_file(out_path: Path, tasks: list) -> int:
        total = 0
        with out_path.open("wb") as f:
            for task in tasks:
                part = await task
                f.write(part)
                total += len(part)
        return total

    @staticmethod
    async def _abort_download(
        txt_id: int, out_path: Path, tasks: list, exc: Exception
    ) -> None:
        for task in tasks:
            task.cancel()
        # Cancelling only schedules it -- await so the tasks are actually
        # unwound before this coroutine returns, rather than leaving them
        # pending for asyncio to complain about at event-loop teardown.
        await asyncio.gather(*tasks, return_exceptions=True)
        out_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"txt_id={txt_id}: failed to fetch part(s) from R2 after retries; "
            f"deleted partial file {out_path}"
        ) from exc

    @staticmethod
    def _log_download_done(
        txt_id: int, out_path: Path, total: int, num_parts: int
    ) -> None:
        logger.info(
            "txt_id=%d: wrote %s (%d bytes from %d part(s))",
            txt_id,
            out_path,
            total,
            num_parts,
        )

    @staticmethod
    def _write_metadata_sidecar(
        txt_id: int, dst: Path, name: str, metadata: dict
    ) -> None:
        sidecar_name = metadata_sidecar_name(name)
        if sidecar_name is None:
            return
        sidecar_path = dst / sidecar_name
        sidecar_path.write_text(json.dumps({"metadata": metadata}, indent=2))
        logger.info("txt_id=%d: wrote %s", txt_id, sidecar_path)

    async def _download_txt(
        self, txt_id: int, umk: bytes, dst: Path, entries: dict[int, dict]
    ) -> Path:
        txt_key = self._txt_key(txt_id, umk)
        raw_paths = self._part_raw_paths(txt_id, txt_key)
        logger.info("txt_id=%d: fetching %d part(s)", txt_id, len(raw_paths))
        tasks = self._start_part_fetches(txt_key, raw_paths)
        entry = entries.get(txt_id, {})
        name = entry.get("name", f"txt_{txt_id}.txt")
        out_path = dst / name
        try:
            total = await self._write_parts_to_file(out_path, tasks)
        except Exception as exc:
            await self._abort_download(txt_id, out_path, tasks, exc)
        self._log_download_done(txt_id, out_path, total, len(raw_paths))
        metadata = entry.get("metadata")
        if metadata:
            self._write_metadata_sidecar(txt_id, dst, name, metadata)
        return out_path

    async def download_all(self, dst: Path) -> list[Path]:
        dst.mkdir(parents=True, exist_ok=True)
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        entries = self._txt_entries(user_id, umk)
        txt_ids = self._txt_ids(user_id)
        logger.info("Found %d txt(s) for user_id=%d", len(txt_ids), user_id)
        # One txt at a time -- its parts still fetch concurrently -- rather than
        # every txt's parts in flight at once.
        paths = [
            await self._download_txt(txt_id, umk, dst, entries) for txt_id in txt_ids
        ]
        logger.info("Finished downloading %d txt(s) to %s", len(paths), dst)
        return paths
