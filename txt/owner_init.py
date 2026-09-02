import base64
import hashlib
import secrets
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .account_data import parse_owner_account
from .creds import OwnerCreds, ensure_user_root_key
from .crypto_blob import CryptoBlob
from .d1_client import D1Client, D1Error
from .leancrypto_wasm import KEM_PK_SIZE, KEM_SK_SIZE, LeancryptoEngine
from .logger import Logger
from .random_token import generate_random_prefix

SIGN_VERSION = 1
SIGN_ALGORITHM = "ECDSA-P521-SHA512"

# docs/data_model.md §2: the owner table's own columns, matching
# worker/migrations/0001_initial_schema.sql exactly.
OWNER_SQL = """
SELECT created_at, owner_email_hash, db_prefix_hash, user_handle_hash,
       wrapped_umk, kem_public_key, wrapped_kem_private_key,
       sign_version, sign_algorithm, sign_public_key,
       wrapped_sign_private_key, encrypted_credentials
FROM owner WHERE singleton = 1
"""

# `singleton`, `sign_version`, and `created_at` are inlined as literals
# (safe: always internally generated ints, never attacker-controlled) --
# D1's HTTP params array only accepts strings (txt/d1_client.py), and
# `created_at`/`sign_version` would need an untested string-to-integer
# coercion under this schema's STRICT tables to go through it instead.
INSERT_OWNER_SQL_TEMPLATE = """
INSERT INTO owner (
  singleton, created_at, owner_email_hash, db_prefix_hash, user_handle_hash,
  wrapped_umk, kem_public_key, wrapped_kem_private_key,
  sign_version, sign_algorithm, sign_public_key,
  wrapped_sign_private_key, encrypted_credentials
) VALUES (
  1, {created_at}, unhex(?), unhex(?), unhex(?),
  unhex(?), unhex(?), unhex(?),
  1, ?, unhex(?),
  unhex(?), unhex(?)
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
        d1: D1Client | None = None,
    ):
        self.creds = creds
        self.creds_path = creds_path
        self.logger = logger
        self._set_services(engine, d1)

    def _set_services(self, engine, d1) -> None:
        self.engine = engine or LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)
        self.d1 = d1 or self._new_d1()

    def _new_d1(self) -> D1Client:
        return D1Client(
            self.creds.cf_account_id,
            self.creds.cf_d1_database_id,
            self.creds.cf_d1_api_token,
        )

    def run(self) -> None:
        self.logger.verbose("Starting singleton owner bootstrap...")
        self.initialize()

    def initialize(self, payload: dict | None = None) -> dict:
        self.creds = ensure_user_root_key(self.creds_path, self.creds)
        existing = self.load_owner()
        if existing:
            self.validate_owner(existing)
            self.logger.info(f"Owner {self.creds.owner_email} is already ready in D1.")
            return existing
        owner = self._new_owner(payload)
        _insert_owner(self.d1, owner)
        self.logger.info(f"Owner {self.creds.owner_email} is ready in D1.")
        return owner

    def load_current_owner(self) -> tuple[bytes, dict]:
        row = self.load_owner()
        if not row:
            raise ValueError("owner is not provisioned in D1; run --init-owner first")
        return self.validate_owner(row)

    def load_owner(self) -> dict | None:
        try:
            return self.d1.query_one(OWNER_SQL)
        except D1Error as error:
            if "no such table" in str(error):
                raise ValueError(
                    "the owner table doesn't exist yet -- deploy the Worker "
                    "first so its D1 migrations run (docs/deployment.md)"
                ) from error
            raise

    def _new_owner(self, payload: dict | None) -> dict:
        root_key = _root_key(self.creds.user_root_key)
        umk = secrets.token_bytes(128)
        user_handle, payload = self._payload(payload)
        keys = self._new_keys()
        row = self._identity_fields(user_handle, payload)
        row.update(self._key_fields(root_key, umk, payload, keys))
        return row

    def _payload(self, payload: dict | None) -> tuple[bytes, dict]:
        if payload is None:
            handle = secrets.token_bytes(32)
            return handle, self._new_payload(handle)
        account = parse_owner_account(payload)
        return account.user_handle, payload

    def _new_keys(self) -> tuple[bytes, bytes, bytes, bytes]:
        kem_public, kem_private = self.engine.kem_keypair()
        sign_public, sign_private = _new_signing_key()
        return kem_public, kem_private, sign_public, sign_private

    def _identity_fields(self, user_handle: bytes, payload: dict) -> dict:
        account = parse_owner_account(payload)
        return {
            "created_at": int(time.time() * 1000),
            "owner_email_hash": _owner_email_hash(self.creds.owner_email),
            "db_prefix_hash": hashlib.sha256(account.db_prefix.encode()).digest(),
            "user_handle_hash": hashlib.sha256(user_handle).digest(),
        }

    def _key_fields(
        self, root_key: bytes, umk: bytes, payload: dict, keys: tuple
    ) -> dict:
        kem_public, kem_private, sign_public, sign_private = keys
        return {
            "wrapped_umk": self.blob.encrypt(umk, root_key),
            "kem_public_key": kem_public,
            "wrapped_kem_private_key": self.blob.encrypt(kem_private, umk),
            "sign_algorithm": SIGN_ALGORITHM,
            "sign_public_key": sign_public,
            "wrapped_sign_private_key": self.blob.encrypt(sign_private, umk),
            "encrypted_credentials": self.blob.encrypt_json(payload, umk),
        }

    def _new_payload(self, user_handle: bytes) -> dict:
        return {
            "user_handle": base64.b64encode(user_handle).decode(),
            "display_name": self.creds.display_name,
            "db_prefix": generate_random_prefix(),
        }

    def validate_owner(self, row: dict) -> tuple[bytes, dict]:
        root_key = _root_key(self.creds.user_root_key)
        umk = self.blob.decrypt(row["wrapped_umk"], root_key)
        payload = self.blob.decrypt_json(row["encrypted_credentials"], umk)
        self._validate_bindings(row, payload)
        self._validate_kem(row, umk)
        self._validate_signing(row, umk)
        return umk, payload

    def _validate_bindings(self, row: dict, payload: dict) -> None:
        account = parse_owner_account(payload)
        if not secrets.compare_digest(
            row["owner_email_hash"], _owner_email_hash(self.creds.owner_email)
        ):
            raise ValueError(f"owner email mismatch for {self.creds.owner_email}")
        if not secrets.compare_digest(
            row["user_handle_hash"], hashlib.sha256(account.user_handle).digest()
        ):
            raise ValueError("owner user handle mismatch")
        if not secrets.compare_digest(
            row["db_prefix_hash"], hashlib.sha256(account.db_prefix.encode()).digest()
        ):
            raise ValueError("owner db_prefix binding mismatch")

    def _validate_kem(self, row: dict, umk: bytes) -> None:
        private_key = self.blob.decrypt(row["wrapped_kem_private_key"], umk)
        if len(row["kem_public_key"]) != KEM_PK_SIZE or len(private_key) != KEM_SK_SIZE:
            raise ValueError("owner composite KEM key has an invalid size")

    def _validate_signing(self, row: dict, umk: bytes) -> None:
        if (row["sign_version"], row["sign_algorithm"]) != (
            SIGN_VERSION,
            SIGN_ALGORITHM,
        ):
            raise ValueError("unsupported request-signing suite")
        public = serialization.load_der_public_key(row["sign_public_key"])
        private_der = self.blob.decrypt(row["wrapped_sign_private_key"], umk)
        private = serialization.load_der_private_key(private_der, password=None)
        _require_matching_p521(public, private)


def _insert_owner(d1: D1Client, row: dict) -> None:
    sql = INSERT_OWNER_SQL_TEMPLATE.format(created_at=row["created_at"])
    d1.execute(sql, _insert_owner_params(row))


def _insert_owner_params(row: dict) -> list:
    return [
        row["owner_email_hash"],
        row["db_prefix_hash"],
        row["user_handle_hash"],
        row["wrapped_umk"],
        row["kem_public_key"],
        row["wrapped_kem_private_key"],
        row["sign_algorithm"],
        row["sign_public_key"],
        row["wrapped_sign_private_key"],
        row["encrypted_credentials"],
    ]


def _owner_email_hash(owner_email: str) -> bytes:
    return hashlib.sha256(owner_email.encode()).digest()


def _root_key(value: str) -> bytes:
    try:
        key = base64.b64decode(value, validate=True)
    except ValueError:
        raise ValueError("invalid user_root_key") from None
    if len(key) != 256:
        raise ValueError("invalid user_root_key")
    return key


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


def _require_matching_p521(public: object, private: object) -> None:
    if not isinstance(public, ec.EllipticCurvePublicKey) or not isinstance(
        public.curve, ec.SECP521R1
    ):
        raise ValueError("request-signing public key is not P-521")
    if not isinstance(private, ec.EllipticCurvePrivateKey) or not isinstance(
        private.curve, ec.SECP521R1
    ):
        raise ValueError("request-signing private key is not P-521")
    if public.public_numbers() != private.public_key().public_numbers():
        raise ValueError("request-signing keypair mismatch")
