"""Admin-only migration for the Turso control-plane schema."""

import base64
import binascii
import hashlib
import secrets
from dataclasses import dataclass

from .control_session import ControlFactories, ControlSession, decrypt_umk
from .creds import Creds
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .libsql_client import LibsqlClient
from .logger import Logger
from .turso_api import TursoClient

EMPTY_HANDLE_HASH = bytes(32)
ADD_HANDLE_HASH_SQL = (
    "ALTER TABLE users ADD COLUMN user_handle_hash BLOB NOT NULL "
    f"DEFAULT X'{EMPTY_HANDLE_HASH.hex()}' CHECK (length(user_handle_hash) = 32)"
)
CREATE_HANDLE_INDEX_SQL = (
    "CREATE UNIQUE INDEX IF NOT EXISTS users_user_handle_hash_unique "
    "ON users(user_handle_hash)"
)
PAYLOAD_FIELDS = ("display_name", "db_master_key", "db_path", "db_prefix")


@dataclass(frozen=True)
class AccountMigration:
    uid: str
    handle_hash: bytes
    self_content: bytes | None
    backup_content: bytes | None
    update_hash: bool

    @property
    def changed(self) -> bool:
        return (
            self.update_hash
            or self.self_content is not None
            or self.backup_content is not None
        )


class CtlUpdater:
    def __init__(self, creds: Creds, logger: Logger, *, dry_run: bool = False):
        self.creds, self.logger, self.dry_run = creds, logger, dry_run
        self.control = ControlSession(
            creds,
            logger,
            factories=ControlFactories(FirebaseAuth, TursoClient, LibsqlClient),
            engine=LeancryptoEngine(),
        )
        self.blob = self.control.blob

    def run(self) -> None:
        admin_uid, ctl, admin_umk = self.control.admin_context()
        has_column = self._has_handle_column(ctl)
        backups = self._admin_backups(ctl, admin_uid, admin_umk)
        migrations = [
            self._plan_account(ctl, admin_uid, admin_umk, backups, row)
            for row in self._user_rows(ctl, has_column)
        ]
        self._report(migrations, has_column)
        if not self.dry_run:
            self._apply(ctl, admin_uid, migrations, has_column)

    def _has_handle_column(self, ctl: LibsqlClient) -> bool:
        columns = {row[1] for row in ctl.query("PRAGMA table_info(users)")}
        return "user_handle_hash" in columns

    def _user_rows(self, ctl: LibsqlClient, has_column: bool) -> list:
        if has_column:
            return ctl.query("SELECT id, type, user_handle_hash FROM users")
        return [row + [None] for row in ctl.query("SELECT id, type FROM users")]

    def _admin_backups(self, ctl, admin_uid, admin_umk) -> dict[str, dict]:
        rows = ctl.query(
            "SELECT for_user_id, content FROM cred_store WHERE owner_id = ?",
            [admin_uid],
        )
        return {
            uid: self.blob.decrypt_json(content, admin_umk) for uid, content in rows
        }

    def _plan_account(self, ctl, admin_uid, admin_umk, backups, row):
        uid, account_type, stored_hash = row
        if account_type not in ("admin", "user"):
            raise ValueError(f"uid={uid} has invalid account type {account_type}")
        backup = None if uid == admin_uid else self._require_backup(backups, uid)
        root_key = (
            self.creds.user_root_key if backup is None else self._root_key(backup, uid)
        )
        umk, payload = self._self_payload(ctl, uid, root_key)
        if backup is not None:
            self._require_matching_backup(uid, payload, backup)
        handle = self._select_handle(uid, stored_hash, payload, backup)
        return self._migration(
            uid, stored_hash, handle, umk, admin_umk, payload, backup
        )

    def _require_backup(self, backups: dict[str, dict], uid: str) -> dict:
        if uid not in backups:
            raise ValueError(f"uid={uid} has no administrator cred_store backup")
        return backups[uid]

    def _root_key(self, backup: dict, uid: str) -> str:
        value = backup.get("user_root_key")
        if not isinstance(value, str) or not value:
            raise ValueError(
                f"uid={uid} backup has no user_root_key; re-run --init-user"
            )
        return value

    def _self_payload(self, ctl, uid: str, root_key: str) -> tuple[bytes, dict]:
        rows = ctl.query(
            "SELECT k.umk, c.content FROM key_store k JOIN cred_store c "
            "ON c.owner_id = k.user_id AND c.for_user_id = k.user_id "
            "WHERE k.user_id = ?",
            [uid],
        )
        if not rows:
            raise ValueError(f"uid={uid} has incomplete key_store/cred_store rows")
        wrapped_umk, content = rows[0]
        umk = decrypt_umk(wrapped_umk, root_key, self.blob, uid)
        return umk, self.blob.decrypt_json(content, umk)

    def _require_matching_backup(self, uid: str, payload: dict, backup: dict) -> None:
        if any(payload.get(field) != backup.get(field) for field in PAYLOAD_FIELDS):
            raise ValueError(
                f"uid={uid} administrator backup does not match self payload"
            )

    def _select_handle(self, uid, stored_hash, payload, backup) -> bytes:
        candidates = [self._payload_handle(uid, payload)]
        if backup is not None:
            candidates.append(self._payload_handle(uid, backup))
        handles = [value for value in candidates if value is not None]
        if handles and any(value != handles[0] for value in handles[1:]):
            raise ValueError(f"uid={uid} credential stores have different user handles")
        handle = handles[0] if handles else secrets.token_bytes(32)
        self._require_matching_hash(uid, stored_hash, handle)
        return handle

    def _payload_handle(self, uid: str, payload: dict) -> bytes | None:
        value = payload.get("user_handle")
        if value is None:
            return None
        try:
            handle = base64.b64decode(value, validate=True)
        except ValueError, binascii.Error:
            raise ValueError(f"uid={uid} has an invalid user_handle") from None
        if len(handle) != 32:
            raise ValueError(f"uid={uid} has an invalid user_handle")
        return handle

    def _require_matching_hash(self, uid, stored_hash, handle) -> None:
        if stored_hash in (None, EMPTY_HANDLE_HASH):
            return
        if not secrets.compare_digest(stored_hash, hashlib.sha256(handle).digest()):
            raise ValueError(f"uid={uid} user_handle_hash does not match credentials")

    def _migration(self, uid, stored_hash, handle, umk, admin_umk, payload, backup):
        encoded = base64.b64encode(handle).decode()
        self_content = self._updated_content(payload, encoded, umk)
        backup_content = self._updated_content(backup, encoded, admin_umk)
        return AccountMigration(
            uid,
            hashlib.sha256(handle).digest(),
            self_content,
            backup_content,
            stored_hash in (None, EMPTY_HANDLE_HASH),
        )

    def _updated_content(self, payload, encoded: str, key: bytes) -> bytes | None:
        if payload is None or payload.get("user_handle") == encoded:
            return None
        return self.blob.encrypt_json({**payload, "user_handle": encoded}, key)

    def _report(self, migrations: list[AccountMigration], has_column: bool) -> None:
        prefix = "Would migrate" if self.dry_run else "Migrating"
        changed = sum(migration.changed for migration in migrations)
        if not has_column:
            self.logger.info(f"{prefix} users.user_handle_hash schema.")
        self.logger.info(f"{prefix} {changed} of {len(migrations)} account(s).")
        for migration in migrations:
            state = "update required" if migration.changed else "already current"
            self.logger.verbose(f"[{migration.uid}] {state}.")

    def _apply(self, ctl, admin_uid, migrations, has_column: bool) -> None:
        if not has_column:
            ctl.execute(ADD_HANDLE_HASH_SQL)
        for migration in migrations:
            self._apply_account(ctl, admin_uid, migration)
        ctl.execute(CREATE_HANDLE_INDEX_SQL)
        self.logger.info("Control-plane migration complete.")

    def _apply_account(self, ctl, admin_uid, migration: AccountMigration) -> None:
        if migration.update_hash:
            ctl.execute(
                "UPDATE users SET user_handle_hash = ? WHERE id = ?",
                [migration.handle_hash, migration.uid],
            )
        if migration.self_content is not None:
            self._update_content(
                ctl, migration.uid, migration.uid, migration.self_content
            )
        if migration.backup_content is not None:
            self._update_content(
                ctl, admin_uid, migration.uid, migration.backup_content
            )

    def _update_content(self, ctl, owner_uid, user_uid, content) -> None:
        ctl.execute(
            "UPDATE cred_store SET content = ? WHERE owner_id = ? AND for_user_id = ?",
            [content, owner_uid, user_uid],
        )
