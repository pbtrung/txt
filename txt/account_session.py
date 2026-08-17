from dataclasses import dataclass

from .account_data import StorageAccount, parse_storage_account
from .control_session import ControlFactories, ControlSession, decrypt_umk
from .creds import Creds
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .turso_api import TursoClient

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

    @classmethod
    def from_storage(
        cls, storage: StorageAccount, account_type: str, display_name: str
    ) -> Account:
        return cls(
            uid=storage.uid,
            account_type=account_type,
            display_name=display_name,
            db_master_key=storage.db_master_key,
            db_path=storage.db_path,
            db_prefix=storage.db_prefix,
        )


class AccountSession:
    """Sign in, look up this account's row in ctl, and decrypt its own
    key material -- the db_path/db_prefix/db_master_key --ingest needs
    before it can touch either R2 or the local database.
    """

    def __init__(self, creds: Creds, logger: Logger):
        self.creds = creds
        self.logger = logger
        self.control = ControlSession(
            creds,
            logger,
            factories=ControlFactories(FirebaseAuth, TursoClient, LibsqlClient),
            engine=LeancryptoEngine(),
        )
        self.blob = self.control.blob

    def connect(self) -> Account:
        uid = self.control.sign_in()
        ctl = self.control.connect()
        account_type, wrapped_umk, wrapped_content = self._lookup(ctl, uid)
        umk = decrypt_umk(wrapped_umk, self.creds.user_root_key, self.blob, uid)
        payload = self.blob.decrypt_json(wrapped_content, umk)
        storage = parse_storage_account(uid, payload)
        return Account.from_storage(storage, account_type, payload["display_name"])

    def _lookup(self, ctl: LibsqlClient, uid: str) -> tuple[str, bytes, bytes]:
        rows = ctl.query(CTL_LOOKUP_SQL, [uid])
        if not rows:
            raise ValueError(
                f"uid={uid} has no users row in ctl; run --init-admin/--init-user first"
            )
        account_type, wrapped_umk, wrapped_content = rows[0]
        self.logger.verbose(f"Found ctl row for {uid} (type={account_type}).")
        return account_type, wrapped_umk, wrapped_content
