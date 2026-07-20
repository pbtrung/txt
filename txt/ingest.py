"""--txt-ingest: ingest .txt files from a directory into the vault (see docs/data_model.md)."""

import asyncio
import json
import logging
import os
from pathlib import Path

import brotli

from . import base32
from . import constants as c
from .crypto import Blob
from .owner import TxtOwner
from .textproc import preprocess_text, split_parts

logger = logging.getLogger(__name__)


class TxtIngester(TxtOwner):
    """Splits, cleans, uploads to R2, and records each .txt file under its owner.

    txt_key is generated in memory and used to upload every part *before* the
    txt row (and everything else) is written to the DB. Turso's Hrana streams
    expire after ~10s of inactivity (unrecoverable once expired -- see
    https://github.com/tursodatabase/libsql/issues/985), so this DB connection
    must never sit idle across something as slow as R2 uploads-with-retries:
    _persist_txt writes the txt row, its parts, and its metadata entry as one
    uninterrupted, synchronous burst right after uploads finish, instead of
    creating the txt row up front and leaving the connection idle throughout.
    """

    @staticmethod
    def _new_txt_key() -> bytes:
        return os.urandom(c.TXT_KEY_LEN)

    def _insert_txt_row(self, user_id: int, umk: bytes, txt_key: bytes) -> int:
        blob = Blob.encrypt(umk, txt_key)
        cur = self.db.conn.execute(
            "INSERT INTO txt (user_id, txt_key) VALUES (?, ?)", (user_id, blob)
        )
        txt_id = cur.lastrowid
        logger.debug("Created txt row (txt_id=%d) for user_id=%d", txt_id, user_id)
        return txt_id

    @staticmethod
    def _part_path() -> str:
        return base32.encode(os.urandom(c.RAW_PATH_LEN))

    @staticmethod
    def _log_part_upload(
        path: Path, part_num: int, sizes: tuple[int, int, int], raw_path: str
    ) -> None:
        raw_len, cleaned_len, compressed_len = sizes
        logger.debug(
            "%s part %d: %d bytes raw -> %d cleaned -> %d compressed, path=%s",
            path,
            part_num,
            raw_len,
            cleaned_len,
            compressed_len,
            raw_path,
        )

    async def _upload_part(
        self, path: Path, part_num: int, txt_key: bytes, raw_part: bytes
    ) -> tuple[int, str, bytes]:
        cleaned = preprocess_text(raw_part)
        compressed = brotli.compress(cleaned)
        raw_path = self._part_path()
        sizes = (len(raw_part), len(cleaned), len(compressed))
        self._log_part_upload(path, part_num, sizes, raw_path)
        await self.r2.put_async(raw_path, Blob.encrypt(txt_key, compressed))
        path_blob = Blob.encrypt(txt_key, raw_path.encode("ascii"))
        return part_num, raw_path, path_blob

    def _insert_part_rows(
        self, txt_id: int, parts: list[tuple[int, str, bytes]]
    ) -> None:
        # One synchronous burst, no awaits -- concurrent coroutines touching
        # this libsql/Hrana connection caused a "stream not found" error.
        self.db.conn.executemany(
            "INSERT INTO txt_parts (txt_id, part_num, path) VALUES (?, ?, ?)",
            [(txt_id, n, blob) for n, _raw_path, blob in parts],
        )
        self.db.conn.execute(
            "INSERT INTO part_count (txt_id, count) VALUES (?, ?)",
            (txt_id, len(parts)),
        )
        logger.debug("txt_id=%d: inserted %d txt_parts row(s)", txt_id, len(parts))

    async def _delete_uploaded_parts(
        self, label: str, parts: list[tuple[int, str, bytes]]
    ) -> None:
        # Cleans up parts that already made it to R2 once something later
        # fails (another part's upload, or the DB write meant to record
        # them) -- so they don't linger as orphaned R2 objects. label is
        # either "txt_id=N" (if a txt row exists yet) or the file path.
        logger.warning("%s: deleting %d already-uploaded R2 part(s)", label, len(parts))
        raw_paths = [raw_path for _n, raw_path, _blob in parts]
        await asyncio.gather(*(self.r2.delete_async(p) for p in raw_paths))

    @staticmethod
    def _parse_txt_metadata_content(
        txt_metadata_key: bytes, content_blob: bytes | None
    ) -> dict:
        if content_blob is None:
            return {}
        return json.loads(Blob.decrypt(txt_metadata_key, content_blob, compressed=True))

    def _load_txt_metadata(self, user_id: int, umk: bytes) -> tuple[bytes, dict]:
        row = self.db.conn.execute(
            "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"no txt_metadata row for user_id={user_id}; run --init")
        key_blob, content_blob = row
        txt_metadata_key = Blob.decrypt(umk, key_blob)
        content = self._parse_txt_metadata_content(txt_metadata_key, content_blob)
        return txt_metadata_key, content

    def _save_txt_metadata(
        self, user_id: int, txt_metadata_key: bytes, content: dict
    ) -> None:
        content_blob = Blob.encrypt(
            txt_metadata_key, json.dumps(content).encode(), compressed=True
        )
        self.db.conn.execute(
            "UPDATE txt_metadata SET content = ? WHERE user_id = ?",
            (content_blob, user_id),
        )

    def _update_txt_metadata_entry(
        self, user_id: int, umk: bytes, txt_id: int, name: str
    ) -> None:
        # txt_metadata is one encrypted JSON blob per user, not one row per
        # doc (see docs/data_model.md) -- every update rewrites it whole.
        txt_metadata_key, content = self._load_txt_metadata(user_id, umk)
        content[str(txt_id)] = {"name": name}
        self._save_txt_metadata(user_id, txt_metadata_key, content)
        logger.debug(
            "Updated txt_metadata entry for txt_id=%d (user_id=%d)", txt_id, user_id
        )

    async def _gather_uploads(
        self, path: Path, txt_key: bytes, raw_parts: list[bytes]
    ) -> list:
        return await asyncio.gather(
            *(
                self._upload_part(path, n, txt_key, raw_part)
                for n, raw_part in enumerate(raw_parts, start=1)
            ),
            return_exceptions=True,
        )

    @staticmethod
    def _split_upload_results(results: list) -> tuple[list, list]:
        uploaded = [r for r in results if not isinstance(r, BaseException)]
        failures = [r for r in results if isinstance(r, BaseException)]
        return uploaded, failures

    def _safe_rollback(self, label: str) -> None:
        # rollback() can itself raise (e.g. the same broken Hrana stream that
        # caused the failure being handled) -- never let that skip the R2
        # cleanup below, or parts get orphaned in the bucket.
        try:
            self.db.conn.rollback()
        except Exception as exc:
            logger.warning("%s: rollback failed: %s", label, exc)

    async def _abort_ingest(
        self, path: Path, raw_parts: list, uploaded: list, failures: list
    ) -> None:
        # Nothing has touched the DB yet at this point (see _persist_txt), so
        # there's no row to roll back -- only the R2 parts need cleaning up.
        await self._delete_uploaded_parts(str(path), uploaded)
        raise RuntimeError(
            f"{path}: {len(failures)}/{len(raw_parts)} part(s) failed to upload "
            f"to R2 after retries; deleted {len(uploaded)} already-uploaded "
            "part(s); aborting this file"
        ) from failures[0]

    @staticmethod
    def _txt_label(txt_id: int | None, path: Path) -> str:
        return f"txt_id={txt_id}" if txt_id is not None else str(path)

    async def _persist_txt(
        self, user_id: int, umk: bytes, txt_key: bytes, path: Path, parts: list
    ) -> int:
        txt_id = None
        try:
            txt_id = self._insert_txt_row(user_id, umk, txt_key)
            self._insert_part_rows(txt_id, parts)
            self._update_txt_metadata_entry(user_id, umk, txt_id, path.name)
            self.db.conn.commit()
            return txt_id
        except Exception:
            label = self._txt_label(txt_id, path)
            self._safe_rollback(label)
            await self._delete_uploaded_parts(label, parts)
            raise

    @staticmethod
    def _log_ingested(path: Path, txt_id: int, num_parts: int) -> None:
        logger.info("Ingested %s as txt_id=%d (%d part(s))", path, txt_id, num_parts)

    async def add_file(self, path: Path) -> int:
        logger.info("Ingesting %s (%d bytes)", path, path.stat().st_size)
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        txt_key = self._new_txt_key()
        raw_parts = split_parts(path.read_bytes())
        logger.info("%s: %d part(s)", path, len(raw_parts))
        results = await self._gather_uploads(path, txt_key, raw_parts)
        uploaded, failures = self._split_upload_results(results)
        if failures:
            await self._abort_ingest(path, raw_parts, uploaded, failures)
        txt_id = await self._persist_txt(user_id, umk, txt_key, path, uploaded)
        self._log_ingested(path, txt_id, len(raw_parts))
        return txt_id

    async def add_dir(self, src: Path) -> list[int]:
        files = sorted(
            p for p in src.iterdir() if p.is_file() and p.suffix.lower() == ".txt"
        )
        logger.info("Found %d .txt file(s) in %s", len(files), src)
        # One file at a time -- its parts still upload concurrently -- rather
        # than every file's parts in flight at once.
        txt_ids = [await self.add_file(p) for p in files]
        logger.info(
            "Finished ingesting %d file(s) from %s: txt_id(s) = %s",
            len(txt_ids),
            src,
            txt_ids,
        )
        return txt_ids
