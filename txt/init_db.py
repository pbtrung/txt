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
from .turso_api import TursoClient, extract_db_name

SCHEMA_SQL = [
    """CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
        db_prefix BLOB NOT NULL, page_size INTEGER NOT NULL,
        head_version INTEGER NOT NULL DEFAULT 0, gc_horizon INTEGER NOT NULL DEFAULT 0,
        index_dirty_at INTEGER, created_at INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS versions (
        version INTEGER PRIMARY KEY, parent_version INTEGER,
        committed_at INTEGER NOT NULL, page_count INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS page_versions (
        page_no INTEGER NOT NULL, version_created INTEGER NOT NULL,
        version_deleted INTEGER, data BLOB NOT NULL,
        PRIMARY KEY (page_no, version_created)) WITHOUT ROWID""",
    """CREATE INDEX IF NOT EXISTS idx_pv_live ON page_versions(page_no, version_created)
        WHERE version_deleted IS NULL""",
    "CREATE INDEX IF NOT EXISTS idx_pv_created ON page_versions(version_created)",
    "CREATE INDEX IF NOT EXISTS idx_pv_deleted ON page_versions(version_deleted)",
    """CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY, version INTEGER NOT NULL, holder TEXT NOT NULL,
        opened_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_snapshots_version ON snapshots(version)",
    "CREATE INDEX IF NOT EXISTS idx_snapshots_heartbeat ON snapshots(heartbeat_at)",
    """CREATE TABLE IF NOT EXISTS bundles (
        bundle_key BLOB PRIMARY KEY, built_at_version INTEGER NOT NULL,
        byte_size INTEGER NOT NULL, map_rows INTEGER NOT NULL, page_count INTEGER NOT NULL,
        built_at INTEGER NOT NULL, retired_at INTEGER)""",
    """CREATE TABLE IF NOT EXISTS library_index (
        id INTEGER PRIMARY KEY CHECK (id = 1), object_key BLOB NOT NULL,
        built_at_version INTEGER NOT NULL, byte_size INTEGER NOT NULL,
        doc_count INTEGER NOT NULL, content_hash BLOB NOT NULL, built_at INTEGER NOT NULL)""",
]

KEY_STORE_ADMIN_SQL = """CREATE TABLE IF NOT EXISTS key_store (
    id INTEGER PRIMARY KEY CHECK (id = 1), umk BLOB NOT NULL,
    pubkey BLOB NOT NULL, privkey BLOB NOT NULL)"""

KEY_STORE_USER_SQL = """CREATE TABLE IF NOT EXISTS key_store (
    id INTEGER PRIMARY KEY CHECK (id = 1), umk BLOB NOT NULL)"""

CRED_STORE_ADMIN_SQL = """CREATE TABLE IF NOT EXISTS cred_store (
    id INTEGER PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, content BLOB NOT NULL)"""

CRED_STORE_USER_SQL = """CREATE TABLE IF NOT EXISTS cred_store (
    id INTEGER PRIMARY KEY CHECK (id = 1), content BLOB NOT NULL)"""

PAGE_SIZE = 32768  # 32 KiB, BB's SQLCipher page size
SCHEMA_VERSION = 1


class DbInitializer:
    def __init__(self, creds: Creds, creds_path: str, logger: Logger):
        self.creds = creds
        self.creds_path = creds_path
        self.logger = logger
        self.turso = TursoClient(creds.turso_org_token, creds.turso_org)
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)

    def run(self) -> None:
        uid = self._sign_in()
        ctl, db_path, account_type = self._lookup_user(uid)
        if db_path is None:
            db_path = self._create_database(ctl, uid)
        aa = self._connect_aa(db_path)
        self._ensure_schema(aa, account_type)
        self.creds = ensure_user_root_key(self.creds_path, self.creds)
        ikm = base64.b64decode(self.creds.user_root_key)
        umk = self._ensure_umk(aa, account_type, ikm)
        db_prefix = self._ensure_meta(aa, umk)
        self._ensure_cred_store(aa, uid, account_type, umk)
        self.logger.info(
            f"Initialized database for {uid} (type={account_type}, db_prefix={db_prefix})"
        )

    def _sign_in(self) -> str:
        self.logger.verbose(f"Signing in to Firebase as {self.creds.firebase_email}...")
        auth = FirebaseAuth(self.creds.firebase_api_key)
        uid = auth.sign_in(self.creds.firebase_email, self.creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _lookup_user(self, uid: str) -> tuple[LibsqlClient, str | None, str]:
        self.logger.verbose("Looking up this user's db_path in ctl...")
        db_name = extract_db_name(self.creds.turso_ctl_db_url, self.creds.turso_org)
        ctl_token = self.turso.mint_db_token(db_name)
        ctl = LibsqlClient(self.creds.turso_ctl_db_url, ctl_token)
        rows = ctl.query("SELECT db_path, type FROM users WHERE id = ?", [uid])
        if not rows:
            raise ValueError(
                f"uid={uid} has no users row in ctl; run --init-admin first"
            )
        self.logger.verbose(f"Found db_path={rows[0][0]}, type={rows[0][1]}")
        return ctl, rows[0][0], rows[0][1]

    def _create_database(self, ctl: LibsqlClient, uid: str) -> str:
        db_path = generate_random_prefix()
        self.logger.verbose(f"Creating Turso database {db_path} in group {self.creds.turso_group}...")
        self.turso.create_database(db_path, self.creds.turso_group)
        ctl.execute("UPDATE users SET db_path = ? WHERE id = ?", [db_path, uid])
        self.logger.verbose(f"db_path={db_path} recorded in ctl.")
        return db_path

    def _connect_aa(self, db_path: str) -> LibsqlClient:
        self.logger.verbose(f"Minting a database token for {db_path}...")
        token = self.turso.mint_db_token(db_path)
        url = f"libsql://{db_path}-{self.creds.turso_org}.aws-us-east-1.turso.io"
        return LibsqlClient(url, token)

    def _ensure_schema(self, aa: LibsqlClient, account_type: str) -> None:
        self.logger.verbose("Ensuring AA schema exists...")
        # Must run before any CREATE TABLE: SQLite only honors page_size on an
        # empty database. Matches BB's own page size (docs/data_model.md §3).
        aa.execute(f"PRAGMA page_size = {PAGE_SIZE}")
        for stmt in SCHEMA_SQL:
            aa.execute(stmt)
        is_admin = account_type == "admin"
        aa.execute(KEY_STORE_ADMIN_SQL if is_admin else KEY_STORE_USER_SQL)
        aa.execute(CRED_STORE_ADMIN_SQL if is_admin else CRED_STORE_USER_SQL)
        self.logger.verbose("AA schema ready.")

    def _ensure_meta(self, aa: LibsqlClient, umk: bytes) -> str:
        rows = aa.query("SELECT db_prefix FROM meta WHERE id = 1")
        if rows:
            db_prefix = self.blob.decrypt(rows[0][0], umk).decode()
            self.logger.verbose(f"meta already initialized, db_prefix={db_prefix}")
            return db_prefix
        db_prefix = generate_random_prefix()
        self.logger.verbose(f"Generated db_prefix={db_prefix}, inserting meta row...")
        wrapped_db_prefix = self.blob.encrypt(db_prefix.encode(), umk)
        aa.execute(
            "INSERT INTO meta (id, schema_version, db_prefix, page_size, created_at) VALUES (1, ?, ?, ?, ?)",
            [SCHEMA_VERSION, wrapped_db_prefix, PAGE_SIZE, int(time.time() * 1000)],
        )
        return db_prefix

    def _ensure_umk(self, aa: LibsqlClient, account_type: str, ikm: bytes) -> bytes:
        rows = aa.query("SELECT umk FROM key_store WHERE id = 1")
        if rows:
            self.logger.verbose("key_store already initialized, unwrapping umk...")
            return self.blob.decrypt(rows[0][0], ikm)
        return self._create_key_store(aa, ikm, account_type)

    def _create_key_store(
        self, aa: LibsqlClient, ikm: bytes, account_type: str
    ) -> bytes:
        self.logger.verbose("Generating umk for key_store...")
        umk = secrets.token_bytes(128)
        wrapped_umk = self.blob.encrypt(umk, ikm)
        if account_type == "admin":
            self._insert_admin_key_store(aa, umk, wrapped_umk)
        else:
            aa.execute("INSERT INTO key_store (id, umk) VALUES (1, ?)", [wrapped_umk])
        self.logger.verbose("key_store initialized.")
        return umk

    def _insert_admin_key_store(
        self, aa: LibsqlClient, umk: bytes, wrapped_umk: bytes
    ) -> None:
        self.logger.verbose("Generating composite KEM keypair for key_store...")
        pk, sk = self.engine.kem_keypair()
        wrapped_privkey = self.blob.encrypt(sk, umk)
        aa.execute(
            "INSERT INTO key_store (id, umk, pubkey, privkey) VALUES (1, ?, ?, ?)",
            [wrapped_umk, pk, wrapped_privkey],
        )

    def _ensure_cred_store(
        self, aa: LibsqlClient, uid: str, account_type: str, umk: bytes
    ) -> None:
        existing = self._existing_cred_store(aa, uid, account_type)
        if existing:
            self.logger.verbose("cred_store already has a backup row for this account.")
            return
        self._insert_cred_store(aa, uid, account_type, umk)

    def _existing_cred_store(
        self, aa: LibsqlClient, uid: str, account_type: str
    ) -> list:
        if account_type == "admin":
            return aa.query("SELECT content FROM cred_store WHERE user_id = ?", [uid])
        return aa.query("SELECT content FROM cred_store WHERE id = 1")

    def _insert_cred_store(
        self, aa: LibsqlClient, uid: str, account_type: str, umk: bytes
    ) -> None:
        db_master_key = base64.b64encode(secrets.token_bytes(256)).decode()
        payload = {
            "display_name": self.creds.display_name,
            "db_master_key": db_master_key,
        }
        content = self.blob.encrypt_json(payload, umk)
        self._write_cred_store(aa, uid, account_type, content)
        self.logger.verbose("cred_store row inserted.")

    def _write_cred_store(
        self, aa: LibsqlClient, uid: str, account_type: str, content: bytes
    ) -> None:
        if account_type == "admin":
            aa.execute(
                "INSERT INTO cred_store (user_id, content) VALUES (?, ?)",
                [uid, content],
            )
        else:
            aa.execute("INSERT INTO cred_store (id, content) VALUES (1, ?)", [content])
