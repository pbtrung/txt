"""--migrate-rql: imports one owner's predecessor-design library (an
rqlite-hosted owner_control row plus a whole R2-hosted SQLCipher
database, docs and code on the `master` branch) into the current D1
design's owner. Every EPUB, its reading state, and its bookmarks are
re-encrypted under the D1 owner's own keys; the rqlite/SQLCipher source
is only ever read, never written.

--local-db-dir holds two things: a local copy of the downloaded rqlite
SQLCipher database (re-downloaded and overwritten every run, purely for
inspection -- it is never read back or uploaded), and the recovery
checkpoint itself, `{new_db_prefix}.migrate-checkpoint.json`, recording
per old `txt.id`, `{document_id, bookmarks_done}`. A row is only ever
migrated once: a run interrupted between the document insert and its
bookmarks resumes by finishing that row's bookmarks without
re-uploading or re-inserting the document, and a row already fully done
is skipped entirely except for a cheap catalog reconciliation (the same
resilience --ingest's checkpoint gives, so a lost or stale D1 catalog
entry still gets fixed on retry). `--limit` bounds how many
not-yet-migrated rows a single run newly imports, in ascending old
`txt.id` order -- rows already checkpointed are always reconciled
regardless of the limit.

Not migrated by this command: `txt_shares` (active public shares). That
is a materially different problem -- an existing share URL's capability
and content key must keep working, which means copying the exact shared
R2 object to its new single-segment path unchanged, not re-encrypting
it -- and was scoped out of this pass.
"""

import base64
import json
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import brotli

from .account_data import parse_owner_account
from .catalog_writer import CatalogWriter, DocumentStore
from .creds import OwnerCreds, R2Config
from .crypto_blob import CryptoBlob
from .d1_client import D1Client
from .database_schema import open_database
from .firebase_auth import FirebaseAuth
from .leancrypto_wasm import LeancryptoEngine
from .logger import Logger
from .owner_init import OwnerInitializer
from .r2_client import R2Client
from .random_token import to_base32_crockford
from .rqlite_client import RqliteClient
from .sqlite_engine import SqliteEngine

RQL_REQUIRED_FIELDS = [
    "rqlite_admin_username",
    "rqlite_admin_password",
    "rqlite_operator_url",
    "firebase_email",
    "firebase_password",
    "firebase_api_key",
    "user_root_key",
    "r2_config",
]

OWNER_CONTROL_SQL = (
    "SELECT firebase_uid, wrapped_umk, encrypted_credentials "
    "FROM owner_control WHERE singleton = 1"
)
TXT_ROWS_SQL = (
    "SELECT id, txt_key, txt_prefix, path, catalog, last_accessed, last_cfi "
    "FROM txt ORDER BY id"
)
BOOKMARK_ROWS_SQL = (
    "SELECT cfi, page_number, preview, created_at FROM txt_bookmarks "
    "WHERE txt_id = ? ORDER BY id"
)


@dataclass
class RqlOwnerCreds:
    rqlite_admin_username: str
    rqlite_admin_password: str
    rqlite_operator_url: str
    firebase_email: str
    firebase_password: str
    firebase_api_key: str
    user_root_key: str
    r2_config: R2Config


@dataclass(frozen=True)
class RqlOwnerAccount:
    db_master_key: bytes
    db_path: str
    db_prefix: str


def load_rql_creds(path: str) -> RqlOwnerCreds:
    data = _read_json(path)
    missing = [key for key in RQL_REQUIRED_FIELDS if key not in data]
    if missing:
        raise ValueError(f"Missing fields in {path}: {', '.join(missing)}")
    values = {key: data[key] for key in RQL_REQUIRED_FIELDS if key != "r2_config"}
    values["rqlite_operator_url"] = _operator_url(values["rqlite_operator_url"])
    return RqlOwnerCreds(**values, r2_config=_require_r2_config(data["r2_config"]))


def _require_r2_config(value: object) -> R2Config:
    if not isinstance(value, dict):
        raise ValueError("r2_config must be an object")
    missing = [name for name in R2Config.__annotations__ if name not in value]
    if missing:
        raise ValueError(f"Missing r2_config fields: {', '.join(missing)}")
    return R2Config(**{name: value[name] for name in R2Config.__annotations__})


def _operator_url(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("rqlite_operator_url must be a valid operator URL")
    parsed = urlsplit(value)
    _require_operator_location(parsed)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("rqlite_operator_url must not contain embedded credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("rqlite_operator_url must not contain a query or fragment")
    return value


def _require_operator_location(parsed) -> None:
    local = parsed.hostname in {"127.0.0.1", "localhost"}
    secure = parsed.scheme == "https" or (local and parsed.scheme == "http")
    valid_path = parsed.path.rstrip("/") == "/operator/rqlite"
    if not (secure and parsed.netloc and valid_path):
        raise ValueError(
            "rqlite_operator_url must use HTTPS and end with /operator/rqlite; "
            "localhost HTTP is allowed for development"
        )


def _read_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


@dataclass
class RqlMigratorDeps:
    """Injectable collaborators, for tests -- every field defaults to a
    real implementation built from creds when left as None. `auth_factory`
    mirrors owner_init.py (master branch)'s own test seam: a callable
    taking the Firebase API key and returning an object with `.sign_in`."""

    engine: LeancryptoEngine | None = None
    rqlite: RqliteClient | None = None
    auth_factory: Callable[[str], object] = FirebaseAuth
    d1: D1Client | None = None
    r2_old: R2Client | None = None
    r2_new: R2Client | None = None


class RqlMigrator:
    def __init__(
        self,
        rql_creds: RqlOwnerCreds,
        cf_creds: OwnerCreds,
        cf_creds_path: str,
        local_db_dir: Path,
        logger: Logger,
        *,
        limit: int | None = None,
        deps: RqlMigratorDeps | None = None,
    ):
        self.rql_creds, self.local_db_dir, self.logger = rql_creds, local_db_dir, logger
        self.limit = limit
        self._set_services(cf_creds, cf_creds_path, deps or RqlMigratorDeps())

    def _set_services(self, cf_creds, cf_creds_path, deps: RqlMigratorDeps) -> None:
        self.engine = deps.engine or LeancryptoEngine()
        self.blob = CryptoBlob(self.engine)
        self.rqlite = deps.rqlite or self._new_rqlite()
        self.auth_factory = deps.auth_factory
        self.owner_new = OwnerInitializer(
            cf_creds, cf_creds_path, self.logger, engine=self.engine, d1=deps.d1
        )
        self.r2_old = deps.r2_old or R2Client(self.rql_creds.r2_config)
        self.r2_new = deps.r2_new or R2Client(cf_creds.r2_config)
        self.checkpoint_path = self.checkpoint = None
        self.store_new = self.catalog_new = None

    def _new_rqlite(self) -> RqliteClient:
        return RqliteClient(
            self.rql_creds.rqlite_operator_url,
            self.rql_creds.rqlite_admin_username,
            self.rql_creds.rqlite_admin_password,
        )

    def run(self) -> None:
        self._prepare_run()
        migrated, bookmarks = self._migrate_all()
        self.logger.info(
            f"Migration complete: {migrated} document(s), {bookmarks} bookmark(s), "
            f"db_prefix={self.account_new.db_prefix}"
        )

    def _prepare_run(self) -> None:
        self.umk_old, self.account_old = _load_rql_owner(
            self.rql_creds, self.rqlite, self.blob, self.auth_factory
        )
        self._prepare_new_owner()
        self.local_db_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoint_path = (
            self.local_db_dir / f"{self.account_new.db_prefix}.migrate-checkpoint.json"
        )
        self.checkpoint = _load_checkpoint(self.checkpoint_path)
        self.logger.info(
            f"rqlite db_path={self.account_old.db_path} -> "
            f"D1 db_prefix={self.account_new.db_prefix}"
        )

    def _prepare_new_owner(self) -> None:
        umk_new, payload_new = self.owner_new.load_current_owner()
        self.account_new = parse_owner_account(payload_new)
        self.store_new = DocumentStore(
            self.owner_new.d1,
            self.r2_new,
            self.blob,
            umk_new,
            self.account_new.db_prefix,
        )
        self.catalog_new = CatalogWriter(self.store_new)

    def _migrate_all(self) -> tuple[int, int]:
        remote = self._download_rqlite_database()
        with open_database(
            self.account_old.db_master_key, remote, engine_factory=SqliteEngine
        ) as db_old:
            return self._migrate_open_database(db_old)

    def _download_rqlite_database(self) -> bytes:
        remote = self.r2_old.get_object(self.account_old.db_path)
        if remote is None:
            raise ValueError(
                f"no rqlite database found at db_path={self.account_old.db_path}"
            )
        local_path = self.local_db_dir / self.account_old.db_path
        local_path.write_bytes(remote)
        self.logger.verbose(
            f"Downloaded rqlite database ({len(remote)} byte(s)) to {local_path}."
        )
        return remote

    def _migrate_open_database(self, db_old) -> tuple[int, int]:
        state = self.catalog_new.load_state()
        changed = False
        migrated = bookmarks = 0
        for row in db_old.query(TXT_ROWS_SQL):
            new_bookmarks, is_new, entry_added = self._migrate_row(db_old, row, state)
            bookmarks += new_bookmarks
            migrated += 1 if is_new else 0
            changed = changed or entry_added
            if self.limit is not None and migrated >= self.limit:
                break
        self._publish_if_changed(state, changed)
        return migrated, bookmarks

    def _publish_if_changed(self, state, changed: bool) -> None:
        if changed:
            self.logger.verbose(f"Uploading catalog ({len(state.entries)} entries)...")
            self.catalog_new.publish(state)
        else:
            self.logger.verbose(
                "Catalog already reflects every document; no upload needed."
            )

    def _migrate_row(self, db_old, row: tuple, state) -> tuple[int, bool, bool]:
        old_id, txt_key, txt_prefix, path, catalog_blob, last_accessed, last_cfi = row
        checkpoint_entry = self.checkpoint.get(str(old_id))
        is_new = checkpoint_entry is None
        if is_new:
            checkpoint_entry = self._insert_new_document(
                old_id, txt_key, txt_prefix, path, last_accessed, last_cfi
            )
        new_bookmarks = self._migrate_bookmarks(db_old, old_id, checkpoint_entry)
        catalog = json.loads(brotli.decompress(catalog_blob))
        entry_added = self.catalog_new.add_entry(
            state, checkpoint_entry["document_id"], catalog
        )
        return new_bookmarks, is_new, entry_added

    def _insert_new_document(
        self, old_id, txt_key, txt_prefix, path, last_accessed, last_cfi
    ) -> dict:
        data = self._download_and_decrypt(txt_prefix, path, txt_key)
        content_key = secrets.token_bytes(128)
        new_path = to_base32_crockford(secrets.token_bytes(32))
        object_key = self.store_new.upload_content(new_path, data, content_key)
        document_id = self.store_new.insert_document(
            content_key, new_path, last_accessed=last_accessed, last_cfi=last_cfi
        )
        self._log_new_document(old_id, data, object_key, document_id)
        entry = {"document_id": document_id, "bookmarks_done": False}
        self._save_checkpoint_entry(old_id, entry)
        return entry

    def _log_new_document(self, old_id, data: bytes, object_key: str, document_id: int):
        self.logger.info(
            f"txt id={old_id} ({len(data)} byte(s)) -> {object_key} "
            f"document_id={document_id}"
        )

    def _download_and_decrypt(
        self, txt_prefix: bytes, path: bytes, txt_key: bytes
    ) -> bytes:
        old_key = (
            f"{self.account_old.db_prefix}/{to_base32_crockford(txt_prefix)}"
            f"/{to_base32_crockford(path)}"
        )
        encrypted = self.r2_old.get_object(old_key)
        if encrypted is None:
            raise ValueError(f"missing rqlite content object: {old_key}")
        return self.blob.decrypt(encrypted, txt_key)

    def _migrate_bookmarks(self, db_old, old_id: int, checkpoint_entry: dict) -> int:
        if checkpoint_entry["bookmarks_done"]:
            return 0
        rows = db_old.query(BOOKMARK_ROWS_SQL, [old_id])
        document_id = checkpoint_entry["document_id"]
        for cfi, page_number, preview, created_at in rows:
            self.store_new.insert_bookmark(
                document_id, cfi, page_number, preview, created_at
            )
        checkpoint_entry["bookmarks_done"] = True
        self._save_checkpoint_entry(old_id, checkpoint_entry)
        return len(rows)

    def _save_checkpoint_entry(self, old_id: int, entry: dict) -> None:
        self.checkpoint[str(old_id)] = entry
        _save_checkpoint(self.checkpoint_path, self.checkpoint)


def _load_rql_owner(
    creds: RqlOwnerCreds, rqlite: RqliteClient, blob: CryptoBlob, auth_factory
) -> tuple[bytes, RqlOwnerAccount]:
    uid = auth_factory(creds.firebase_api_key).sign_in(
        creds.firebase_email, creds.firebase_password
    )
    row = rqlite.query_one(OWNER_CONTROL_SQL)
    if row is None:
        raise ValueError("rqlite owner_control is empty; nothing to migrate")
    if row["firebase_uid"] != uid:
        raise ValueError("rqlite owner_control belongs to a different Firebase account")
    return _unwrap_rql_owner(creds, blob, row)


def _unwrap_rql_owner(
    creds: RqlOwnerCreds, blob: CryptoBlob, row: dict
) -> tuple[bytes, RqlOwnerAccount]:
    root_key = _decode_root_key(creds.user_root_key)
    umk = blob.decrypt(row["wrapped_umk"], root_key)
    payload = blob.decrypt_json(row["encrypted_credentials"], umk)
    return umk, _parse_rql_account(payload)


def _decode_root_key(value: str) -> bytes:
    key = base64.b64decode(value, validate=True)
    if len(key) != 256:
        raise ValueError("rql_creds.json has an invalid user_root_key")
    return key


def _parse_rql_account(payload: dict) -> RqlOwnerAccount:
    return RqlOwnerAccount(
        db_master_key=_decode_master_key(payload.get("db_master_key")),
        db_path=_storage_path("db_path", payload.get("db_path")),
        db_prefix=_storage_path("db_prefix", payload.get("db_prefix")),
    )


def _decode_master_key(value: object) -> bytes:
    if not isinstance(value, str):
        raise ValueError("rqlite owner credentials have an invalid db_master_key")
    key = base64.b64decode(value, validate=True)
    if len(key) != 256:
        raise ValueError("rqlite owner credentials have an invalid db_master_key")
    return key


def _storage_path(name: str, value: object) -> str:
    if not isinstance(value, str) or len(value) != 52:
        raise ValueError(f"rqlite owner credentials have an invalid {name}")
    return value


def _load_checkpoint(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _save_checkpoint(path: Path, checkpoint: dict[str, dict]) -> None:
    path.write_text(json.dumps(checkpoint, indent=2) + "\n")
