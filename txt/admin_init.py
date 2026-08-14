import time

from .creds import Creds
from .firebase_auth import FirebaseAuth
from .libsql_client import LibsqlClient
from .logger import Logger
from .random_token import generate_db_path
from .turso_api import TursoClient

CREATE_USERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  db_path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('admin', 'user')),
  created_at INTEGER NOT NULL
)
"""

INSERT_USER_SQL = (
    "INSERT INTO users (id, db_path, type, created_at) VALUES (?, ?, ?, ?)"
)


class AdminInitializer:
    def __init__(self, creds: Creds, logger: Logger):
        self.creds = creds
        self.logger = logger
        self.turso = TursoClient(creds.turso_org_token, creds.turso_org)

    def run(self) -> None:
        self.logger.verbose("Starting admin provisioning...")
        uid = self._sign_in()
        ctl = self._ensure_users_table()
        existing_db_path = self._find_existing(ctl, uid)
        if existing_db_path:
            self.logger.info(f"Admin {uid} already provisioned with database {existing_db_path}")
            return
        db_path = generate_db_path()
        self.logger.verbose(f"Generated db_path={db_path}")
        self._create_database(db_path)
        self._insert_user(ctl, uid, db_path)
        self.logger.verbose("Admin provisioning finished.")

    def _find_existing(self, ctl: LibsqlClient, uid: str) -> str | None:
        self.logger.verbose(f"Checking for an existing users row for uid={uid}...")
        rows = ctl.query("SELECT db_path FROM users WHERE id = ?", [uid])
        return rows[0][0] if rows else None

    def _sign_in(self) -> str:
        self.logger.verbose(f"Signing in to Firebase as {self.creds.firebase_email}...")
        auth = FirebaseAuth(self.creds.firebase_api_key)
        uid = auth.sign_in(self.creds.firebase_email, self.creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _ensure_users_table(self) -> LibsqlClient:
        self.logger.verbose("Minting a database token for ctl...")
        ctl_token = self.turso.mint_db_token("ctl")
        self.logger.verbose("Minted ctl token, ensuring users table exists...")
        ctl = LibsqlClient(self.creds.turso_ctl_db_url, ctl_token)
        ctl.execute(CREATE_USERS_TABLE_SQL)
        self.logger.verbose("users table ready in ctl.")
        return ctl

    def _create_database(self, db_path: str) -> None:
        self.logger.verbose(
            f"Requesting Turso database creation: name={db_path}, group={self.creds.turso_group}..."
        )
        self.turso.create_database(db_path, self.creds.turso_group)
        self.logger.verbose(f"Database {db_path} created.")

    def _insert_user(self, ctl: LibsqlClient, uid: str, db_path: str) -> None:
        created_at = int(time.time() * 1000)
        self.logger.verbose(
            f"Inserting users row: id={uid}, db_path={db_path}, type=admin, created_at={created_at}..."
        )
        ctl.execute(INSERT_USER_SQL, [uid, db_path, "admin", created_at])
        self.logger.verbose("users row inserted.")
        self.logger.info(f"Provisioned admin {uid} with database {db_path}")
