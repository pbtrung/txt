import base64

import requests

from .creds import Creds
from .crypto_blob import CryptoBlob
from .firebase_auth import FirebaseAuth
from .libsql_client import LibsqlClient
from .logger import Logger
from .turso_api import TursoClient, extract_db_name


def build_aa_url(db_path: str, org: str) -> str:
    return f"libsql://{db_path}-{org}.aws-us-east-1.turso.io"


def cred_store_rows(aa: LibsqlClient, uid: str, account_type: str) -> list:
    if account_type == "admin":
        return aa.query("SELECT content FROM cred_store WHERE user_id = ?", [uid])
    return aa.query("SELECT content FROM cred_store WHERE id = 1")


class AccountSession:
    """Sign in, look up this account in ctl, and connect to its own AA --
    the bootstrap DbInitializer and TxtIngester both need before doing
    anything account-specific.
    """

    def __init__(self, creds: Creds, logger: Logger):
        self.creds = creds
        self.logger = logger
        self.turso = TursoClient(creds.turso_org_token, creds.turso_org)

    def connect(self) -> tuple[str, str, LibsqlClient]:
        uid = self._sign_in()
        db_path, account_type = self._lookup_user(uid)
        aa = self._connect_aa(db_path)
        return uid, account_type, aa

    def read_umk(self, aa: LibsqlClient, blob: CryptoBlob, ikm: bytes) -> bytes | None:
        rows = aa.query("SELECT umk FROM key_store WHERE id = 1")
        return blob.decrypt(rows[0][0], ikm) if rows else None

    def read_db_master_key(
        self,
        aa: LibsqlClient,
        uid: str,
        account_type: str,
        blob: CryptoBlob,
        umk: bytes,
    ) -> bytes | None:
        rows = cred_store_rows(aa, uid, account_type)
        if not rows:
            return None
        payload = blob.decrypt_json(rows[0][0], umk)
        return base64.b64decode(payload["db_master_key"])

    def _sign_in(self) -> str:
        self.logger.verbose(f"Signing in to Firebase as {self.creds.firebase_email}...")
        auth = FirebaseAuth(self.creds.firebase_api_key)
        uid = auth.sign_in(self.creds.firebase_email, self.creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _lookup_user(self, uid: str) -> tuple[str, str]:
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
        return rows[0][0], rows[0][1]

    def _connect_aa(self, db_path: str) -> LibsqlClient:
        token = self._mint_or_create(db_path)
        return LibsqlClient(build_aa_url(db_path, self.creds.turso_org), token)

    def _mint_or_create(self, db_path: str) -> str:
        self.logger.verbose(f"Minting a database token for {db_path}...")
        try:
            return self.turso.mint_db_token(db_path)
        except requests.exceptions.HTTPError as err:
            if err.response is None or err.response.status_code != 404:
                raise
            self.logger.verbose(
                f"Database {db_path} does not exist yet, creating it..."
            )
            self.turso.create_database(db_path, self.creds.turso_group)
            return self.turso.mint_db_token(db_path)
