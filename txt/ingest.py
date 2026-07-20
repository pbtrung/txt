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
    """Splits, cleans, uploads to R2, and records each .txt file under its owner."""

    def _insert_txt(self, user_id: int, umk: bytes) -> tuple[int, bytes]:
        txt_key = os.urandom(c.TXT_KEY_LEN)
        blob = Blob.encrypt(umk, txt_key)
        cur = self.db.conn.execute(
            "INSERT INTO txt (user_id, txt_key) VALUES (?, ?)", (user_id, blob)
        )
        txt_id = cur.lastrowid
        logger.debug("Created txt row (txt_id=%d) for user_id=%d", txt_id, user_id)
        return txt_id, txt_key

    @staticmethod
    def _part_path() -> str:
        return base32.encode(os.urandom(c.RAW_PATH_LEN))

    async def _upload_part(
        self, txt_id: int, part_num: int, txt_key: bytes, raw_part: bytes
    ) -> tuple[int, str, bytes]:
        cleaned = preprocess_text(raw_part)
        compressed = brotli.compress(cleaned)
        raw_path = self._part_path()
        logger.debug(
            "txt_id=%d part %d: %d bytes raw -> %d cleaned -> %d compressed, path=%s",
            txt_id,
            part_num,
            len(raw_part),
            len(cleaned),
            len(compressed),
            raw_path,
        )
        await self.r2.put_async(raw_path, Blob.encrypt(txt_key, compressed))
        path_blob = Blob.encrypt(txt_key, raw_path.encode("ascii"))
        return part_num, raw_path, path_blob

    def _insert_part_rows(
        self, txt_id: int, parts: list[tuple[int, str, bytes]]
    ) -> None:
        # One executemany call, not one execute() per part -- still a single
        # uninterrupted, synchronous burst (no awaits in between): the
        # libsql/Hrana connection isn't safe to touch from coroutines left
        # concurrently in flight (see the "stream not found" Hrana error this
        # fixed, from writing a row per part from inside _upload_part while
        # asyncio.gather kept every part's upload concurrently in flight).
        self.db.conn.executemany(
            "INSERT INTO txt_parts (txt_id, part_num, path) VALUES (?, ?, ?)",
            [(txt_id, part_num, path_blob) for part_num, _raw_path, path_blob in parts],
        )
        logger.debug("txt_id=%d: inserted %d txt_parts row(s)", txt_id, len(parts))

    async def _delete_uploaded_parts(
        self, txt_id: int, parts: list[tuple[int, str, bytes]]
    ) -> None:
        # Cleans up parts that already made it to R2 once something later in
        # the same file's ingest fails -- either another part's upload (after
        # exhausting put_async's own retries) or the DB write that was meant
        # to record them -- so they don't linger as orphaned R2 objects
        # nothing will ever reference.
        logger.warning(
            "txt_id=%d: deleting %d already-uploaded R2 part(s)", txt_id, len(parts)
        )
        await asyncio.gather(
            *(
                self.r2.delete_async(raw_path)
                for _part_num, raw_path, _path_blob in parts
            )
        )

    def _update_txt_metadata_entry(
        self, user_id: int, umk: bytes, txt_id: int, name: str
    ) -> None:
        # txt_metadata is a single row per user (user_id is UNIQUE), provisioned
        # by AdminInitializer/--init -- not ingest's job to create it. A single
        # encrypted JSON blob {"<txt_id>": {"name": ...}, ...} indexed by
        # txt_id, so a lookup is O(1) average-case once decrypted -- but every
        # update here decrypts, mutates, and re-encrypts the *entire* blob
        # (there's no partial-update path), so persisting one change costs
        # O(blob size), not O(1). Fine for a per-user filename index, not a
        # design meant to scale to huge per-user document counts.
        row = self.db.conn.execute(
            "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            raise ValueError(
                f"no txt_metadata row for user_id={user_id}; run --init first"
            )
        key_blob, content_blob = row
        txt_metadata_key = Blob.decrypt(umk, key_blob)
        # content is NULL until this user's first txt is ingested (see
        # docs/data_model.md's txt_metadata) -- nothing to decrypt yet then.
        content = (
            json.loads(Blob.decrypt(txt_metadata_key, content_blob, compressed=True))
            if content_blob is not None
            else {}
        )
        content[str(txt_id)] = {"name": name}
        content_blob = Blob.encrypt(
            txt_metadata_key, json.dumps(content).encode(), compressed=True
        )
        self.db.conn.execute(
            "UPDATE txt_metadata SET content = ? WHERE user_id = ?",
            (content_blob, user_id),
        )
        logger.debug(
            "Updated txt_metadata entry for txt_id=%d (user_id=%d)", txt_id, user_id
        )

    async def add_file(self, path: Path) -> int:
        logger.info("Ingesting %s (%d bytes)", path, path.stat().st_size)
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        txt_id, txt_key = self._insert_txt(user_id, umk)
        raw_parts = split_parts(path.read_bytes())
        logger.info(
            "%s (txt_id=%d): split into %d part(s)", path, txt_id, len(raw_parts)
        )
        results = await asyncio.gather(
            *(
                self._upload_part(txt_id, part_num, txt_key, raw_part)
                for part_num, raw_part in enumerate(raw_parts, start=1)
            ),
            return_exceptions=True,
        )
        uploaded = [r for r in results if not isinstance(r, BaseException)]
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            self.db.conn.rollback()
            await self._delete_uploaded_parts(txt_id, uploaded)
            raise RuntimeError(
                f"{path}: {len(failures)}/{len(raw_parts)} part(s) failed to upload "
                f"to R2 after retries (txt_id={txt_id}); deleted {len(uploaded)} "
                "already-uploaded part(s); aborting this file"
            ) from failures[0]
        parts = uploaded
        try:
            self._insert_part_rows(txt_id, parts)
            self.db.conn.execute(
                "INSERT INTO part_count (txt_id, count) VALUES (?, ?)",
                (txt_id, len(raw_parts)),
            )
            self._update_txt_metadata_entry(user_id, umk, txt_id, path.name)
            self.db.conn.commit()
        except Exception:
            self.db.conn.rollback()
            await self._delete_uploaded_parts(txt_id, parts)
            raise
        logger.info(
            "Ingested %s as txt_id=%d (%d part(s))", path, txt_id, len(raw_parts)
        )
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
