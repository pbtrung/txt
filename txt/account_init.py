import base64
import secrets
import time

from .account_data import parse_storage_account, storage_binding
from .account_keys import AccountKeyStore
from .control_session import (
    ControlFactories,
    ControlSession,
    decode_user_root_key,
    unwrap_umk,
)
from .creds import Creds, UserCreds, ensure_user_root_key
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .random_token import generate_random_prefix
from .turso_api import TursoClient

# docs/auth.md §2.
CREATE_USERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('admin', 'user')),
  created_at INTEGER NOT NULL,
  db_binding_hash BLOB NOT NULL CHECK (length(db_binding_hash) = 64)
)
"""

CREATE_KEY_STORE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS key_store (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  umk BLOB NOT NULL,
  pubkey BLOB,
  privkey BLOB,
  sign_version INTEGER NOT NULL CHECK (sign_version = 1),
  sign_algorithm TEXT NOT NULL CHECK (sign_algorithm = 'ECDSA-P521-SHA512'),
  sign_pubkey BLOB NOT NULL,
  sign_privkey BLOB NOT NULL
)
"""

CREATE_CRED_STORE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS cred_store (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  for_user_id TEXT NOT NULL REFERENCES users(id),
  content BLOB NOT NULL,
  PRIMARY KEY (owner_id, for_user_id)
)
"""

_EMPTY_BINDING = bytes(64)

_SCHEMA_COLUMNS = {
    "users": {
        "db_binding_hash": (
            "ALTER TABLE users ADD COLUMN db_binding_hash BLOB "
            "CHECK (db_binding_hash IS NULL OR length(db_binding_hash) = 64)"
        )
    },
    "key_store": {
        "sign_version": "ALTER TABLE key_store ADD COLUMN sign_version INTEGER",
        "sign_algorithm": "ALTER TABLE key_store ADD COLUMN sign_algorithm TEXT",
        "sign_pubkey": "ALTER TABLE key_store ADD COLUMN sign_pubkey BLOB",
        "sign_privkey": "ALTER TABLE key_store ADD COLUMN sign_privkey BLOB",
    },
}


class AccountInitializer:
    """Provisions one ctl row. For account_type="admin", admin_creds and
    target_creds are the same Creds object (an admin bootstraps itself).
    For "user", admin_creds is the administrator's own (ctl/Turso access),
    target_creds is the new user's own reduced UserCreds (only used to sign
    in as them and discover their uid) -- an ordinary user never touches
    ctl/Turso directly.
    """

    def __init__(
        self,
        admin_creds: Creds,
        target_creds: Creds | UserCreds,
        target_creds_path: str,
        logger: Logger,
        account_type: str,
    ):
        self._set_options(
            admin_creds, target_creds, target_creds_path, logger, account_type
        )
        self.engine = LeancryptoEngine()
        self.control = self._new_control(admin_creds, logger)
        self.blob = self.control.blob
        self.key_store = AccountKeyStore(self.engine, self.blob, logger, account_type)

    def _set_options(self, admin_creds, target_creds, path, logger, account_type):
        self.admin_creds = admin_creds
        self.target_creds = target_creds
        self.target_creds_path = path
        self.logger = logger
        self.account_type = account_type

    def _new_control(self, admin_creds: Creds, logger: Logger) -> ControlSession:
        return ControlSession(
            admin_creds,
            logger,
            factories=ControlFactories(FirebaseAuth, TursoClient, LibsqlClient),
            engine=self.engine,
        )

    def run(self) -> None:
        self.logger.verbose(f"Starting {self.account_type} bootstrap...")
        uid = self._sign_in(self.target_creds)
        ctl = self._ensure_schema()
        self._ensure_users_row(ctl, uid)
        self.target_creds = ensure_user_root_key(
            self.target_creds_path, self.target_creds
        )
        ikm = decode_user_root_key(self.target_creds.user_root_key, uid)
        umk = self._ensure_key_store(ctl, uid, ikm)
        payload = self._ensure_cred_store(ctl, uid, umk)
        self._ensure_path_binding(ctl, uid, payload)
        if self.account_type == "user":
            self._ensure_admin_backup(ctl, uid, umk)
        self.logger.info(f"{self.account_type.capitalize()} {uid} ready in ctl.")

    def _sign_in(self, creds: Creds | UserCreds) -> str:
        return self.control.sign_in(creds)

    def _ensure_schema(self) -> LibsqlClient:
        ctl = self.control.connect()
        self.logger.verbose("Ensuring ctl schema exists...")
        for stmt in (
            CREATE_USERS_TABLE_SQL,
            CREATE_KEY_STORE_TABLE_SQL,
            CREATE_CRED_STORE_TABLE_SQL,
        ):
            ctl.execute(stmt)
        self._ensure_schema_columns(ctl)
        self.logger.verbose("ctl schema ready.")
        return ctl

    def _ensure_schema_columns(self, ctl: LibsqlClient) -> None:
        for table, migrations in _SCHEMA_COLUMNS.items():
            existing = {row[1] for row in ctl.query(f"PRAGMA table_info({table})")}
            for column, statement in migrations.items():
                if column not in existing:
                    self.logger.verbose(f"Adding ctl column {table}.{column}...")
                    ctl.execute(statement)

    def _ensure_users_row(self, ctl: LibsqlClient, uid: str) -> None:
        if ctl.query("SELECT id FROM users WHERE id = ?", [uid]):
            self.logger.verbose(f"users row for {uid} already exists.")
            return
        created_at = int(time.time() * 1000)
        ctl.execute(
            "INSERT INTO users (id, type, created_at, db_binding_hash) "
            "VALUES (?, ?, ?, ?)",
            [uid, self.account_type, created_at, _EMPTY_BINDING],
        )
        self.logger.verbose(f"Inserted users row for {uid} (type={self.account_type}).")

    def _ensure_key_store(self, ctl: LibsqlClient, uid: str, ikm: bytes) -> bytes:
        return self.key_store.ensure(ctl, uid, ikm)

    def _ensure_cred_store(self, ctl: LibsqlClient, uid: str, umk: bytes) -> dict:
        rows = ctl.query(
            "SELECT content FROM cred_store WHERE owner_id = ? AND for_user_id = ?",
            [uid, uid],
        )
        if rows:
            self.logger.verbose("cred_store row already exists.")
            return self.blob.decrypt_json(rows[0][0], umk)
        return self._insert_cred_store(ctl, uid, umk)

    def _insert_cred_store(self, ctl: LibsqlClient, uid: str, umk: bytes) -> dict:
        self.logger.verbose("Generating db_path, db_prefix, and db_master_key...")
        payload = {
            "display_name": self.target_creds.display_name,
            "db_master_key": base64.b64encode(secrets.token_bytes(256)).decode(),
            "db_path": generate_random_prefix(),
            "db_prefix": generate_random_prefix(),
        }
        content = self.blob.encrypt_json(payload, umk)
        ctl.execute(
            "INSERT INTO cred_store (owner_id, for_user_id, content) VALUES (?, ?, ?)",
            [uid, uid, content],
        )
        self.logger.verbose("cred_store row inserted.")
        return payload

    def _ensure_path_binding(self, ctl: LibsqlClient, uid: str, payload: dict) -> None:
        binding = storage_binding(parse_storage_account(uid, payload))
        rows = ctl.query("SELECT db_binding_hash FROM users WHERE id = ?", [uid])
        current = rows[0][0] if rows else None
        if current in (None, _EMPTY_BINDING):
            ctl.execute(
                "UPDATE users SET db_binding_hash = ? WHERE id = ?", [binding, uid]
            )
            self.logger.verbose("Bound db_path and db_prefix to users row.")
        elif not secrets.compare_digest(current, binding):
            raise ValueError(f"cred_store path binding mismatch for uid={uid}")

    def _ensure_admin_backup(
        self, ctl: LibsqlClient, user_uid: str, user_umk: bytes
    ) -> None:
        admin_uid = self._sign_in(self.admin_creds)
        if self._admin_backup_exists(ctl, admin_uid, user_uid):
            self.logger.verbose(f"admin backup row for {user_uid} already exists.")
            return
        admin_umk = unwrap_umk(
            ctl, admin_uid, self.admin_creds.user_root_key, self.blob
        )
        payload = self._self_payload(ctl, user_uid, user_umk)
        self._insert_admin_backup(ctl, admin_uid, user_uid, admin_umk, payload)

    def _admin_backup_exists(
        self, ctl: LibsqlClient, admin_uid: str, user_uid: str
    ) -> bool:
        return bool(
            ctl.query(
                "SELECT 1 FROM cred_store WHERE owner_id = ? AND for_user_id = ?",
                [admin_uid, user_uid],
            )
        )

    def _self_payload(self, ctl: LibsqlClient, uid: str, umk: bytes) -> dict:
        rows = ctl.query(
            "SELECT content FROM cred_store WHERE owner_id = ? AND for_user_id = ?",
            [uid, uid],
        )
        if not rows:
            raise ValueError(f"uid={uid} has no self cred_store row")
        return self.blob.decrypt_json(rows[0][0], umk)

    def _insert_admin_backup(self, ctl, admin_uid, user_uid, admin_umk, payload):
        wrapped_for_admin = self.blob.encrypt_json(payload, admin_umk)
        ctl.execute(
            "INSERT INTO cred_store (owner_id, for_user_id, content) VALUES (?, ?, ?)",
            [admin_uid, user_uid, wrapped_for_admin],
        )
        self.logger.verbose(f"Inserted admin backup cred_store row for {user_uid}.")
