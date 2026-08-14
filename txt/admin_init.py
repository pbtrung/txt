import time

from .creds import Creds
from .firebase_auth import FirebaseAuth
from .libsql_client import LibsqlClient
from .logger import Logger
from .random_token import generate_random_prefix
from .turso_api import TursoClient, extract_db_name

CREATE_USERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  db_path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('admin', 'user')),
  created_at INTEGER NOT NULL
)
"""

INSERT_USER_SQL = "INSERT INTO users (id, db_path, type, created_at) VALUES (?, ?, ?, ?)"


class AdminInitializer:
    def __init__(self, creds: Creds, logger: Logger):
        self.creds = creds
        self.logger = logger
        self.turso = TursoClient(creds.turso_org_token, creds.turso_org)

    def run(self) -> None:
        self.logger.verbose("Starting admin registration...")
        uid = self._sign_in()
        ctl = self._ensure_users_table()
        if self._exists(ctl, uid):
            self.logger.info(f"Admin {uid} already registered in ctl")
            return
        db_path = generate_random_prefix()
        self.logger.verbose(f"Generated db_path={db_path}")
        self._insert_user(ctl, uid, db_path)
        self.logger.verbose("Admin registration finished.")

    def _exists(self, ctl: LibsqlClient, uid: str) -> bool:
        self.logger.verbose(f"Checking for an existing users row for uid={uid}...")
        return bool(ctl.query("SELECT id FROM users WHERE id = ?", [uid]))

    def _sign_in(self) -> str:
        self.logger.verbose(f"Signing in to Firebase as {self.creds.firebase_email}...")
        auth = FirebaseAuth(self.creds.firebase_api_key)
        uid = auth.sign_in(self.creds.firebase_email, self.creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _ensure_users_table(self) -> LibsqlClient:
        db_name = extract_db_name(self.creds.turso_ctl_db_url, self.creds.turso_org)
        self.logger.verbose(f"Minting a database token for {db_name}...")
        ctl_token = self.turso.mint_db_token(db_name)
        self.logger.verbose(f"Minted {db_name} token, ensuring users table exists...")
        ctl = LibsqlClient(self.creds.turso_ctl_db_url, ctl_token)
        ctl.execute(CREATE_USERS_TABLE_SQL)
        self.logger.verbose("users table ready in ctl.")
        return ctl

    def _insert_user(self, ctl: LibsqlClient, uid: str, db_path: str) -> None:
        created_at = int(time.time() * 1000)
        self.logger.verbose(f"Inserting users row: id={uid}, db_path={db_path}, type=admin...")
        ctl.execute(INSERT_USER_SQL, [uid, db_path, "admin", created_at])
        self.logger.verbose("users row inserted.")
        self.logger.info(f"Registered admin {uid} with db_path={db_path} (database not yet created)")
