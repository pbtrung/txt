import base64
from dataclasses import dataclass

from .creds import Creds
from .crypto_blob import CryptoBlob
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .turso_api import TursoClient, extract_account_name

# docs/auth.md §2's own ctl join, minus the admin-only pubkey/privkey columns
# this caller never needs.
CTL_LOOKUP_SQL = (
    "SELECT u.type, k.umk, c.content FROM users u "
    "JOIN key_store k ON k.user_id = u.id "
    "JOIN cred_store c ON c.owner_id = u.id AND c.for_user_id = u.id "
    "WHERE u.id = ?"
)


@dataclass
class Account:
    uid: str
    account_type: str
    display_name: str
    db_master_key: bytes
    db_path: str
    db_prefix: str


class AccountSession:
    """Sign in, look up this account's row in ctl, and decrypt its own
    key material -- the db_path/db_prefix/db_master_key --ingest needs
    before it can touch either R2 or the local database.
    """

    def __init__(self, creds: Creds, logger: Logger):
        self.creds = creds
        self.logger = logger
        account_name = extract_account_name(
            creds.turso_ctl_db_url, creds.turso_ctl_db_name
        )
        self.turso = TursoClient(creds.turso_org_token, account_name)
        self.engine = LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)

    def connect(self) -> Account:
        uid = self._sign_in()
        ctl = self._connect_ctl()
        account_type, wrapped_umk, wrapped_content = self._lookup(ctl, uid)
        ikm = base64.b64decode(self.creds.user_root_key)
        umk = self.blob.decrypt(wrapped_umk, ikm)
        payload = self.blob.decrypt_json(wrapped_content, umk)
        return Account(
            uid=uid,
            account_type=account_type,
            display_name=payload["display_name"],
            db_master_key=base64.b64decode(payload["db_master_key"]),
            db_path=payload["db_path"],
            db_prefix=payload["db_prefix"],
        )

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

    def _lookup(self, ctl: LibsqlClient, uid: str) -> tuple[str, bytes, bytes]:
        rows = ctl.query(CTL_LOOKUP_SQL, [uid])
        if not rows:
            raise ValueError(
                f"uid={uid} has no users row in ctl; run --init-admin/--init-user first"
            )
        account_type, wrapped_umk, wrapped_content = rows[0]
        self.logger.verbose(f"Found ctl row for {uid} (type={account_type}).")
        return account_type, wrapped_umk, wrapped_content
