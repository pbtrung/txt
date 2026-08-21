import base64
import binascii
from dataclasses import dataclass

from .creds import Creds
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

    def sign_in(self, creds: Creds | None = None) -> str:
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


def decrypt_umk(wrapped: bytes, root_key: str, blob: CryptoBlob, uid: str) -> bytes:
    return blob.decrypt(wrapped, decode_user_root_key(root_key, uid))


def decode_user_root_key(root_key: str, uid: str) -> bytes:
    try:
        key = base64.b64decode(root_key, validate=True)
    except ValueError, binascii.Error:
        raise ValueError(f"uid={uid} has an invalid user_root_key") from None
    if len(key) != 256:
        raise ValueError(f"uid={uid} has an invalid user_root_key")
    return key
