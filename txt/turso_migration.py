import hashlib
import secrets

from .account_data import parse_storage_account, storage_binding
from .control_session import (
    DEFAULT_CONTROL_FACTORIES,
    ControlFactories,
    ControlSession,
    decode_user_root_key,
    decrypt_umk,
)
from .creds import Creds, OwnerCreds
from .leancrypto_wasm import LeancryptoEngine
from .logger import Logger
from .owner_init import OwnerInitializer, decode_user_handle

SOURCE_OWNER_SQL = """
SELECT u.user_handle_hash, u.db_binding_hash, k.umk, c.content
FROM users u
JOIN key_store k ON k.user_id = u.id
JOIN cred_store c ON c.owner_id = u.id AND c.for_user_id = u.id
WHERE u.id = ? AND u.type = 'admin'
"""

UPDATE_OWNER_SQL = """
UPDATE owner_control
SET user_handle_hash = :user_handle_hash,
    db_binding_hash = :db_binding_hash,
    encrypted_credentials = :encrypted_credentials
WHERE singleton = 1 AND firebase_uid = :firebase_uid
"""


class TursoOwnerReader:
    def __init__(
        self,
        creds: Creds,
        logger: Logger,
        *,
        engine: LeancryptoEngine | None = None,
        factories: ControlFactories = DEFAULT_CONTROL_FACTORIES,
    ):
        self.creds = creds
        self.control = ControlSession(
            creds, logger, factories=factories, engine=engine or LeancryptoEngine()
        )

    def read(self) -> tuple[str, dict]:
        uid = self.control.sign_in()
        rows = self.control.connect().query(SOURCE_OWNER_SQL, [uid])
        if len(rows) != 1:
            raise ValueError(f"uid={uid} has no unique Turso administrator record")
        return uid, self._payload(uid, rows[0])

    def _payload(self, uid: str, row: list) -> dict:
        handle_hash, binding_hash, wrapped_umk, content = row
        blob = self.control.blob
        umk = decrypt_umk(wrapped_umk, self.creds.user_root_key, blob, uid)
        payload = blob.decrypt_json(content, umk)
        _validate_source_payload(uid, payload, handle_hash, binding_hash)
        return payload


class OwnerMigrator:
    def __init__(
        self,
        turso_creds: Creds,
        owner_creds: OwnerCreds,
        owner_creds_path: str,
        logger: Logger,
        dry_run: bool,
        *,
        engine: LeancryptoEngine | None = None,
        source: TursoOwnerReader | None = None,
        initializer: OwnerInitializer | None = None,
    ):
        self.owner_creds = owner_creds
        self.logger, self.dry_run = logger, dry_run
        self._set_services(turso_creds, owner_creds_path, engine, source, initializer)

    def _set_services(self, turso_creds, path, engine, source, initializer) -> None:
        engine = engine or LeancryptoEngine()
        self.source = source or TursoOwnerReader(
            turso_creds, self.logger, engine=engine
        )
        self.initializer = initializer or OwnerInitializer(
            self.owner_creds, path, self.logger, engine=engine
        )
        self.blob = self.initializer.blob

    def run(self) -> None:
        self.logger.verbose("Reading and validating the Turso owner record...")
        source_uid, payload = self.source.read()
        owner_uid = self.initializer.sign_in()
        _require_matching_uid(source_uid, owner_uid)
        owner = self.initializer.load_owner()
        if owner:
            self.initializer.validate_owner(owner, owner_uid)
        if self.dry_run:
            self._report_dry_run(owner, owner_uid, payload)
        elif owner:
            self._update_owner(owner, owner_uid, payload)
        else:
            self._initialize_owner(owner_uid, payload)

    def _initialize_owner(self, uid: str, payload: dict) -> None:
        self.initializer.initialize(uid, payload)
        self.logger.info(f"Owner {uid} migrated from Turso to rqlite.")

    def _report_dry_run(self, owner: dict | None, uid: str, payload: dict) -> None:
        if owner is None:
            message = "would initialize the rqlite owner and import Turso credentials"
        elif self._current_payload(owner, uid)[1] == payload:
            message = "rqlite owner credentials already match Turso"
        else:
            message = "would import Turso credentials into the existing rqlite owner"
        self.logger.info(f"Dry run: {message}.")

    def _update_owner(self, owner: dict, uid: str, payload: dict) -> None:
        umk, current = self._current_payload(owner, uid)
        if current == payload:
            self.logger.info(f"Owner {uid} is already migrated to rqlite.")
            return
        fields = _migration_fields(uid, payload, umk, self.blob)
        self.initializer.rqlite.execute(UPDATE_OWNER_SQL, fields)
        self.logger.info(f"Owner {uid} migrated from Turso to rqlite.")

    def _current_payload(self, owner: dict, uid: str) -> tuple[bytes, dict]:
        root_key = decode_user_root_key(self.owner_creds.user_root_key, uid)
        umk = self.blob.decrypt(owner["wrapped_umk"], root_key)
        return umk, self.blob.decrypt_json(owner["encrypted_credentials"], umk)


def _validate_source_payload(
    uid: str, payload: dict, handle_hash: bytes, binding_hash: bytes
) -> None:
    handle = decode_user_handle(payload.get("user_handle"), uid)
    account = parse_storage_account(uid, payload)
    if not secrets.compare_digest(hashlib.sha256(handle).digest(), handle_hash):
        raise ValueError(f"Turso user handle mismatch for uid={uid}")
    if not secrets.compare_digest(storage_binding(account), binding_hash):
        raise ValueError(f"Turso path binding mismatch for uid={uid}")


def _migration_fields(uid: str, payload: dict, umk: bytes, blob) -> dict:
    handle = decode_user_handle(payload.get("user_handle"), uid)
    account = parse_storage_account(uid, payload)
    return {
        "firebase_uid": uid,
        "user_handle_hash": hashlib.sha256(handle).digest(),
        "db_binding_hash": storage_binding(account),
        "encrypted_credentials": blob.encrypt_json(payload, umk),
    }


def _require_matching_uid(source_uid: str, owner_uid: str) -> None:
    if source_uid != owner_uid:
        raise ValueError(
            f"Firebase UID mismatch: Turso has {source_uid}, rqlite has {owner_uid}"
        )
