import base64
import json
import secrets

import brotli
import pytest

import txt.db_updater as db_updater_module
from txt.creds import load_owner_creds
from txt.db_updater import DbUpdater
from txt.r2_client import R2Object, R2PreconditionFailed
from txt.sqlite_engine import SqliteEngine

OWNER_UID = "uid-owner"
OWNER_ROOT_KEY = base64.b64encode(secrets.token_bytes(256)).decode()

# The pre-migration schema (txt/ingest.py's CREATE_TXT_SQL before the
# metadata -> catalog rename), used to build "before" fixture databases.
OLD_CREATE_TXT_SQL = """
CREATE TABLE txt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_key BLOB NOT NULL,
  txt_prefix BLOB NOT NULL,
  path BLOB NOT NULL,
  metadata BLOB NOT NULL,
  last_accessed INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)
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


class FakeOwnerInitializer:
    current_owner: tuple[str, bytes, dict] | None = None

    def __init__(self, creds, creds_path, logger):
        pass

    def load_current_owner(self):
        if FakeOwnerInitializer.current_owner is None:
            raise ValueError("owner is not provisioned in rqlite")
        return FakeOwnerInitializer.current_owner


class FakeR2Client:
    objects: dict = {}
    versions: dict = {}
    put_calls: list = []
    conflict_replacements: dict = {}

    def __init__(self, config):
        pass

    def get_object_with_etag(self, key):
        body = FakeR2Client.objects.get(key)
        if body is None:
            return None
        version = FakeR2Client.versions.setdefault(key, 1)
        return R2Object(body, f'"v{version}"')

    def put_object(self, key, body, *, if_match=None, if_none_match=False):
        if key in FakeR2Client.conflict_replacements:
            FakeR2Client.objects[key] = FakeR2Client.conflict_replacements.pop(key)
            FakeR2Client.versions[key] = FakeR2Client.versions.get(key, 1) + 1
        current = FakeR2Client.objects.get(key)
        current_etag = (
            f'"v{FakeR2Client.versions.setdefault(key, 1)}"'
            if current is not None
            else None
        )
        if if_match is not None and if_match != current_etag:
            raise R2PreconditionFailed("conflicted with a newer object")
        if if_none_match and current is not None:
            raise R2PreconditionFailed("conflicted with a newer object")
        FakeR2Client.put_calls.append((key, if_match, if_none_match))
        FakeR2Client.objects[key] = body
        FakeR2Client.versions[key] = FakeR2Client.versions.get(key, 0) + 1


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(db_updater_module, "OwnerInitializer", FakeOwnerInitializer)
    monkeypatch.setattr(db_updater_module, "R2Client", FakeR2Client)
    FakeOwnerInitializer.current_owner = None
    FakeR2Client.objects = {}
    FakeR2Client.versions = {}
    FakeR2Client.put_calls = []
    FakeR2Client.conflict_replacements = {}
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


def _updater(creds_path: str, local_db_dir, logger=None) -> DbUpdater:
    return DbUpdater(
        load_owner_creds(creds_path), creds_path, local_db_dir, logger or NullLogger()
    )


def _old_row_bytes(name: str, opf_metadata: dict | None = None) -> bytes:
    payload = {"name": name}
    if opf_metadata:
        payload["metadata"] = opf_metadata
    return brotli.compress(json.dumps(payload).encode())


def _build_old_db(db_master_key: bytes, rows: list) -> bytes:
    engine = SqliteEngine()
    engine.open(db_master_key)
    engine.exec_sql("PRAGMA page_size = 16384")
    engine.exec_sql(OLD_CREATE_TXT_SQL)
    for name, opf_metadata in rows:
        engine.execute(
            "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, "
            "created_at) VALUES (x'00', x'00', x'00', ?, 0, 0)",
            [_old_row_bytes(name, opf_metadata)],
        )
    data = engine.to_bytes()
    engine.close()
    return data


def _reopen(db_master_key: bytes, data: bytes) -> SqliteEngine:
    engine = SqliteEngine()
    engine.open(db_master_key, initial_bytes=data)
    engine.exec_sql("PRAGMA page_size = 16384")
    return engine


def _set_owner(uid: str, db_master_key: bytes, db_path: str) -> None:
    payload = {
        "user_handle": base64.b64encode(secrets.token_bytes(32)).decode(),
        "display_name": uid,
        "db_master_key": base64.b64encode(db_master_key).decode(),
        "db_path": db_path,
        "db_prefix": "p" * 52,
    }
    FakeOwnerInitializer.current_owner = (uid, secrets.token_bytes(128), payload)


def test_migrates_owner_database(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_old_db(
        db_master_key,
        [("dune.epub", {"title": "Dune", "creator": "Frank Herbert"})],
    )

    _updater(creds_path, tmp_path / "local").run()

    assert FakeR2Client.put_calls == [(db_path, '"v1"', False)]

    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    columns = {row[1] for row in verify.query("PRAGMA table_info(txt)")}
    assert "metadata" not in columns
    assert "catalog" in columns
    assert "last_cfi" in columns
    bookmark_columns = {
        row[1] for row in verify.query("PRAGMA table_info(txt_bookmarks)")
    }
    assert "cfi" in bookmark_columns
    assert "page_number" in bookmark_columns
    assert "line" not in bookmark_columns
    [(catalog_blob,)] = verify.query("SELECT catalog FROM txt")
    catalog = json.loads(brotli.decompress(catalog_blob))
    verify.close()
    assert catalog == {
        "name": "dune.epub",
        "title": "Dune",
        "authors": ["Frank Herbert"],
        "subjects": [],
        "publisher": None,
    }


def test_logs_download_migration_and_schema_validation_progress(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_old_db(
        db_master_key, [("dune.epub", {"title": "Dune"})]
    )
    logger = CaptureLogger()

    _updater(creds_path, tmp_path / "local", logger).run()

    output = "\n".join(logger.messages)
    assert f"Downloading {db_path} from R2" in output
    assert "downloaded " in output and 'etag="v1"' in output
    assert "opening and decrypting database" in output
    assert "current txt columns" in output
    assert "migrating metadata to catalog" in output
    assert "ensuring CFI reading-state schema" in output
    assert "resetting legacy last_accessed values" in output
    assert "validating complete database schema" in output
    assert (
        "schema check passed: page_size=16384, txt_rows=1, bookmarks=0, shares=0"
        in output
    )
    assert "uploading " in output and "with R2 precondition" in output


def test_second_run_is_a_noop(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_old_db(db_master_key, [("a.epub", {})])

    local_dir = tmp_path / "local"
    _updater(creds_path, local_dir).run()
    first_upload = FakeR2Client.objects[db_path]
    upload_count = len(FakeR2Client.put_calls)

    _updater(creds_path, local_dir).run()
    assert FakeR2Client.objects[db_path] == first_upload
    assert len(FakeR2Client.put_calls) == upload_count


def test_named_migration_resets_legacy_access_once(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    data = _build_old_db(db_master_key, [("a.epub", {})])
    legacy = _reopen(db_master_key, data)
    legacy.exec_sql("UPDATE txt SET last_accessed = 1234, created_at = 10")
    FakeR2Client.objects[db_path] = legacy.to_bytes()
    legacy.close()

    local_dir = tmp_path / "local"
    _updater(creds_path, local_dir).run()

    migrated = _reopen(db_master_key, FakeR2Client.objects[db_path])
    assert migrated.query("SELECT last_accessed FROM txt") == [(0,)]
    bookmark_columns = {
        row[1] for row in migrated.query("PRAGMA table_info(txt_bookmarks)")
    }
    assert "page_number" in bookmark_columns
    assert migrated.query("SELECT name FROM txt_schema_migrations") == [
        ("reset_initial_last_accessed",)
    ]
    migrated.close()

    uploads = len(FakeR2Client.put_calls)
    _updater(creds_path, local_dir).run()
    assert len(FakeR2Client.put_calls) == uploads


def test_ignores_local_checkpoint_and_migrates_the_current_remote_database(
    tmp_path, creds_path
):
    # A local checkpoint may be older or newer than R2. It is never trusted as
    # an upload base now that the browser can write reading state remotely.
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_old_db(
        db_master_key, [("dune.epub", {"title": "Dune"})]
    )

    local_dir = tmp_path / "local"
    local_dir.mkdir()
    migrated = SqliteEngine()
    migrated.open(db_master_key)
    migrated.exec_sql("PRAGMA page_size = 16384")
    migrated.exec_sql("""
        CREATE TABLE txt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          txt_key BLOB NOT NULL,
          txt_prefix BLOB NOT NULL,
          path BLOB NOT NULL,
          catalog BLOB NOT NULL,
          last_accessed INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
        """)
    migrated.execute(
        "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, "
        "created_at) VALUES (x'00', x'00', x'00', ?, 0, 0)",
        [
            brotli.compress(
                json.dumps(
                    {
                        "name": "dune.epub",
                        "title": "Stale local title",
                        "authors": [],
                        "subjects": [],
                        "publisher": None,
                    }
                ).encode()
            )
        ],
    )
    (local_dir / db_path).write_bytes(migrated.to_bytes())
    migrated.close()

    _updater(creds_path, local_dir).run()

    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    columns = {row[1] for row in verify.query("PRAGMA table_info(txt)")}
    [(catalog_blob,)] = verify.query("SELECT catalog FROM txt")
    catalog = json.loads(brotli.decompress(catalog_blob))
    assert "metadata" not in columns
    assert "catalog" in columns
    assert catalog["title"] == "Dune"
    verify.close()


def test_resumes_a_partially_migrated_database(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)

    # Simulate an interrupted prior run: catalog column added, one row
    # already populated, the other still only has metadata.
    partial = SqliteEngine()
    partial.open(db_master_key)
    partial.exec_sql("PRAGMA page_size = 16384")
    partial.exec_sql(OLD_CREATE_TXT_SQL)
    partial.execute(
        "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, "
        "created_at) VALUES (x'00', x'00', x'00', ?, 0, 0)",
        [_old_row_bytes("done.epub", {"title": "Done"})],
    )
    partial.execute(
        "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, "
        "created_at) VALUES (x'01', x'01', x'01', ?, 0, 0)",
        [_old_row_bytes("todo.epub", {"title": "Todo"})],
    )
    partial.exec_sql("ALTER TABLE txt ADD COLUMN catalog BLOB")
    partial.execute(
        "UPDATE txt SET catalog = ? WHERE txt_key = x'00'",
        [
            brotli.compress(
                json.dumps(
                    {
                        "name": "done.epub",
                        "title": "Done",
                        "authors": [],
                        "subjects": [],
                        "publisher": None,
                    }
                ).encode()
            )
        ],
    )
    FakeR2Client.objects[db_path] = partial.to_bytes()
    partial.close()

    _updater(creds_path, tmp_path / "local").run()

    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    columns = {row[1] for row in verify.query("PRAGMA table_info(txt)")}
    assert "metadata" not in columns
    catalogs = [
        json.loads(brotli.decompress(row[0]))["title"]
        for row in verify.query("SELECT catalog FROM txt ORDER BY id")
    ]
    verify.close()
    assert catalogs == ["Done", "Todo"]


def test_skips_account_with_no_database_yet(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    # No FakeR2Client.objects entry for db_path -- nothing uploaded yet.

    _updater(creds_path, tmp_path / "local").run()

    assert db_path not in FakeR2Client.objects


def _build_db_with_legacy_bookmarks(
    db_master_key: bytes, *, bookmark_count: int
) -> bytes:
    legacy = SqliteEngine()
    legacy.open(db_master_key)
    legacy.exec_sql("PRAGMA page_size = 16384")
    legacy.exec_sql("""
        CREATE TABLE txt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          txt_key BLOB NOT NULL,
          txt_prefix BLOB NOT NULL,
          path BLOB NOT NULL,
          catalog BLOB NOT NULL,
          last_accessed INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE txt_bookmarks (
          id INTEGER PRIMARY KEY,
          txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
          line INTEGER NOT NULL,
          preview TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (txt_id, line)
        );
        INSERT INTO txt VALUES (1, x'00', x'00', x'00', x'00', 0, 0);
        """)
    for line in range(bookmark_count):
        legacy.execute(
            "INSERT INTO txt_bookmarks (txt_id, line, preview, created_at) "
            "VALUES (1, ?, 'legacy', 0)",
            [line],
        )
    data = legacy.to_bytes()
    legacy.close()
    return data


def test_rebuilds_empty_legacy_bookmarks(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_db_with_legacy_bookmarks(
        db_master_key, bookmark_count=0
    )

    _updater(creds_path, tmp_path / "local").run()

    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    assert "last_cfi" in {row[1] for row in verify.query("PRAGMA table_info(txt)")}
    bookmark_columns = {
        row[1] for row in verify.query("PRAGMA table_info(txt_bookmarks)")
    }
    verify.close()
    assert "cfi" in bookmark_columns
    assert "page_number" in bookmark_columns
    assert "line" not in bookmark_columns


def test_aborts_nonempty_legacy_bookmarks_without_upload(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    original = _build_db_with_legacy_bookmarks(db_master_key, bookmark_count=1)
    FakeR2Client.objects[db_path] = original

    with pytest.raises(ValueError, match="cannot migrate.*CFI"):
        _updater(creds_path, tmp_path / "local").run()

    assert FakeR2Client.objects[db_path] == original
    assert not (tmp_path / "local" / db_path).exists()


def test_conditional_upload_does_not_overwrite_a_concurrent_remote_change(
    tmp_path, creds_path
):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    original = _build_old_db(db_master_key, [("original.epub", {})])
    concurrent = _build_old_db(db_master_key, [("concurrent.epub", {})])
    FakeR2Client.objects[db_path] = original
    FakeR2Client.conflict_replacements[db_path] = concurrent

    with pytest.raises(R2PreconditionFailed, match="newer object"):
        _updater(creds_path, tmp_path / "local").run()

    assert FakeR2Client.objects[db_path] == concurrent
    assert FakeR2Client.put_calls == []


def test_rejects_an_invalid_final_schema_without_upload(tmp_path, creds_path):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _set_owner(OWNER_UID, db_master_key, db_path)
    malformed = SqliteEngine()
    malformed.open(db_master_key)
    malformed.exec_sql("PRAGMA page_size = 16384")
    malformed.exec_sql("""
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
        CREATE TABLE txt_bookmarks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
          cfi TEXT NOT NULL,
          preview TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (txt_id, cfi)
        );
        """)
    original = malformed.to_bytes()
    malformed.close()
    FakeR2Client.objects[db_path] = original

    with pytest.raises(ValueError, match="missing the 100-byte preview limit"):
        _updater(creds_path, tmp_path / "local").run()

    assert FakeR2Client.objects[db_path] == original
    assert FakeR2Client.put_calls == []
