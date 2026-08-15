import base64
import json
import secrets

import brotli
import pytest

import txt.db_updater as db_updater_module
from txt.creds import load_creds
from txt.crypto_blob import CryptoBlob
from txt.db_updater import DbUpdater
from txt.sqlite_engine import SqliteEngine

ADMIN_UID = "uid-admin"
USER_UID = "uid-user"
ADMIN_ROOT_KEY = base64.b64encode(secrets.token_bytes(256)).decode()

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


class FakeFirebaseAuth:
    def __init__(self, api_key):
        pass

    def sign_in(self, email, password):
        return ADMIN_UID


class FakeTursoClient:
    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        return f"token-for-{db_name}"


class FakeLibsqlClient:
    key_store: dict = {}  # uid -> wrapped_umk
    cred_store: dict = {}  # for_user_id -> content (owner is always the admin here)

    def __init__(self, url, token):
        self.url = url

    def execute(self, sql, args=None):
        return {}

    def query(self, sql, args=None):
        normalized = " ".join(sql.split())
        if "SELECT umk FROM key_store" in normalized:
            (uid,) = args
            wrapped = FakeLibsqlClient.key_store.get(uid)
            return [[wrapped]] if wrapped else []
        if "SELECT for_user_id, content FROM cred_store" in normalized:
            return [
                [uid, content] for uid, content in FakeLibsqlClient.cred_store.items()
            ]
        return []


class FakeR2Client:
    objects: dict = {}

    def __init__(self, config):
        pass

    def get_object(self, key):
        return FakeR2Client.objects.get(key)

    def put_object(self, key, body):
        FakeR2Client.objects[key] = body


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(db_updater_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(db_updater_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(db_updater_module, "LibsqlClient", FakeLibsqlClient)
    monkeypatch.setattr(db_updater_module, "R2Client", FakeR2Client)
    FakeLibsqlClient.key_store = {}
    FakeLibsqlClient.cred_store = {}
    FakeR2Client.objects = {}
    yield


@pytest.fixture
def creds_path(tmp_path):
    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_name": "ctlname",
        "turso_ctl_db_url": "libsql://ctlname-x.aws-us-east-1.turso.io",
        "firebase_email": "admin@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "user_root_key": ADMIN_ROOT_KEY,
    }
    path = tmp_path / "creds.json"
    path.write_text(json.dumps(data))
    return str(path)


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


def _register_account(engine, uid: str, db_master_key: bytes, db_path: str) -> bytes:
    """Seeds ctl fake state for one account reachable by the admin (the
    admin's own uid, or a backed-up user's) and returns the admin's own
    plaintext umk (generating + registering it on first call).
    """
    blob = CryptoBlob(engine)
    wrapped_admin_umk = FakeLibsqlClient.key_store.get(ADMIN_UID)
    if wrapped_admin_umk is None:
        admin_umk = secrets.token_bytes(128)
        FakeLibsqlClient.key_store[ADMIN_UID] = blob.encrypt(
            admin_umk, base64.b64decode(ADMIN_ROOT_KEY)
        )
    else:
        admin_umk = blob.decrypt(wrapped_admin_umk, base64.b64decode(ADMIN_ROOT_KEY))
    payload = {
        "display_name": uid,
        "db_master_key": base64.b64encode(db_master_key).decode(),
        "db_path": db_path,
        "db_prefix": "p" * 52,
    }
    FakeLibsqlClient.cred_store[uid] = blob.encrypt_json(payload, admin_umk)
    return admin_umk


def test_migrates_admin_own_database(tmp_path, creds_path, engine):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _register_account(engine, ADMIN_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_old_db(
        db_master_key,
        [("dune.epub", {"title": "Dune", "creator": "Frank Herbert"})],
    )

    DbUpdater(load_creds(creds_path), tmp_path / "local", NullLogger()).run()

    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    columns = {row[1] for row in verify.query("PRAGMA table_info(txt)")}
    assert "metadata" not in columns
    assert "catalog" in columns
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


def test_migrates_every_reachable_account(tmp_path, creds_path, engine):
    admin_db_master_key = secrets.token_bytes(256)
    admin_db_path = "a" * 52
    _register_account(engine, ADMIN_UID, admin_db_master_key, admin_db_path)
    FakeR2Client.objects[admin_db_path] = _build_old_db(
        admin_db_master_key, [("admin-book.epub", {})]
    )

    user_db_master_key = secrets.token_bytes(256)
    user_db_path = "u" * 52
    _register_account(engine, USER_UID, user_db_master_key, user_db_path)
    FakeR2Client.objects[user_db_path] = _build_old_db(
        user_db_master_key, [("user-book.epub", {})]
    )

    DbUpdater(load_creds(creds_path), tmp_path / "local", NullLogger()).run()

    for db_master_key, db_path in [
        (admin_db_master_key, admin_db_path),
        (user_db_master_key, user_db_path),
    ]:
        verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
        columns = {row[1] for row in verify.query("PRAGMA table_info(txt)")}
        assert "metadata" not in columns
        verify.close()


def test_second_run_is_a_noop(tmp_path, creds_path, engine):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _register_account(engine, ADMIN_UID, db_master_key, db_path)
    FakeR2Client.objects[db_path] = _build_old_db(db_master_key, [("a.epub", {})])

    local_dir = tmp_path / "local"
    DbUpdater(load_creds(creds_path), local_dir, NullLogger()).run()
    first_upload = FakeR2Client.objects[db_path]

    DbUpdater(load_creds(creds_path), local_dir, NullLogger()).run()
    assert FakeR2Client.objects[db_path] == first_upload


def test_reuploads_when_local_copy_is_migrated_but_r2_is_still_stale(
    tmp_path, creds_path, engine
):
    # Simulates an interrupted prior run: the local working copy already
    # got migrated and written to disk, but the upload to R2 never landed
    # (network drop, etc.), so R2 is still on the old schema.
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _register_account(engine, ADMIN_UID, db_master_key, db_path)
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
                        "title": "Dune",
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

    DbUpdater(load_creds(creds_path), local_dir, NullLogger()).run()

    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    columns = {row[1] for row in verify.query("PRAGMA table_info(txt)")}
    assert "metadata" not in columns
    assert "catalog" in columns
    verify.close()


def test_resumes_a_partially_migrated_database(tmp_path, creds_path, engine):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _register_account(engine, ADMIN_UID, db_master_key, db_path)

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

    DbUpdater(load_creds(creds_path), tmp_path / "local", NullLogger()).run()

    verify = _reopen(db_master_key, FakeR2Client.objects[db_path])
    columns = {row[1] for row in verify.query("PRAGMA table_info(txt)")}
    assert "metadata" not in columns
    catalogs = [
        json.loads(brotli.decompress(row[0]))["title"]
        for row in verify.query("SELECT catalog FROM txt ORDER BY id")
    ]
    verify.close()
    assert catalogs == ["Done", "Todo"]


def test_skips_account_with_no_database_yet(tmp_path, creds_path, engine):
    db_master_key = secrets.token_bytes(256)
    db_path = "d" * 52
    _register_account(engine, ADMIN_UID, db_master_key, db_path)
    # No FakeR2Client.objects entry for db_path -- nothing uploaded yet.

    DbUpdater(load_creds(creds_path), tmp_path / "local", NullLogger()).run()

    assert db_path not in FakeR2Client.objects
