"""--add-txt: ingest .txt files from --src into the vault (see docs/data_model.md)."""

import json
import logging
import os
from pathlib import Path

import brotli

from . import base32
from . import constants as c
from .creds import AdminCreds
from .crypto import Blob, hmac_sha3_256
from .db import Database
from .r2 import R2Client
from .textproc import preprocess_text, split_parts

logger = logging.getLogger(__name__)


class TxtIngester:
    """Splits, cleans, uploads to R2, and records each .txt file under its owner.

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
        return row[0]

    def _owner_umk(self, user_id: int) -> bytes:
        row = self.db.conn.execute(
            "SELECT umk FROM umk_store WHERE user_id = ?", (user_id,)
        ).fetchone()
        return Blob.decrypt(self.creds.user_root_key, row[0])

    def _insert_txt(self, user_id: int, umk: bytes) -> tuple[int, bytes]:
        txt_key = os.urandom(c.TXT_KEY_LEN)
        blob = Blob.encrypt(umk, txt_key)
        cur = self.db.conn.execute(
            "INSERT INTO txt (user_id, txt_key) VALUES (?, ?)", (user_id, blob)
        )
        return cur.lastrowid, txt_key

    @staticmethod
    def _part_path(txt_key: bytes, compressed: bytes) -> str:
        digest = hmac_sha3_256(txt_key, compressed)
        return base32.encode(digest)

    def _insert_part(
        self, txt_id: int, part_num: int, txt_key: bytes, raw_part: bytes
    ) -> None:
        cleaned = preprocess_text(raw_part)
        compressed = brotli.compress(cleaned)
        raw_path = self._part_path(txt_key, compressed)
        self.r2.put(raw_path, Blob.encrypt(txt_key, compressed))
        path_blob = Blob.encrypt(txt_key, raw_path.encode("ascii"))
        self.db.conn.execute(
            "INSERT INTO txt_parts (txt_id, part_num, path) VALUES (?, ?, ?)",
            (txt_id, part_num, path_blob),
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

    def add_file(self, path: Path) -> int:
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        txt_id, txt_key = self._insert_txt(user_id, umk)
        raw_parts = split_parts(path.read_bytes())
        for part_num, raw_part in enumerate(raw_parts, start=1):
            self._insert_part(txt_id, part_num, txt_key, raw_part)
        self.db.conn.execute(
            "INSERT INTO part_count (txt_id, count) VALUES (?, ?)",
            (txt_id, len(raw_parts)),
        )
        self._update_txt_metadata_entry(user_id, umk, txt_id, path.name)
        self.db.conn.commit()
        logger.info(
            "Ingested %s as txt_id=%d (%d part(s))", path, txt_id, len(raw_parts)
        )
        return txt_id

    def add_dir(self, src: Path) -> list[int]:
        files = sorted(
            p for p in src.iterdir() if p.is_file() and p.suffix.lower() == ".txt"
        )
        logger.info("Found %d .txt file(s) in %s", len(files), src)
        return [self.add_file(p) for p in files]
