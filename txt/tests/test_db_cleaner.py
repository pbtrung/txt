import base64
import hashlib
import json
import secrets

import pytest

from txt.creds import load_owner_creds
from txt.r2_client import R2Object
from txt.random_token import to_base32_crockford
from txt.sqlite_engine import SqliteEngine

# db_cleaner.py still targets the pre-Milestone-9 owner_init.py/rqlite
# shape (self.owner.rqlite, StorageAccount) and hasn't been rewritten for
# the D1 design yet (docs/milestones.md Milestone 9). importorskip only
# catches "module not found", not "module found but broken internally" --
# this one is deliberately broken internally, so skip explicitly instead
# of letting collection fail.
try:
    import txt.db_cleaner as db_cleaner_module
except ImportError as error:
    pytest.skip(f"pending Milestone 9's D1 rewrite: {error}", allow_module_level=True)
DbCleaner = db_cleaner_module.DbCleaner

OWNER_UID = "uid-owner"
OWNER_ROOT_KEY = base64.b64encode(secrets.token_bytes(256)).decode()
DB_PREFIX = "p" * 52

CREATE_TXT_SHARES_SQL = """
CREATE TABLE txt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_key BLOB NOT NULL,
  txt_prefix BLOB NOT NULL,
  path BLOB NOT NULL,
  catalog BLOB NOT NULL,
  last_accessed INTEGER NOT NULL,
  last_cfi TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE txt_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_id INTEGER NOT NULL,
  share_id BLOB NOT NULL CHECK (length(share_id) = 32),
  share_content_key BLOB NOT NULL CHECK (length(share_content_key) = 128),
  share_prefix BLOB NOT NULL CHECK (length(share_prefix) = 32),
  share_path BLOB NOT NULL CHECK (length(share_path) = 32),
  state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'deleting')),
  created_at INTEGER NOT NULL
);
INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at)
VALUES (x'00', x'00', x'00', x'00', 0, 0);
"""


class NullLogger:
    def verbose(self, message):
        pass

    def info(self, message):
        pass


class CaptureLogger:
    def __init__(self):
        self.messages = []

    def verbose(self, message):
        self.messages.append(message)

    def info(self, message):
        self.messages.append(message)


class FakeRqliteClient:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
        self.vacuum_calls = 0
        self.deletes = []

    def query(self, sql, params=None):
        if "state = 'deleting'" in sql:
            return [row for row in self.rows if row["state"] == "deleting"]
        return list(self.rows)

    def execute(self, sql, params=None):
        self.deletes.append(dict(params or {}))
        self.rows = [row for row in self.rows if not _matches(row, params)]
        return {}

    def vacuum(self):
        self.vacuum_calls += 1
        return {}


def _matches(row, params):
    return (
        row["share_id_hash"] == params["share_id_hash"]
        and row["object_path_hash"] == params["object_path_hash"]
    )


class FakeOwnerInitializer:
    current_owner: tuple[str, bytes, dict] | None = None
    rqlite: FakeRqliteClient | None = None

    def __init__(self, creds, creds_path, logger):
        pass

    def load_current_owner(self):
        if FakeOwnerInitializer.current_owner is None:
            raise ValueError("owner is not provisioned in rqlite")
        return FakeOwnerInitializer.current_owner


class FakeR2Client:
    objects: dict = {}
    put_calls: list = []
    deleted: list = []

    def __init__(self, config):
        pass

    def get_object_with_etag(self, key):
        body = FakeR2Client.objects.get(key)
        return None if body is None else R2Object(body, '"v1"')

    def put_object(self, key, body, *, if_match=None, if_none_match=False):
        FakeR2Client.put_calls.append((key, if_match, if_none_match))
        FakeR2Client.objects[key] = body

    def delete_keys(self, keys, on_progress=None):
        FakeR2Client.deleted.extend(keys)


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(db_cleaner_module, "OwnerInitializer", FakeOwnerInitializer)
    monkeypatch.setattr(db_cleaner_module, "R2Client", FakeR2Client)
    FakeOwnerInitializer.current_owner = None
    FakeOwnerInitializer.rqlite = FakeRqliteClient()
    FakeR2Client.objects = {}
    FakeR2Client.put_calls = []
    FakeR2Client.deleted = []
    yield


@pytest.fixture
def creds_path(tmp_path):
    data = {
        "rqlite_admin_username": "operator",
        "rqlite_admin_password": "secret",
        "rqlite_operator_url": "https://api.example.com/operator/rqlite",
        "rqlite_control_backup": "control-backups/",
        "firebase_email": "owner@example.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "display_name": "Owner",
        "r2_config": {
            "endpoint": "https://account.r2.cloudflarestorage.com",
            "read_write_access_key_id": "rw-id",
            "read_write_secret_access_key": "rw-secret",
            "region": "auto",
            "bucket": "books",
        },
        "user_root_key": OWNER_ROOT_KEY,
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


def _cleaner(creds_path, tmp_path, *, dry_run=False, logger=None) -> DbCleaner:
    return DbCleaner(
        load_owner_creds(creds_path),
        creds_path,
        tmp_path / "local",
        logger or NullLogger(),
        dry_run=dry_run,
    )


def _set_owner(uid: str, db_master_key: bytes, db_path: str) -> None:
    payload = {
        "user_handle": base64.b64encode(secrets.token_bytes(32)).decode(),
        "display_name": uid,
        "db_master_key": base64.b64encode(db_master_key).decode(),
        "db_path": db_path,
        "db_prefix": DB_PREFIX,
    }
    FakeOwnerInitializer.current_owner = (uid, secrets.token_bytes(128), payload)


def _build_db(db_master_key: bytes, shares: list) -> bytes:
    engine = SqliteEngine()
    engine.open(db_master_key)
    engine.exec_sql("PRAGMA page_size = 16384")
    engine.exec_sql(CREATE_TXT_SHARES_SQL)
    for share_id, prefix, path, state in shares:
        engine.execute(
            "INSERT INTO txt_shares "
            "(txt_id, share_id, share_content_key, share_prefix, share_path, "
            "state, created_at) VALUES (1, ?, ?, ?, ?, ?, 0)",
            [share_id, b"k" * 128, prefix, path, state],
        )
    data = engine.to_bytes()
    engine.close()
    return data


def _reopen(db_master_key: bytes, data: bytes) -> SqliteEngine:
    engine = SqliteEngine()
    engine.open(db_master_key, initial_bytes=data)
    engine.exec_sql("PRAGMA page_size = 16384")
    return engine


def _object_path(prefix: bytes, path: bytes) -> str:
    return (
        f"{DB_PREFIX}/shared/{to_base32_crockford(prefix)}/{to_base32_crockford(path)}"
    )


def _control_row(share_id: bytes, object_path: str, state: str) -> dict:
    return {
        "share_id_hash": hashlib.sha256(share_id).digest(),
        "object_path_hash": hashlib.sha256(object_path.encode()).digest(),
        "state": state,
    }


def test_removes_a_stuck_creating_share_with_no_control_row(tmp_path, creds_path):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    share_id, prefix, path = (
        secrets.token_bytes(32),
        secrets.token_bytes(32),
        secrets.token_bytes(32),
    )
    FakeR2Client.objects[db_path] = _build_db(
        db_master_key, [(share_id, prefix, path, "creating")]
    )

    _cleaner(creds_path, tmp_path).run()

    assert FakeR2Client.deleted == [_object_path(prefix, path)]
    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    assert verify.query("SELECT * FROM txt_shares") == []
    verify.close()


def test_removes_a_stuck_deleting_share_and_its_control_row(tmp_path, creds_path):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    share_id, prefix, path = (
        secrets.token_bytes(32),
        secrets.token_bytes(32),
        secrets.token_bytes(32),
    )
    FakeR2Client.objects[db_path] = _build_db(
        db_master_key, [(share_id, prefix, path, "deleting")]
    )
    object_path = _object_path(prefix, path)
    FakeOwnerInitializer.rqlite = FakeRqliteClient(
        [_control_row(share_id, object_path, "deleting")]
    )

    _cleaner(creds_path, tmp_path).run()

    assert FakeR2Client.deleted == [object_path]
    assert FakeOwnerInitializer.rqlite.rows == []
    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    assert verify.query("SELECT * FROM txt_shares") == []
    verify.close()


def test_heals_a_stuck_creating_share_whose_registration_actually_succeeded(
    tmp_path, creds_path
):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    share_id, prefix, path = (
        secrets.token_bytes(32),
        secrets.token_bytes(32),
        secrets.token_bytes(32),
    )
    FakeR2Client.objects[db_path] = _build_db(
        db_master_key, [(share_id, prefix, path, "creating")]
    )
    object_path = _object_path(prefix, path)
    control_row = _control_row(share_id, object_path, "active")
    FakeOwnerInitializer.rqlite = FakeRqliteClient([control_row])

    _cleaner(creds_path, tmp_path).run()

    assert FakeR2Client.deleted == []
    assert FakeOwnerInitializer.rqlite.rows == [control_row]
    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    assert verify.query("SELECT state FROM txt_shares") == [("active",)]
    verify.close()


def test_removes_orphaned_control_only_deleting_rows(tmp_path, creds_path):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_db(db_master_key, [])
    orphan = _control_row(secrets.token_bytes(32), "some/orphaned/path", "deleting")
    FakeOwnerInitializer.rqlite = FakeRqliteClient([orphan])

    _cleaner(creds_path, tmp_path).run()

    assert FakeOwnerInitializer.rqlite.rows == []


def test_dry_run_reports_without_removing_but_still_vacuums(tmp_path, creds_path):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    share_id, prefix, path = (
        secrets.token_bytes(32),
        secrets.token_bytes(32),
        secrets.token_bytes(32),
    )
    FakeR2Client.objects[db_path] = _build_db(
        db_master_key, [(share_id, prefix, path, "creating")]
    )
    logger = CaptureLogger()

    _cleaner(creds_path, tmp_path, dry_run=True, logger=logger).run()

    assert FakeR2Client.deleted == []
    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    assert verify.query("SELECT state FROM txt_shares") == [("creating",)]
    verify.close()
    assert FakeR2Client.put_calls == [(db_path, '"v1"', False)]
    assert FakeOwnerInitializer.rqlite.vacuum_calls == 1
    output = "\n".join(logger.messages)
    assert "Would remove stale share" in output


def test_vacuums_both_databases_even_with_nothing_stale(tmp_path, creds_path):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_db(db_master_key, [])
    logger = CaptureLogger()

    _cleaner(creds_path, tmp_path, logger=logger).run()

    assert FakeR2Client.put_calls == [(db_path, '"v1"', False)]
    assert FakeOwnerInitializer.rqlite.vacuum_calls == 1
    output = "\n".join(logger.messages)
    assert "No stale share rows found." in output
    assert "control database vacuumed (0 stale row(s) were removed from it)." in output


def test_summary_reports_counts_of_removed_healed_and_orphaned_rows(
    tmp_path, creds_path
):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    removed_id, removed_prefix, removed_path = (
        secrets.token_bytes(32),
        secrets.token_bytes(32),
        secrets.token_bytes(32),
    )
    healed_id, healed_prefix, healed_path = (
        secrets.token_bytes(32),
        secrets.token_bytes(32),
        secrets.token_bytes(32),
    )
    FakeR2Client.objects[db_path] = _build_db(
        db_master_key,
        [
            (removed_id, removed_prefix, removed_path, "deleting"),
            (healed_id, healed_prefix, healed_path, "creating"),
        ],
    )
    healed_path_str = _object_path(healed_prefix, healed_path)
    orphan = _control_row(secrets.token_bytes(32), "some/orphaned/path", "deleting")
    FakeOwnerInitializer.rqlite = FakeRqliteClient(
        [_control_row(healed_id, healed_path_str, "active"), orphan]
    )
    logger = CaptureLogger()

    _cleaner(creds_path, tmp_path, logger=logger).run()

    output = "\n".join(logger.messages)
    assert "3 stale share row(s) found: 2 were removed, 1 were healed." in output
    assert "control database vacuumed (1 stale row(s) were removed from it)." in output


def test_skips_sqlcipher_cleanup_when_no_database_exists_yet(tmp_path, creds_path):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)

    _cleaner(creds_path, tmp_path).run()

    assert db_path not in FakeR2Client.objects
    assert FakeR2Client.put_calls == []


def test_removes_orphaned_control_rows_even_with_no_local_database_yet(
    tmp_path, creds_path
):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    orphan = _control_row(secrets.token_bytes(32), "some/orphaned/path", "deleting")
    FakeOwnerInitializer.rqlite = FakeRqliteClient([orphan])
    logger = CaptureLogger()

    _cleaner(creds_path, tmp_path, logger=logger).run()

    assert FakeOwnerInitializer.rqlite.rows == []
    output = "\n".join(logger.messages)
    assert "1 stale share row(s) found: 1 were removed, 0 were healed." in output
    assert "control database vacuumed (1 stale row(s) were removed from it)." in output
    assert FakeOwnerInitializer.rqlite.vacuum_calls == 1


def test_writes_a_local_checkpoint_of_the_vacuumed_database(tmp_path, creds_path):
    db_master_key, db_path = secrets.token_bytes(256), "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_db(db_master_key, [])

    _cleaner(creds_path, tmp_path).run()

    checkpoint = tmp_path / "local" / db_path
    assert checkpoint.read_bytes() == FakeR2Client.objects[db_path]
