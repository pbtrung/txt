"""--txt-ingest: ingest .txt files from a directory into the vault (see docs/data_model.md)."""

import asyncio
import logging
import os
from pathlib import Path

import brotli

from . import base32
from . import constants as c
from .crypto import Blob
from .opf import find_opf_sidecar, parse_opf_metadata
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
    _persist_txt writes the txt row and its parts as one uninterrupted,
    synchronous burst right after part uploads finish, instead of creating
    the txt row up front and leaving the connection idle throughout.

    The txt_metadata update happens after that, as a separate step: its
    content is keyed by txt_id, which doesn't exist until _persist_txt's
    INSERT runs, so it can't be uploaded to R2 ahead of the burst the way
    parts are -- and uploading it *during* the burst would reintroduce
    exactly the idle-stream risk the burst exists to avoid. In the common
    case (this account already has a txt_metadata R2 object -- true for
    every ingest after its first ever) that step is just one R2 PUT
    overwriting that same object in place, no DB write at all (see
    owner.py's _write_txt_metadata_content); only the very first write for
    an account (a brand new one, or one migrating off the pre-R2-indirection
    inline format) needs to establish+commit a path, with its own
    rollback/cleanup if that commit fails. Either way, if the metadata step
    fails, the txt itself is already durable and downloadable (download.py
    falls back to a generic name when no metadata entry exists) -- the only
    cost is that a rerun of --txt-ingest on the same directory won't
    recognize this file as already-ingested (dedup is by name in
    txt_metadata) and may re-ingest it as a duplicate txt.
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

    async def _load_current_metadata(
        self, user_id: int, umk: bytes
    ) -> tuple[bytes, dict, str | None]:
        txt_metadata_key, content, raw_path = await self._txt_metadata_key_and_content(
            user_id, umk
        )
        if txt_metadata_key is None:
            raise ValueError(f"no txt_metadata row for user_id={user_id}; run --init")
        return txt_metadata_key, content, raw_path

    @staticmethod
    def _resolve_opf_metadata(path: Path) -> dict | None:
        opf_path = find_opf_sidecar(path)
        if opf_path is None:
            return None
        metadata = parse_opf_metadata(opf_path)
        logger.info(
            "%s: found OPF sidecar %s (%d field(s))", path, opf_path, len(metadata)
        )
        return metadata

    def _metadata_entry(self, path: Path) -> dict:
        entry = {"name": path.name}
        metadata = self._resolve_opf_metadata(path)
        if metadata:
            entry["metadata"] = metadata
        return entry

    async def _persist_metadata_update(
        self, user_id: int, umk: bytes, txt_id: int, path: Path
    ) -> None:
        # txt_metadata is one encrypted JSON blob per user, not one row per
        # doc (see docs/data_model.md) -- every update rewrites it whole, now
        # via this user's (single, reused) R2 object rather than inline (see
        # class docstring for why this is a separate step from _persist_txt's
        # burst, and owner.py's _write_txt_metadata_content for how reuse
        # avoids a DB write on every update after the first).
        txt_metadata_key, content, raw_path = await self._load_current_metadata(
            user_id, umk
        )
        content[str(txt_id)] = self._metadata_entry(path)
        await self._write_txt_metadata_content(user_id, txt_metadata_key, content, raw_path)
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
        await self._persist_metadata_update(user_id, umk, txt_id, path)
        self._log_ingested(path, txt_id, len(raw_parts))
        return txt_id

    async def _existing_names(self, user_id: int, umk: bytes) -> set[str]:
        _txt_metadata_key, content, _raw_path = await self._txt_metadata_key_and_content(
            user_id, umk
        )
        return {entry["name"] for entry in content.values()}

    @staticmethod
    def _filter_new_files(
        files: list[Path], existing_names: set[str]
    ) -> tuple[list[Path], list[str]]:
        to_ingest = [p for p in files if p.name not in existing_names]
        skipped = [p.name for p in files if p.name in existing_names]
        return to_ingest, skipped

    async def _files_to_ingest(self, src: Path, user_id: int, umk: bytes) -> list[Path]:
        files = sorted(
            p for p in src.iterdir() if p.is_file() and p.suffix.lower() == ".txt"
        )
        # Skip filenames already recorded in txt_metadata.content -- re-running
        # --txt-ingest on the same directory shouldn't re-ingest duplicates.
        existing_names = await self._existing_names(user_id, umk)
        to_ingest, skipped = self._filter_new_files(files, existing_names)
        if skipped:
            logger.info(
                "Skipping %d already-ingested file(s): %s", len(skipped), skipped
            )
        return to_ingest

    async def add_dir(self, src: Path) -> list[int]:
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        files = await self._files_to_ingest(src, user_id, umk)
        logger.info("Found %d .txt file(s) to ingest in %s", len(files), src)
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
