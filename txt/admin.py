"""Creating the admin user's row, umk, key_store keypair, and r2_config (see docs/data_model.md)."""

import json
import os

import click

from . import constants as c
from .creds import AdminCreds
from .crypto import Blob, Kem, hmac_sha3_256, pbkdf2_sha3_256
from .db import Database


class AdminInitializer:
    """Provisions the first (admin) user: users row, umk_store, key_store, r2_config."""

    def __init__(self, db: Database, creds: AdminCreds) -> None:
        self.db = db
        self.creds = creds

    def _insert_user(self, password: str) -> int:
        username_hash = hmac_sha3_256(
            self.creds.username_lookup_key, self.creds.username.encode()
        )
        if self.db.username_exists(username_hash):
            raise click.ClickException("A user with this username already exists")
        pw_salt = os.urandom(c.PW_SALT_LEN)
        pw_hash = pbkdf2_sha3_256(
            password.encode(), pw_salt, c.PBKDF2_ITERATIONS, c.PW_HASH_LEN
        )
        cur = self.db.conn.execute(
            "INSERT INTO users (username_hash, pw_salt, pw_hash) VALUES (?, ?, ?)",
            (username_hash, pw_salt, pw_hash),
        )
        return cur.lastrowid

    def _insert_umk(self, user_id: int) -> bytes:
        umk = os.urandom(c.UMK_LEN)
        blob = Blob.encrypt(self.creds.user_root_key, umk)
        self.db.conn.execute(
            "INSERT INTO umk_store (user_id, umk) VALUES (?, ?)", (user_id, blob)
        )
        return umk

    def _insert_key_store(self, user_id: int, umk: bytes) -> None:
        pub_key, priv_key = Kem.keypair()
        priv_blob = Blob.encrypt(umk, priv_key)
        self.db.conn.execute(
            "INSERT INTO key_store (user_id, pub_key, priv_key) VALUES (?, ?, ?)",
            (user_id, pub_key, priv_blob),
        )

    def _insert_r2_config(self, user_id: int, umk: bytes) -> None:
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

    def run(self, password: str, verbose: bool = False) -> int:
        user_id = self._insert_user(password)
        umk = self._insert_umk(user_id)
        self._insert_key_store(user_id, umk)
        self._insert_r2_config(user_id, umk)
        self.db.conn.commit()
        if verbose:
            click.echo(f"Created admin user id={user_id}")
        return user_id
