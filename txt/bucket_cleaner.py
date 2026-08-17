"""Remove R2 objects not referenced by any account reachable by an admin."""

import base64
import binascii

from .creds import Creds
from .crypto_blob import CryptoBlob
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .r2_client import R2Client
from .random_token import to_base32_crockford
from .sqlite_engine import SqliteEngine
from .turso_api import TursoClient, extract_account_name


class BucketCleaner:
    def __init__(self, creds: Creds, logger: Logger, dry_run: bool = False):
        if creds.r2_config is None:
            raise ValueError("--clean-bucket requires r2_config in creds.json")
        self.creds = creds
        self.logger = logger
        self.dry_run = dry_run
        account_name = extract_account_name(
            creds.turso_ctl_db_url, creds.turso_ctl_db_name
        )
        self.turso = TursoClient(creds.turso_org_token, account_name)
        self.r2 = R2Client(creds.r2_config)
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)

    def run(self) -> None:
        admin_uid = self._sign_in()
        ctl = self._connect_ctl()
        admin_umk = self._admin_umk(ctl, admin_uid)
        accounts = self._reachable_accounts(ctl, admin_uid, admin_umk)
        if not accounts:
            raise ValueError(
                "No accounts are reachable from this admin; refusing to clean bucket"
            )

        allowlist = self._storage_allowlist(accounts)
        bucket_keys = set(self.r2.list_keys(""))
        retained = bucket_keys & allowlist
        stale = sorted(bucket_keys - retained)

        self.logger.info(
            f"{len(accounts)} account(s), {len(bucket_keys)} bucket object(s), "
            f"{len(retained)} retained, {len(stale)} stale."
        )
        for key in stale:
            action = "Would delete" if self.dry_run else "Deleting"
            self.logger.verbose(f"{action} {key}")

        if self.dry_run:
            self.logger.info(f"Dry run: would delete {len(stale)} object(s).")
            return
        self.r2.delete_keys(stale)
        self.logger.info(f"Deleted {len(stale)} object(s).")

    def _sign_in(self) -> str:
        self.logger.verbose(f"Signing in to Firebase as {self.creds.firebase_email}...")
        auth = FirebaseAuth(self.creds.firebase_api_key)
        uid = auth.sign_in(self.creds.firebase_email, self.creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _connect_ctl(self) -> LibsqlClient:
        self.logger.verbose(
            f"Minting a database token for {self.creds.turso_ctl_db_name}..."
        )
        token = self.turso.mint_db_token(self.creds.turso_ctl_db_name)
        return LibsqlClient(self.creds.turso_ctl_db_url, token)

    def _admin_umk(self, ctl: LibsqlClient, admin_uid: str) -> bytes:
        rows = ctl.query("SELECT umk FROM key_store WHERE user_id = ?", [admin_uid])
        if not rows:
            raise ValueError(f"Admin uid={admin_uid} has no key_store row")
        ikm = base64.b64decode(self.creds.user_root_key)
        return self.blob.decrypt(rows[0][0], ikm)

    def _reachable_accounts(
        self, ctl: LibsqlClient, admin_uid: str, admin_umk: bytes
    ) -> list[tuple[str, dict]]:
        user_ids = {row[0] for row in ctl.query("SELECT id FROM users")}
        rows = ctl.query(
            "SELECT for_user_id, content FROM cred_store WHERE owner_id = ?",
            [admin_uid],
        )
        reachable_ids = {row[0] for row in rows}
        missing = sorted(user_ids - reachable_ids)
        if missing:
            raise ValueError(
                "Refusing to clean bucket: no admin cred_store backup for uid(s): "
                + ", ".join(missing)
            )
        return [
            (uid, self.blob.decrypt_json(content, admin_umk)) for uid, content in rows
        ]

    def _storage_allowlist(self, accounts: list[tuple[str, dict]]) -> set[str]:
        allowlist: set[str] = set()
        for uid, payload in accounts:
            db_path = payload.get("db_path")
            db_prefix = payload.get("db_prefix")
            if not isinstance(db_path, str) or not db_path:
                raise ValueError(f"Account uid={uid} has an invalid db_path")
            if not isinstance(db_prefix, str) or not db_prefix:
                raise ValueError(f"Account uid={uid} has an invalid db_prefix")

            db_master_key = self._decode_db_master_key(uid, payload)
            content_keys = self._content_keys(uid, db_path, db_prefix, db_master_key)
            allowlist.add(db_path)
            allowlist.update(content_keys)
            self.logger.verbose(
                f"[{uid}] db_path={db_path}, db_prefix={db_prefix}/, "
                f"{len(content_keys)} referenced content object(s)"
            )
        return allowlist

    def _decode_db_master_key(self, uid: str, payload: dict) -> bytes:
        value = payload.get("db_master_key")
        if not isinstance(value, str) or not value:
            raise ValueError(f"Account uid={uid} has an invalid db_master_key")
        try:
            key = base64.b64decode(value, validate=True)
        except ValueError, binascii.Error:
            raise ValueError(
                f"Account uid={uid} has an invalid db_master_key"
            ) from None
        if len(key) != 256:
            raise ValueError(f"Account uid={uid} has an invalid db_master_key")
        return key

    def _content_keys(
        self, uid: str, db_path: str, db_prefix: str, db_master_key: bytes
    ) -> set[str]:
        self.logger.verbose(f"[{uid}] downloading db_path={db_path} from R2...")
        data = self.r2.get_object(db_path)
        if data is None:
            self.logger.verbose(
                f"[{uid}] db_path={db_path} does not exist; "
                "no content objects are referenced yet"
            )
            return set()
        if not data:
            raise ValueError(f"Account uid={uid} has an empty database at {db_path}")

        engine = SqliteEngine()
        engine.open(db_master_key, initial_bytes=data)
        try:
            # SQLCipher encrypts page 1, so SQLite cannot infer the database's
            # non-default page size from its header. This must be reapplied
            # before the first schema read, just as ingest and --update-db do.
            engine.exec_sql("PRAGMA page_size = 16384")
            table_exists = engine.query(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'txt'"
            )
            rows = (
                engine.query("SELECT txt_prefix, path FROM txt") if table_exists else []
            )
        finally:
            engine.close()

        content_keys = set()
        for txt_prefix, path in rows:
            txt_prefix = self._key_bytes(uid, "txt_prefix", txt_prefix)
            path = self._key_bytes(uid, "path", path)
            content_keys.add(
                f"{db_prefix}/{to_base32_crockford(txt_prefix)}"
                f"/{to_base32_crockford(path)}"
            )
        return content_keys

    def _key_bytes(self, uid: str, field: str, value) -> bytes:
        if not isinstance(value, (bytes, bytearray, memoryview)) or len(value) != 32:
            raise ValueError(f"Account uid={uid} has an invalid txt.{field} value")
        return bytes(value)
