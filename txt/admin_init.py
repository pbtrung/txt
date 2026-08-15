import base64
import secrets
import time

from .creds import Creds, ensure_user_root_key
from .crypto_blob import CryptoBlob
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .random_token import generate_random_prefix
from .turso_api import TursoClient, extract_account_name

# docs/auth.md §2.
CREATE_USERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('admin', 'user')),
  created_at INTEGER NOT NULL
)
"""

CREATE_KEY_STORE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS key_store (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  umk BLOB NOT NULL,
  pubkey BLOB,
  privkey BLOB
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


class AdminInitializer:
    def __init__(self, creds: Creds, creds_path: str, logger: Logger):
        self.creds = creds
        self.creds_path = creds_path
        self.logger = logger
        account_name = extract_account_name(
            creds.turso_ctl_db_url, creds.turso_ctl_db_name
        )
        self.turso = TursoClient(creds.turso_org_token, account_name)
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)

    def run(self) -> None:
        self.logger.verbose("Starting admin bootstrap...")
        uid = self._sign_in()
        ctl = self._ensure_schema()
        self._ensure_users_row(ctl, uid)
        self.creds = ensure_user_root_key(self.creds_path, self.creds)
        ikm = base64.b64decode(self.creds.user_root_key)
        umk = self._ensure_key_store(ctl, uid, ikm)
        self._ensure_cred_store(ctl, uid, umk)
        self.logger.info(f"Admin {uid} ready in ctl.")

    def _sign_in(self) -> str:
        self.logger.verbose(f"Signing in to Firebase as {self.creds.firebase_email}...")
        auth = FirebaseAuth(self.creds.firebase_api_key)
        uid = auth.sign_in(self.creds.firebase_email, self.creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _ensure_schema(self) -> LibsqlClient:
        self.logger.verbose(
            f"Minting a database token for {self.creds.turso_ctl_db_name}..."
        )
        token = self.turso.mint_db_token(self.creds.turso_ctl_db_name)
        ctl = LibsqlClient(self.creds.turso_ctl_db_url, token)
        self.logger.verbose("Ensuring ctl schema exists...")
        for stmt in (
            CREATE_USERS_TABLE_SQL,
            CREATE_KEY_STORE_TABLE_SQL,
            CREATE_CRED_STORE_TABLE_SQL,
        ):
            ctl.execute(stmt)
        self.logger.verbose("ctl schema ready.")
        return ctl

    def _ensure_users_row(self, ctl: LibsqlClient, uid: str) -> None:
        if ctl.query("SELECT id FROM users WHERE id = ?", [uid]):
            self.logger.verbose(f"users row for {uid} already exists.")
            return
        created_at = int(time.time() * 1000)
        ctl.execute(
            "INSERT INTO users (id, type, created_at) VALUES (?, 'admin', ?)",
            [uid, created_at],
        )
        self.logger.verbose(f"Inserted users row for {uid} (type=admin).")

    def _ensure_key_store(self, ctl: LibsqlClient, uid: str, ikm: bytes) -> bytes:
        rows = ctl.query("SELECT umk FROM key_store WHERE user_id = ?", [uid])
        if rows:
            self.logger.verbose("key_store row already exists, unwrapping umk...")
            return self.blob.decrypt(rows[0][0], ikm)
        return self._insert_key_store(ctl, uid, ikm)

    def _insert_key_store(self, ctl: LibsqlClient, uid: str, ikm: bytes) -> bytes:
        self.logger.verbose("Generating umk and composite KEM keypair...")
        umk = secrets.token_bytes(128)
        pk, sk = self.engine.kem_keypair()
        wrapped_umk, wrapped_privkey = self.blob.encrypt(umk, ikm), self.blob.encrypt(
            sk, umk
        )
        ctl.execute(
            "INSERT INTO key_store (user_id, umk, pubkey, privkey) VALUES (?, ?, ?, ?)",
            [uid, wrapped_umk, pk, wrapped_privkey],
        )
        self.logger.verbose("key_store row inserted.")
        return umk

    def _ensure_cred_store(self, ctl: LibsqlClient, uid: str, umk: bytes) -> None:
        rows = ctl.query(
            "SELECT content FROM cred_store WHERE owner_id = ? AND for_user_id = ?",
            [uid, uid],
        )
        if rows:
            self.logger.verbose("cred_store row already exists.")
            return
        self._insert_cred_store(ctl, uid, umk)

    def _insert_cred_store(self, ctl: LibsqlClient, uid: str, umk: bytes) -> None:
        self.logger.verbose("Generating db_path, db_prefix, and db_master_key...")
        payload = {
            "display_name": self.creds.display_name,
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
