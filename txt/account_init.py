import base64
import hashlib
import secrets
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .creds import Creds, UserCreds, ensure_user_root_key
from .crypto_blob import CryptoBlob
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .random_token import CROCKFORD_ALPHABET, generate_random_prefix
from .turso_api import TursoClient, extract_account_name

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

SIGN_VERSION = 1
SIGN_ALGORITHM = "ECDSA-P521-SHA512"
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
        self.admin_creds = admin_creds
        self.target_creds = target_creds
        self.target_creds_path = target_creds_path
        self.logger = logger
        self.account_type = account_type
        account_name = extract_account_name(
            admin_creds.turso_ctl_db_url, admin_creds.turso_ctl_db_name
        )
        self.turso = TursoClient(admin_creds.turso_org_token, account_name)
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)

    def run(self) -> None:
        self.logger.verbose(f"Starting {self.account_type} bootstrap...")
        uid = self._sign_in(self.target_creds)
        ctl = self._ensure_schema()
        self._ensure_users_row(ctl, uid)
        self.target_creds = ensure_user_root_key(
            self.target_creds_path, self.target_creds
        )
        ikm = base64.b64decode(self.target_creds.user_root_key)
        umk = self._ensure_key_store(ctl, uid, ikm)
        payload = self._ensure_cred_store(ctl, uid, umk)
        self._ensure_path_binding(ctl, uid, payload)
        if self.account_type == "user":
            self._ensure_admin_backup(ctl, uid, umk)
        self.logger.info(f"{self.account_type.capitalize()} {uid} ready in ctl.")

    def _sign_in(self, creds: Creds | UserCreds) -> str:
        self.logger.verbose(f"Signing in to Firebase as {creds.firebase_email}...")
        auth = FirebaseAuth(creds.firebase_api_key)
        uid = auth.sign_in(creds.firebase_email, creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _ensure_schema(self) -> LibsqlClient:
        self.logger.verbose(
            f"Minting a database token for {self.admin_creds.turso_ctl_db_name}..."
        )
        token = self.turso.mint_db_token(self.admin_creds.turso_ctl_db_name)
        ctl = LibsqlClient(self.admin_creds.turso_ctl_db_url, token)
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
        rows = ctl.query(
            "SELECT umk, sign_version, sign_algorithm, sign_pubkey, sign_privkey "
            "FROM key_store WHERE user_id = ?",
            [uid],
        )
        if rows:
            self.logger.verbose("key_store row already exists, unwrapping umk...")
            umk = self.blob.decrypt(rows[0][0], ikm)
            self._ensure_signing_key(ctl, uid, umk, rows[0][1:])
            return umk
        return self._insert_key_store(ctl, uid, ikm)

    def _insert_key_store(self, ctl: LibsqlClient, uid: str, ikm: bytes) -> bytes:
        self.logger.verbose("Generating umk...")
        umk = secrets.token_bytes(128)
        wrapped_umk = self.blob.encrypt(umk, ikm)
        sign_pubkey, wrapped_sign_privkey = self._new_signing_key(umk)
        if self.account_type == "admin":
            self._insert_admin_key_store(
                ctl,
                uid,
                umk,
                wrapped_umk,
                sign_pubkey,
                wrapped_sign_privkey,
            )
        else:
            ctl.execute(
                "INSERT INTO key_store "
                "(user_id, umk, sign_version, sign_algorithm, "
                "sign_pubkey, sign_privkey) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    uid,
                    wrapped_umk,
                    SIGN_VERSION,
                    SIGN_ALGORITHM,
                    sign_pubkey,
                    wrapped_sign_privkey,
                ],
            )
        self.logger.verbose("key_store row inserted.")
        return umk

    def _insert_admin_key_store(
        self,
        ctl: LibsqlClient,
        uid: str,
        umk: bytes,
        wrapped_umk: bytes,
        sign_pubkey: bytes,
        wrapped_sign_privkey: bytes,
    ) -> None:
        self.logger.verbose("Generating composite KEM keypair...")
        pk, sk = self.engine.kem_keypair()
        wrapped_privkey = self.blob.encrypt(sk, umk)
        ctl.execute(
            "INSERT INTO key_store "
            "(user_id, umk, pubkey, privkey, sign_version, sign_algorithm, "
            "sign_pubkey, sign_privkey) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                uid,
                wrapped_umk,
                pk,
                wrapped_privkey,
                SIGN_VERSION,
                SIGN_ALGORITHM,
                sign_pubkey,
                wrapped_sign_privkey,
            ],
        )

    def _new_signing_key(self, umk: bytes) -> tuple[bytes, bytes]:
        self.logger.verbose("Generating P-521 request-signing keypair...")
        private_key = ec.generate_private_key(ec.SECP521R1())
        public_der = private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        private_der = private_key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        return public_der, self.blob.encrypt(private_der, umk)

    def _ensure_signing_key(
        self, ctl: LibsqlClient, uid: str, umk: bytes, fields: list
    ) -> None:
        if all(value is None for value in fields):
            public_der, wrapped_private_der = self._new_signing_key(umk)
            ctl.execute(
                "UPDATE key_store SET sign_version = ?, sign_algorithm = ?, "
                "sign_pubkey = ?, sign_privkey = ? WHERE user_id = ?",
                [
                    SIGN_VERSION,
                    SIGN_ALGORITHM,
                    public_der,
                    wrapped_private_der,
                    uid,
                ],
            )
            self.logger.verbose("Added request-signing keypair to key_store.")
            return
        if any(value is None for value in fields):
            raise ValueError(f"incomplete request-signing key for uid={uid}")

        version, algorithm, public_der, wrapped_private_der = fields
        if version != SIGN_VERSION or algorithm != SIGN_ALGORITHM:
            raise ValueError(f"unsupported request-signing suite for uid={uid}")
        try:
            public_key = serialization.load_der_public_key(public_der)
            private_key = serialization.load_der_private_key(
                self.blob.decrypt(wrapped_private_der, umk), password=None
            )
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid request-signing key for uid={uid}") from exc
        if not isinstance(public_key, ec.EllipticCurvePublicKey) or not isinstance(
            public_key.curve, ec.SECP521R1
        ):
            raise ValueError(f"request-signing public key is not P-521 for uid={uid}")
        if not isinstance(private_key, ec.EllipticCurvePrivateKey) or not isinstance(
            private_key.curve, ec.SECP521R1
        ):
            raise ValueError(f"request-signing private key is not P-521 for uid={uid}")
        if public_key.public_numbers() != private_key.public_key().public_numbers():
            raise ValueError(f"request-signing keypair mismatch for uid={uid}")

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
        try:
            db_path = payload["db_path"]
            db_prefix = payload["db_prefix"]
        except KeyError as exc:
            raise ValueError(f"cred_store paths missing for uid={uid}") from exc
        for name, value in (("db_path", db_path), ("db_prefix", db_prefix)):
            if (
                not isinstance(value, str)
                or len(value) != 52
                or any(char not in CROCKFORD_ALPHABET for char in value)
            ):
                raise ValueError(f"invalid {name} in cred_store for uid={uid}")
        binding = hashlib.sha512((db_path + db_prefix).encode()).digest()
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
        """docs/auth.md §2: a second cred_store row, owner_id = the admin's
        uid, wrapped under the admin's own umk -- so the admin alone can
        later recover this user's db_master_key/db_path/db_prefix (used by
        --update-db). Only ever called for account_type == "user"; the
        admin's own self-row from _ensure_cred_store already covers them.
        """
        admin_uid = self._sign_in(self.admin_creds)
        if ctl.query(
            "SELECT 1 FROM cred_store WHERE owner_id = ? AND for_user_id = ?",
            [admin_uid, user_uid],
        ):
            self.logger.verbose(f"admin backup row for {user_uid} already exists.")
            return
        admin_ikm = base64.b64decode(self.admin_creds.user_root_key)
        admin_wrapped_umk = ctl.query(
            "SELECT umk FROM key_store WHERE user_id = ?", [admin_uid]
        )[0][0]
        admin_umk = self.blob.decrypt(admin_wrapped_umk, admin_ikm)
        user_content = ctl.query(
            "SELECT content FROM cred_store WHERE owner_id = ? AND for_user_id = ?",
            [user_uid, user_uid],
        )[0][0]
        payload = self.blob.decrypt_json(user_content, user_umk)
        wrapped_for_admin = self.blob.encrypt_json(payload, admin_umk)
        ctl.execute(
            "INSERT INTO cred_store (owner_id, for_user_id, content) VALUES (?, ?, ?)",
            [admin_uid, user_uid, wrapped_for_admin],
        )
        self.logger.verbose(f"Inserted admin backup cred_store row for {user_uid}.")
