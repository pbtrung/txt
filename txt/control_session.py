import base64
import binascii
from dataclasses import dataclass

from .account_data import StorageAccount, parse_storage_account
from .creds import Creds, UserCreds
from .crypto_blob import CryptoBlob
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .turso_api import TursoClient, extract_account_name


@dataclass(frozen=True)
class ControlFactories:
    auth: object = FirebaseAuth
    turso: object = TursoClient
    ctl: object = LibsqlClient


DEFAULT_CONTROL_FACTORIES = ControlFactories()


class ControlSession:
    def __init__(
        self,
        creds: Creds,
        logger: Logger,
        *,
        factories: ControlFactories = DEFAULT_CONTROL_FACTORIES,
        engine=None,
    ):
        self.creds, self.logger = creds, logger
        self.auth_factory, self.ctl_factory = factories.auth, factories.ctl
        self.engine = engine or LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)
        account = extract_account_name(creds.turso_ctl_db_url, creds.turso_ctl_db_name)
        self.turso = factories.turso(creds.turso_org_token, account)

    def sign_in(self, creds: Creds | UserCreds | None = None) -> str:
        target = creds or self.creds
        self.logger.verbose(f"Signing in to Firebase as {target.firebase_email}...")
        auth = self.auth_factory(target.firebase_api_key)
        uid = auth.sign_in(target.firebase_email, target.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def connect(self) -> LibsqlClient:
        name = self.creds.turso_ctl_db_name
        self.logger.verbose(f"Minting a database token for {name}...")
        token = self.turso.mint_db_token(name)
        return self.ctl_factory(self.creds.turso_ctl_db_url, token)

    def admin_context(self) -> tuple[str, LibsqlClient, bytes]:
        uid = self.sign_in()
        ctl = self.connect()
        return uid, ctl, unwrap_umk(ctl, uid, self.creds.user_root_key, self.blob)

    def reachable_accounts(
        self, ctl: LibsqlClient, owner_uid: str, owner_umk: bytes, *, complete=False
    ) -> list[StorageAccount]:
        return load_reachable_accounts(
            ctl, owner_uid, owner_umk, self.blob, require_all=complete
        )


def unwrap_umk(ctl: LibsqlClient, uid: str, root_key: str, blob: CryptoBlob) -> bytes:
    rows = ctl.query("SELECT umk FROM key_store WHERE user_id = ?", [uid])
    if not rows:
        raise ValueError(f"uid={uid} has no key_store row")
    return decrypt_umk(rows[0][0], root_key, blob, uid)


def decrypt_umk(wrapped: bytes, root_key: str, blob: CryptoBlob, uid: str) -> bytes:
    try:
        key = base64.b64decode(root_key, validate=True)
    except ValueError, binascii.Error:
        raise ValueError(f"uid={uid} has an invalid user_root_key") from None
    if len(key) != 256:
        raise ValueError(f"uid={uid} has an invalid user_root_key")
    return blob.decrypt(wrapped, key)


def load_reachable_accounts(
    ctl: LibsqlClient,
    owner_uid: str,
    owner_umk: bytes,
    blob: CryptoBlob,
    *,
    require_all: bool = False,
) -> list[StorageAccount]:
    rows = _reachable_rows(ctl, owner_uid)
    if require_all:
        _require_all_backups(ctl, rows)
    return [
        parse_storage_account(uid, blob.decrypt_json(content, owner_umk))
        for uid, content in rows
    ]


def _reachable_rows(ctl: LibsqlClient, owner_uid: str) -> list:
    return ctl.query(
        "SELECT for_user_id, content FROM cred_store WHERE owner_id = ?", [owner_uid]
    )


def _require_all_backups(ctl: LibsqlClient, rows: list) -> None:
    user_ids = {row[0] for row in ctl.query("SELECT id FROM users")}
    missing = sorted(user_ids - {row[0] for row in rows})
    if missing:
        raise ValueError("No admin cred_store backup for uid(s): " + ", ".join(missing))
