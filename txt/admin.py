"""Creating the admin user's row, umk, key_store keypair, r2_config, and
txt_metadata (see docs/data_model.md). Every step here is create-if-missing,
so --init is safe to re-run at any time -- e.g. to add txt_metadata to an
account initialized before that step existed -- without erroring or
duplicating rows.
"""

import json
import logging
import os

from . import constants as c
from .creds import AdminCreds
from .crypto import Blob, Kem, hmac_sha3_256, pbkdf2_sha3_256
from .db import Database

logger = logging.getLogger(__name__)


class AdminInitializer:
    """Provisions the admin user: users row, umk_store, key_store, r2_config, txt_metadata."""

    def __init__(self, db: Database, creds: AdminCreds) -> None:
        self.db = db
        self.creds = creds

    def _get_or_create_user(self) -> int:
        username_hash = hmac_sha3_256(
            self.creds.username_lookup_key, self.creds.username.encode()
        )
        row = self.db.conn.execute(
            "SELECT id FROM users WHERE username_hash = ?", (username_hash,)
        ).fetchone()
        if row is not None:
            logger.info("users row already exists (id=%d), skipping", row[0])
            return row[0]
        pw_salt = os.urandom(c.PW_SALT_LEN)
        pw_hash = pbkdf2_sha3_256(
            self.creds.password.encode(), pw_salt, c.PBKDF2_ITERATIONS, c.PW_HASH_LEN
        )
        cur = self.db.conn.execute(
            "INSERT INTO users (username_hash, pw_salt, pw_hash) VALUES (?, ?, ?)",
            (username_hash, pw_salt, pw_hash),
        )
        user_id = cur.lastrowid
        logger.info("Inserted users row (id=%d)", user_id)
        return user_id

    def _get_or_create_umk(self, user_id: int) -> bytes:
        row = self.db.conn.execute(
            "SELECT umk FROM umk_store WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row is not None:
            logger.info("umk_store row already exists (user_id=%d), skipping", user_id)
            return Blob.decrypt(self.creds.user_root_key, row[0])
        umk = os.urandom(c.UMK_LEN)
        blob = Blob.encrypt(self.creds.user_root_key, umk)
        self.db.conn.execute(
            "INSERT INTO umk_store (user_id, umk) VALUES (?, ?)", (user_id, blob)
        )
        logger.info("Inserted umk_store row (user_id=%d)", user_id)
        return umk

    def _ensure_key_store(self, user_id: int, umk: bytes) -> None:
        row = self.db.conn.execute(
            "SELECT 1 FROM key_store WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row is not None:
            logger.info(
                "key_store row already exists (user_id=%d), skipping", user_id
            )
            return
        pub_key, priv_key = Kem.keypair()
        priv_blob = Blob.encrypt(umk, priv_key)
        self.db.conn.execute(
            "INSERT INTO key_store (user_id, pub_key, priv_key) VALUES (?, ?, ?)",
            (user_id, pub_key, priv_blob),
        )
        logger.info("Inserted key_store row (user_id=%d)", user_id)

    def _ensure_r2_config(self, user_id: int, umk: bytes) -> None:
        row = self.db.conn.execute(
            "SELECT 1 FROM r2_config WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row is not None:
            logger.info(
                "r2_config row already exists (user_id=%d), skipping", user_id
            )
            return
        # Only the read-only key pair is ever persisted to Turso, regardless of
        # role — read_write_access_key_id/secret stay local to the admin's own
        # credential file and are never written to a multi-user-readable table.
        r2 = self.creds.r2_config
        config = json.dumps(
            {
                "endpoint": r2.endpoint,
                "read_only_access_key_id": r2.read_only_access_key_id,
                "read_only_secret_access_key": r2.read_only_secret_access_key,
                "region": r2.region,
                "bucket": r2.bucket,
            }
        ).encode()
        blob = Blob.encrypt(umk, config, compressed=True)
        self.db.conn.execute(
            "INSERT INTO r2_config (user_id, config) VALUES (?, ?)", (user_id, blob)
        )
        logger.info("Inserted r2_config row (user_id=%d)", user_id)

    def _ensure_txt_metadata(self, user_id: int, umk: bytes) -> None:
        row = self.db.conn.execute(
            "SELECT 1 FROM txt_metadata WHERE user_id = ?", (user_id,)
        ).fetchone()
        if row is not None:
            logger.info(
                "txt_metadata row already exists (user_id=%d), skipping", user_id
            )
            return
        # content stays NULL until this user's first txt is ingested -- there's
        # nothing to encrypt yet (see docs/data_model.md's txt_metadata).
        txt_metadata_key = os.urandom(c.TXT_METADATA_KEY_LEN)
        key_blob = Blob.encrypt(umk, txt_metadata_key)
        self.db.conn.execute(
            "INSERT INTO txt_metadata (user_id, txt_metadata_key, content) VALUES (?, ?, NULL)",
            (user_id, key_blob),
        )
        logger.info("Inserted txt_metadata row (user_id=%d)", user_id)

    def run(self) -> int:
        user_id = self._get_or_create_user()
        umk = self._get_or_create_umk(user_id)
        self._ensure_key_store(user_id, umk)
        self._ensure_r2_config(user_id, umk)
        self._ensure_txt_metadata(user_id, umk)
        self.db.conn.commit()
        logger.info("Admin user provisioned (id=%d)", user_id)
        return user_id
