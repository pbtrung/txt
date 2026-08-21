import base64
import hashlib
import secrets
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .account_data import parse_storage_account, storage_binding
from .creds import OwnerCreds, ensure_user_root_key
from .crypto_blob import CryptoBlob
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import KEM_PK_SIZE, KEM_SK_SIZE, LeancryptoEngine
from .logger import Logger
from .random_token import generate_random_prefix
from .rqlite_client import RqliteClient, RqliteError

SIGN_VERSION = 1
SIGN_ALGORITHM = "ECDSA-P521-SHA512"

OWNER_SQL = """
SELECT firebase_uid, created_at, user_handle_hash, db_binding_hash,
       wrapped_umk, kem_public_key, wrapped_kem_private_key,
       sign_version, sign_algorithm, sign_public_key,
       wrapped_sign_private_key, encrypted_credentials
FROM owner_control
WHERE singleton = 1
"""

INSERT_OWNER_SQL = """
INSERT INTO owner_control (
  singleton, firebase_uid, created_at, user_handle_hash, db_binding_hash,
  wrapped_umk, kem_public_key, wrapped_kem_private_key,
  sign_version, sign_algorithm, sign_public_key,
  wrapped_sign_private_key, encrypted_credentials
) VALUES (
  1, :firebase_uid, :created_at, :user_handle_hash, :db_binding_hash,
  :wrapped_umk, :kem_public_key, :wrapped_kem_private_key,
  :sign_version, :sign_algorithm, :sign_public_key,
  :wrapped_sign_private_key, :encrypted_credentials
)
"""


class OwnerInitializer:
    def __init__(
        self,
        creds: OwnerCreds,
        creds_path: str,
        logger: Logger,
        *,
        engine: LeancryptoEngine | None = None,
        auth_factory=FirebaseAuth,
        rqlite: RqliteClient | None = None,
    ):
        self.creds = creds
        self.creds_path = creds_path
        self.logger = logger
        self._set_services(engine, auth_factory, rqlite)

    def _set_services(self, engine, auth_factory, rqlite) -> None:
        self.engine = engine or LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)
        self.auth_factory = auth_factory
        self.rqlite = rqlite or self._new_rqlite()

    def _new_rqlite(self) -> RqliteClient:
        return RqliteClient(
            self.creds.rqlite_operator_url,
            self.creds.rqlite_admin_username,
            self.creds.rqlite_admin_password,
        )

    def run(self) -> None:
        self.logger.verbose("Starting singleton owner bootstrap...")
        self.creds = ensure_user_root_key(self.creds_path, self.creds)
        uid = self._sign_in()
        existing = self._load_owner()
        if existing:
            self._validate_owner(existing, uid)
            self.logger.info(f"Owner {uid} is already ready in rqlite.")
            return
        self.rqlite.execute(INSERT_OWNER_SQL, self._new_owner(uid))
        self.logger.info(f"Owner {uid} is ready in rqlite.")

    def _sign_in(self) -> str:
        self.logger.verbose(f"Signing in to Firebase as {self.creds.firebase_email}...")
        auth = self.auth_factory(self.creds.firebase_api_key)
        uid = auth.sign_in(self.creds.firebase_email, self.creds.firebase_password)
        self.logger.verbose(f"Firebase sign-in succeeded, uid={uid}")
        return uid

    def _load_owner(self) -> dict | None:
        try:
            return self.rqlite.query_one(OWNER_SQL)
        except RqliteError as error:
            if "no such table" in str(error):
                raise ValueError(
                    "rqlite control schema is missing; apply "
                    "docker/migrations/0001_control.sql first"
                ) from error
            raise

    def _new_owner(self, uid: str) -> dict:
        root_key = _root_key(self.creds.user_root_key, uid)
        user_handle = secrets.token_bytes(32)
        umk = secrets.token_bytes(128)
        payload = self._new_payload(user_handle)
        keys = self._new_keys()
        row = self._identity_fields(uid, user_handle, payload)
        row.update(self._key_fields(root_key, umk, payload, keys))
        return row

    def _new_keys(self) -> tuple[bytes, bytes, bytes, bytes]:
        kem_public, kem_private = self.engine.kem_keypair()
        sign_public, sign_private = _new_signing_key()
        return kem_public, kem_private, sign_public, sign_private

    def _identity_fields(self, uid, user_handle, payload) -> dict:
        return {
            "firebase_uid": uid,
            "created_at": int(time.time() * 1000),
            "user_handle_hash": hashlib.sha256(user_handle).digest(),
            "db_binding_hash": storage_binding(parse_storage_account(uid, payload)),
        }

    def _key_fields(self, root_key, umk, payload, keys) -> dict:
        kem_public, kem_private, sign_public, sign_private = keys
        return {
            "wrapped_umk": self.blob.encrypt(umk, root_key),
            "kem_public_key": kem_public,
            "wrapped_kem_private_key": self.blob.encrypt(kem_private, umk),
            "sign_version": SIGN_VERSION,
            "sign_algorithm": SIGN_ALGORITHM,
            "sign_public_key": sign_public,
            "wrapped_sign_private_key": self.blob.encrypt(sign_private, umk),
            "encrypted_credentials": self.blob.encrypt_json(payload, umk),
        }

    def _new_payload(self, user_handle: bytes) -> dict:
        return {
            "user_handle": base64.b64encode(user_handle).decode(),
            "display_name": self.creds.display_name,
            "db_master_key": base64.b64encode(secrets.token_bytes(256)).decode(),
            "db_path": generate_random_prefix(),
            "db_prefix": generate_random_prefix(),
        }

    def _validate_owner(self, row: dict, uid: str) -> None:
        if row.get("firebase_uid") != uid:
            raise ValueError("rqlite is already provisioned for another Firebase UID")
        root_key = _root_key(self.creds.user_root_key, uid)
        umk = self.blob.decrypt(row["wrapped_umk"], root_key)
        payload = self.blob.decrypt_json(row["encrypted_credentials"], umk)
        self._validate_bindings(row, uid, payload)
        self._validate_kem(row, umk)
        self._validate_signing(row, uid, umk)

    def _validate_bindings(self, row: dict, uid: str, payload: dict) -> None:
        account = parse_storage_account(uid, payload)
        handle = _decode_handle(payload.get("user_handle"), uid)
        if not secrets.compare_digest(
            row["user_handle_hash"], hashlib.sha256(handle).digest()
        ):
            raise ValueError(f"owner user handle mismatch for uid={uid}")
        if not secrets.compare_digest(row["db_binding_hash"], storage_binding(account)):
            raise ValueError(f"owner path binding mismatch for uid={uid}")

    def _validate_kem(self, row: dict, umk: bytes) -> None:
        private_key = self.blob.decrypt(row["wrapped_kem_private_key"], umk)
        if len(row["kem_public_key"]) != KEM_PK_SIZE or len(private_key) != KEM_SK_SIZE:
            raise ValueError("owner composite KEM key has an invalid size")

    def _validate_signing(self, row: dict, uid: str, umk: bytes) -> None:
        if (row["sign_version"], row["sign_algorithm"]) != (
            SIGN_VERSION,
            SIGN_ALGORITHM,
        ):
            raise ValueError(f"unsupported request-signing suite for uid={uid}")
        public = serialization.load_der_public_key(row["sign_public_key"])
        private_der = self.blob.decrypt(row["wrapped_sign_private_key"], umk)
        private = serialization.load_der_private_key(private_der, password=None)
        _require_matching_p521(public, private, uid)


def _root_key(value: str, uid: str) -> bytes:
    try:
        key = base64.b64decode(value, validate=True)
    except ValueError:
        raise ValueError(f"uid={uid} has an invalid user_root_key") from None
    if len(key) != 256:
        raise ValueError(f"uid={uid} has an invalid user_root_key")
    return key


def _decode_handle(value: object, uid: str) -> bytes:
    try:
        handle = base64.b64decode(value, validate=True)
    except TypeError, ValueError:
        raise ValueError(
            f"owner credentials have an invalid handle for uid={uid}"
        ) from None
    if len(handle) != 32:
        raise ValueError(f"owner credentials have an invalid handle for uid={uid}")
    return handle


def _new_signing_key() -> tuple[bytes, bytes]:
    private = ec.generate_private_key(ec.SECP521R1())
    public_der = private.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    private_der = private.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return public_der, private_der


def _require_matching_p521(public: object, private: object, uid: str) -> None:
    if not isinstance(public, ec.EllipticCurvePublicKey) or not isinstance(
        public.curve, ec.SECP521R1
    ):
        raise ValueError(f"request-signing public key is not P-521 for uid={uid}")
    if not isinstance(private, ec.EllipticCurvePrivateKey) or not isinstance(
        private.curve, ec.SECP521R1
    ):
        raise ValueError(f"request-signing private key is not P-521 for uid={uid}")
    if public.public_numbers() != private.public_key().public_numbers():
        raise ValueError(f"request-signing keypair mismatch for uid={uid}")
