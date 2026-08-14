import base64
import secrets
import time

from .account_session import AccountSession, cred_store_rows
from .creds import Creds, ensure_user_root_key
from .crypto_blob import CryptoBlob
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .random_token import generate_random_prefix

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
        bundle_key BLOB PRIMARY KEY, bundle_enc_key BLOB NOT NULL,
        built_at_version INTEGER NOT NULL, byte_size INTEGER NOT NULL,
        map_rows INTEGER NOT NULL, page_count INTEGER NOT NULL,
        built_at INTEGER NOT NULL, retired_at INTEGER)""",
    """CREATE TABLE IF NOT EXISTS library_index (
        id INTEGER PRIMARY KEY CHECK (id = 1), object_key BLOB NOT NULL,
        lib_idx_key BLOB NOT NULL, built_at_version INTEGER NOT NULL,
        byte_size INTEGER NOT NULL, doc_count INTEGER NOT NULL,
        content_hash BLOB NOT NULL, built_at INTEGER NOT NULL)""",
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
        self.session = AccountSession(creds, logger)
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)

    def run(self) -> None:
        uid, account_type, aa = self.session.connect()
        self._ensure_schema(aa, account_type)
        self.creds = ensure_user_root_key(self.creds_path, self.creds)
        ikm = base64.b64decode(self.creds.user_root_key)
        umk = self._ensure_umk(aa, account_type, ikm)
        db_prefix = self._ensure_meta(aa, umk)
        self._ensure_cred_store(aa, uid, account_type, umk)
        self.logger.info(
            f"Initialized database for {uid} (type={account_type}, db_prefix={db_prefix})"
        )

    def _ensure_schema(self, aa: LibsqlClient, account_type: str) -> None:
        self.logger.verbose("Ensuring AA schema exists...")
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
        umk = self.session.read_umk(aa, self.blob, ikm)
        if umk is not None:
            self.logger.verbose("key_store already initialized, unwrapping umk...")
            return umk
        return self._create_key_store(aa, ikm, account_type)

    def _create_key_store(self, aa: LibsqlClient, ikm: bytes, account_type: str) -> bytes:
        self.logger.verbose("Generating umk for key_store...")
        umk = secrets.token_bytes(128)
        wrapped_umk = self.blob.encrypt(umk, ikm)
        if account_type == "admin":
            self._insert_admin_key_store(aa, umk, wrapped_umk)
        else:
            aa.execute("INSERT INTO key_store (id, umk) VALUES (1, ?)", [wrapped_umk])
        self.logger.verbose("key_store initialized.")
        return umk

    def _insert_admin_key_store(self, aa: LibsqlClient, umk: bytes, wrapped_umk: bytes) -> None:
        self.logger.verbose("Generating composite KEM keypair for key_store...")
        pk, sk = self.engine.kem_keypair()
        wrapped_privkey = self.blob.encrypt(sk, umk)
        aa.execute(
            "INSERT INTO key_store (id, umk, pubkey, privkey) VALUES (1, ?, ?, ?)",
            [wrapped_umk, pk, wrapped_privkey],
        )

    def _ensure_cred_store(self, aa: LibsqlClient, uid: str, account_type: str, umk: bytes) -> None:
        if cred_store_rows(aa, uid, account_type):
            self.logger.verbose("cred_store already has a backup row for this account.")
            return
        self._insert_cred_store(aa, uid, account_type, umk)

    def _insert_cred_store(self, aa: LibsqlClient, uid: str, account_type: str, umk: bytes) -> None:
        db_master_key = base64.b64encode(secrets.token_bytes(256)).decode()
        payload = {"display_name": self.creds.display_name, "db_master_key": db_master_key}
        content = self.blob.encrypt_json(payload, umk)
        self._write_cred_store(aa, uid, account_type, content)
        self.logger.verbose("cred_store row inserted.")

    def _write_cred_store(self, aa: LibsqlClient, uid: str, account_type: str, content: bytes) -> None:
        if account_type == "admin":
            aa.execute("INSERT INTO cred_store (user_id, content) VALUES (?, ?)", [uid, content])
        else:
            aa.execute("INSERT INTO cred_store (id, content) VALUES (1, ?)", [content])
