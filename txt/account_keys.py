import secrets
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .crypto_blob import CryptoBlob
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger

SIGN_VERSION = 1
SIGN_ALGORITHM = "ECDSA-P521-SHA512"


@dataclass(frozen=True)
class SigningMaterial:
    public_der: bytes
    wrapped_private_der: bytes


class SigningKeyManager:
    def __init__(self, blob: CryptoBlob, logger: Logger):
        self.blob, self.logger = blob, logger

    def create(self, umk: bytes) -> SigningMaterial:
        self.logger.verbose("Generating P-521 request-signing keypair...")
        private_key = ec.generate_private_key(ec.SECP521R1())
        return SigningMaterial(
            _public_der(private_key),
            self.blob.encrypt(_private_der(private_key), umk),
        )

    def ensure(self, ctl: LibsqlClient, uid: str, umk: bytes, fields: list) -> None:
        if all(value is None for value in fields):
            self._install(ctl, uid, self.create(umk))
            return
        if any(value is None for value in fields):
            raise ValueError(f"incomplete request-signing key for uid={uid}")
        self._validate(uid, umk, fields)

    def _install(self, ctl: LibsqlClient, uid: str, material: SigningMaterial) -> None:
        ctl.execute(
            "UPDATE key_store SET sign_version = ?, sign_algorithm = ?, "
            "sign_pubkey = ?, sign_privkey = ? WHERE user_id = ?",
            _signing_values(material) + [uid],
        )
        self.logger.verbose("Added request-signing keypair to key_store.")

    def _validate(self, uid: str, umk: bytes, fields: list) -> None:
        version, algorithm, public_der, wrapped_private_der = fields
        if (version, algorithm) != (SIGN_VERSION, SIGN_ALGORITHM):
            raise ValueError(f"unsupported request-signing suite for uid={uid}")
        public_key, private_key = self._load_keys(
            uid, umk, public_der, wrapped_private_der
        )
        _require_p521(public_key, "public", uid)
        _require_p521(private_key, "private", uid)
        if public_key.public_numbers() != private_key.public_key().public_numbers():
            raise ValueError(f"request-signing keypair mismatch for uid={uid}")

    def _load_keys(self, uid, umk, public_der, wrapped_private_der) -> tuple:
        try:
            public_key = serialization.load_der_public_key(public_der)
            private_der = self.blob.decrypt(wrapped_private_der, umk)
            private_key = serialization.load_der_private_key(private_der, password=None)
            return public_key, private_key
        except (TypeError, ValueError) as error:
            raise ValueError(f"invalid request-signing key for uid={uid}") from error


class AccountKeyStore:
    def __init__(
        self,
        engine: LeancryptoEngine,
        blob: CryptoBlob,
        logger: Logger,
        account_type: str,
    ):
        self.engine, self.blob, self.logger = engine, blob, logger
        self.account_type = account_type
        self.signing = SigningKeyManager(blob, logger)

    def ensure(self, ctl: LibsqlClient, uid: str, ikm: bytes) -> bytes:
        rows = _key_store_rows(ctl, uid)
        if not rows:
            return self._insert(ctl, uid, ikm)
        self.logger.verbose("key_store row already exists, unwrapping umk...")
        umk = self.blob.decrypt(rows[0][0], ikm)
        self.signing.ensure(ctl, uid, umk, rows[0][1:])
        return umk

    def _insert(self, ctl: LibsqlClient, uid: str, ikm: bytes) -> bytes:
        self.logger.verbose("Generating umk...")
        umk = secrets.token_bytes(128)
        wrapped_umk = self.blob.encrypt(umk, ikm)
        signing = self.signing.create(umk)
        if self.account_type == "admin":
            self._insert_admin(ctl, uid, umk, wrapped_umk, signing)
        else:
            self._insert_user(ctl, uid, wrapped_umk, signing)
        self.logger.verbose("key_store row inserted.")
        return umk

    def _insert_user(
        self, ctl: LibsqlClient, uid: str, wrapped_umk: bytes, signing: SigningMaterial
    ) -> None:
        ctl.execute(
            "INSERT INTO key_store "
            "(user_id, umk, sign_version, sign_algorithm, sign_pubkey, sign_privkey) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [uid, wrapped_umk, *_signing_values(signing)],
        )

    def _insert_admin(
        self,
        ctl: LibsqlClient,
        uid: str,
        umk: bytes,
        wrapped_umk: bytes,
        signing: SigningMaterial,
    ) -> None:
        self.logger.verbose("Generating composite KEM keypair...")
        public_key, private_key = self.engine.kem_keypair()
        wrapped_private = self.blob.encrypt(private_key, umk)
        self._execute_admin_insert(
            ctl, uid, wrapped_umk, public_key, wrapped_private, signing
        )

    def _execute_admin_insert(
        self, ctl, uid, wrapped_umk, public_key, wrapped_private, signing
    ) -> None:
        ctl.execute(
            "INSERT INTO key_store (user_id, umk, pubkey, privkey, sign_version, "
            "sign_algorithm, sign_pubkey, sign_privkey) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [uid, wrapped_umk, public_key, wrapped_private, *_signing_values(signing)],
        )


def _key_store_rows(ctl: LibsqlClient, uid: str) -> list:
    return ctl.query(
        "SELECT umk, sign_version, sign_algorithm, sign_pubkey, sign_privkey "
        "FROM key_store WHERE user_id = ?",
        [uid],
    )


def _signing_values(material: SigningMaterial) -> list:
    return [
        SIGN_VERSION,
        SIGN_ALGORITHM,
        material.public_der,
        material.wrapped_private_der,
    ]


def _public_der(private_key: ec.EllipticCurvePrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def _private_der(private_key: ec.EllipticCurvePrivateKey) -> bytes:
    return private_key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def _require_p521(key: object, label: str, uid: str) -> None:
    key_type = (
        ec.EllipticCurvePublicKey if label == "public" else ec.EllipticCurvePrivateKey
    )
    if not isinstance(key, key_type) or not isinstance(key.curve, ec.SECP521R1):
        raise ValueError(f"request-signing {label} key is not P-521 for uid={uid}")
