"""--init-user: the administrator registers an ordinary user's ctl.users
row -- the missing half of account provisioning docs/auth.md describes
(only --init-admin existed before this). Takes both the admin's own and
the target user's creds.json so it can sign in as each directly, rather
than requiring a manual Firebase-console uid lookup.
"""

import time

from .admin_init import CREATE_USERS_TABLE_SQL, INSERT_USER_SQL
from .creds import Creds
from .firebase_auth import FirebaseAuth
from .libsql_client import LibsqlClient
from .logger import Logger
from .random_token import generate_random_prefix
from .turso_api import TursoClient, extract_db_name


class UserInitializer:
    def __init__(self, admin_creds: Creds, user_creds: Creds, logger: Logger):
        self.admin_creds = admin_creds
        self.user_creds = user_creds
        self.logger = logger
        self.turso = TursoClient(admin_creds.turso_org_token, admin_creds.turso_org)

    def run(self) -> None:
        self.logger.verbose("Starting user registration...")
        admin_uid = self._sign_in(self.admin_creds)
        ctl = self._ensure_users_table()
        self._require_admin(ctl, admin_uid)
        uid = self._sign_in(self.user_creds)
        if self._exists(ctl, uid):
            self.logger.info(f"User {uid} already registered in ctl")
            return
        db_path = generate_random_prefix()
        self.logger.verbose(f"Generated db_path={db_path}")
        self._insert_user(ctl, uid, db_path)
        self.logger.verbose("User registration finished.")

    def _sign_in(self, creds: Creds) -> str:
        self.logger.verbose(f"Signing in to Firebase as {creds.firebase_email}...")
        auth = FirebaseAuth(creds.firebase_api_key)
        uid = auth.sign_in(creds.firebase_email, creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _ensure_users_table(self) -> LibsqlClient:
        db_name = extract_db_name(
            self.admin_creds.turso_ctl_db_url, self.admin_creds.turso_org
        )
        self.logger.verbose(f"Minting a database token for {db_name}...")
        ctl_token = self.turso.mint_db_token(db_name)
        ctl = LibsqlClient(self.admin_creds.turso_ctl_db_url, ctl_token)
        ctl.execute(CREATE_USERS_TABLE_SQL)
        self.logger.verbose("users table ready in ctl.")
        return ctl

    def _require_admin(self, ctl: LibsqlClient, admin_uid: str) -> None:
        rows = ctl.query("SELECT type FROM users WHERE id = ?", [admin_uid])
        if not rows or rows[0][0] != "admin":
            raise ValueError(
                "--admin-creds must be the administrator's own creds.json "
                "(run --init-admin first)"
            )

    def _exists(self, ctl: LibsqlClient, uid: str) -> bool:
        self.logger.verbose(f"Checking for an existing users row for uid={uid}...")
        return bool(ctl.query("SELECT id FROM users WHERE id = ?", [uid]))

    def _insert_user(self, ctl: LibsqlClient, uid: str, db_path: str) -> None:
        created_at = int(time.time() * 1000)
        self.logger.verbose(
            f"Inserting users row: id={uid}, db_path={db_path}, type=user..."
        )
        ctl.execute(INSERT_USER_SQL, [uid, db_path, "user", created_at])
        self.logger.verbose("users row inserted.")
        self.logger.info(
            f"Registered user {uid} with db_path={db_path} (database not yet created)"
        )
