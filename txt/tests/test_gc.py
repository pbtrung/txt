import base64
import json
import secrets

import pytest

import txt.account_session as account_session_module
import txt.gc as gc_module
from txt.bb_engine import BBEngine
from txt.creds import load_creds
from txt.crypto_blob import CryptoBlob
from txt.gc import GarbageCollector, SNAPSHOT_EXPIRY_MS

CTL_URL = "libsql://ctl-x.aws-us-east-1.turso.io"
DB_PATH = "0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghj"
AA_URL = f"libsql://{DB_PATH}-x.aws-us-east-1.turso.io"


class NullLogger:
    def verbose(self, message):
        pass

    def info(self, message):
        pass


class FakeFirebaseAuth:
    def __init__(self, api_key):
        pass

    def sign_in(self, email, password):
        return "uid-123"


class FakeTursoClient:
    def __init__(self, org_token, org):
        pass

    def mint_db_token(self, db_name, authorization="full-access"):
        return f"token-for-{db_name}"

    def create_database(self, name, group):
        return {}


def _empty_state():
    return {
        "head_version": 0,
        "page_versions": [],  # [page_no, version_created, version_deleted, data]
        "snapshots": [],  # [snapshot_id, version, heartbeat_at]
        "bundles": [],  # [bundle_key, bundle_enc_key, retired_at]
        "library_index": None,  # object_key or None
    }


class FakeLibsqlClient:
    preset = {}
    instances = {}
    state = {}

    def __init__(self, url, token):
        self.url = url
        self.calls = []
        FakeLibsqlClient.instances[url] = self
        FakeLibsqlClient.state.setdefault(url, _empty_state())

    def execute(self, sql, args=None):
        normalized = " ".join(sql.split())
        self.calls.append(("execute", normalized, args))
        state = FakeLibsqlClient.state[self.url]
        if "DELETE FROM snapshots WHERE snapshot_id" in normalized:
            snapshot_id = args[0]
            state["snapshots"] = [s for s in state["snapshots"] if s[0] != snapshot_id]
        elif "DELETE FROM page_versions WHERE page_no" in normalized:
            page_no, version_created = args
            state["page_versions"] = [
                pv for pv in state["page_versions"] if not (pv[0] == page_no and pv[1] == version_created)
            ]
        elif "DELETE FROM bundles" in normalized:
            wrapped_key = args[0]
            state["bundles"] = [b for b in state["bundles"] if b[0] != wrapped_key]
        return {}

    def batch(self, statements):
        for sql, args in statements:
            self.execute(sql, args)

    def query(self, sql, args=None):
        normalized = " ".join(sql.split())
        self.calls.append(("query", normalized, args))
        state = FakeLibsqlClient.state[self.url]
        if "SELECT head_version FROM meta" in normalized:
            return [[state["head_version"]]]
        if "SELECT snapshot_id FROM snapshots" in normalized:
            cutoff = args[0]
            return [[s[0]] for s in state["snapshots"] if s[2] < cutoff]
        if "SELECT MIN(version) FROM snapshots" in normalized:
            versions = [s[1] for s in state["snapshots"]]
            return [[min(versions) if versions else None]]
        if "SELECT page_no, version_created FROM page_versions" in normalized:
            horizon = args[0]
            return [
                [pv[0], pv[1]]
                for pv in state["page_versions"]
                if pv[2] is not None and pv[2] <= horizon
            ]
        if "SELECT bundle_key, bundle_enc_key, retired_at FROM bundles" in normalized:
            return [[b[0], b[1], b[2]] for b in state["bundles"]]
        if "SELECT object_key FROM library_index" in normalized:
            return [[state["library_index"]]] if state["library_index"] is not None else []
        if "SELECT page_no, data FROM page_versions" in normalized:
            hv = state["head_version"]
            return [
                [pv[0], pv[3]]
                for pv in state["page_versions"]
                if pv[1] <= hv and (pv[2] is None or pv[2] > hv)
            ]
        for needle, rows in FakeLibsqlClient.preset.get(self.url, {}).items():
            if needle in normalized:
                return rows
        return []


class FakeR2Client:
    instances = []
    store = {}

    def __init__(self, config):
        FakeR2Client.instances.append(self)

    def put_object(self, key, body):
        FakeR2Client.store[key] = body

    def list_keys(self, prefix):
        return [k for k in FakeR2Client.store if k.startswith(prefix)]

    def delete_keys(self, keys):
        for key in keys:
            FakeR2Client.store.pop(key, None)


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(account_session_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(account_session_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(account_session_module, "LibsqlClient", FakeLibsqlClient)
    monkeypatch.setattr(gc_module, "R2Client", FakeR2Client)
    FakeLibsqlClient.preset = {}
    FakeLibsqlClient.instances = {}
    FakeLibsqlClient.state = {}
    FakeR2Client.instances = []
    FakeR2Client.store = {}
    yield


@pytest.fixture
def account(engine, tmp_path):
    blob = CryptoBlob(engine)
    root_key = secrets.token_bytes(256)
    umk = secrets.token_bytes(128)
    db_master_key = secrets.token_bytes(256)
    db_prefix = "dbprefix1234"

    wrapped_umk = blob.encrypt(umk, root_key)
    wrapped_db_prefix = blob.encrypt(db_prefix.encode(), umk)
    payload = {"display_name": "Trung", "db_master_key": base64.b64encode(db_master_key).decode()}
    wrapped_cred = blob.encrypt_json(payload, umk)

    data = {
        "turso_org_token": "tok", "turso_ctl_db_url": CTL_URL, "turso_group": "g", "turso_org": "x",
        "firebase_email": "a@b.com", "firebase_password": "pw", "firebase_api_key": "key",
        "display_name": "Trung", "user_root_key": base64.b64encode(root_key).decode(),
        "r2_config": {
            "endpoint": "https://x.r2.cloudflarestorage.com", "read_only_access_key_id": "ro",
            "read_only_secret_access_key": "ro-secret", "read_write_access_key_id": "rw",
            "read_write_secret_access_key": "rw-secret", "region": "auto", "bucket": "my-bucket",
        },
    }
    creds_path = tmp_path / "creds.json"
    creds_path.write_text(json.dumps(data))

    FakeLibsqlClient.preset[CTL_URL] = {"SELECT db_path, type": [[DB_PATH, "user"]]}
    FakeLibsqlClient.preset[AA_URL] = {
        "SELECT umk FROM key_store": [[wrapped_umk]],
        "SELECT db_prefix FROM meta": [[wrapped_db_prefix]],
        "SELECT content FROM cred_store WHERE id = 1": [[wrapped_cred]],
    }
    FakeLibsqlClient.state[AA_URL] = _empty_state()
    return {
        "creds_path": str(creds_path),
        "db_prefix": db_prefix,
        "umk": umk,
        "db_master_key": db_master_key,
        "blob": blob,
    }


def _state():
    return FakeLibsqlClient.state[AA_URL]


def _bundle_row(blob, umk, key, retired_at):
    bundle_enc_key = secrets.token_bytes(128)
    wrapped_key = blob.encrypt(key.encode(), bundle_enc_key)
    wrapped_enc_key = blob.encrypt(bundle_enc_key, umk)
    return [wrapped_key, wrapped_enc_key, retired_at]


def _seed_live_doc(db_master_key, prefix_str):
    """Builds a real BB with one txt row (prefix=prefix_str), returns its
    dirty pages so a test can seed them into the fake AA's page_versions."""
    bb = BBEngine()
    bb.open(db_master_key)
    bb.exec_sql(
        "CREATE TABLE txt (id INTEGER PRIMARY KEY AUTOINCREMENT, txt_key BLOB NOT NULL, "
        "prefix BLOB NOT NULL, name TEXT NOT NULL, n_parts INTEGER NOT NULL, created_at INTEGER NOT NULL)"
    )
    bb.execute(
        "INSERT INTO txt (txt_key, prefix, name, n_parts, created_at) VALUES (?, ?, ?, ?, ?)",
        [secrets.token_bytes(128), prefix_str.encode(), "book.epub", 1, 0],
    )
    pages = dict(bb.dirty_pages)
    bb.close()
    return pages


def _real_pages(db_master_key: bytes) -> dict:
    """Every dirtied page from a tiny real CREATE TABLE -- GarbageCollector
    always opens BB (for the t/ orphan sweep), and SQLite's own page-1
    header records the database's total page count, so loading page 1
    alone without its sibling pages trips SQLite's own consistency check
    ('database disk image is malformed'). A test seeding 'live' page_versions
    rows needs every page this produces, not just page 1.
    """
    bb = BBEngine()
    bb.open(db_master_key)
    bb.exec_sql("CREATE TABLE t (a)")
    pages = dict(bb.dirty_pages)
    bb.close()
    return pages


def _seed_pages(pages: dict, version: int) -> None:
    state = _state()
    for page_no, data in pages.items():
        state["page_versions"].append([page_no, version, None, data])
    state["head_version"] = max(state["head_version"], version)


def test_gc_deletes_superseded_pages_keeps_live(account):
    state = _state()
    state["head_version"] = 5
    live_pages = _real_pages(account["db_master_key"])
    state["page_versions"] = [[1, 3, 5, b"old"]] + [
        [page_no, 5, None, data] for page_no, data in live_pages.items()
    ]

    GarbageCollector(load_creds(account["creds_path"]), NullLogger()).run()

    superseded_gone = not any(pv[0] == 1 and pv[1] == 3 for pv in state["page_versions"])
    live_intact = all(
        any(pv[0] == page_no and pv[2] is None for pv in state["page_versions"])
        for page_no in live_pages
    )
    assert superseded_gone
    assert live_intact


def test_gc_respects_live_snapshot_horizon(account):
    state = _state()
    state["head_version"] = 5
    live_pages = _real_pages(account["db_master_key"])
    state["page_versions"] = [[1, 3, 4, b"old"]] + [
        [page_no, 4, None, data] for page_no, data in live_pages.items()
    ]
    state["snapshots"] = [["snap-1", 3, 9_999_999_999_999]]  # far-future heartbeat_at (ms), never expires

    GarbageCollector(load_creds(account["creds_path"]), NullLogger()).run()

    # gc_horizon pinned at 3 by the live snapshot: version_deleted=4 > 3, not deletable
    superseded_still_present = any(pv[0] == 1 and pv[1] == 3 for pv in state["page_versions"])
    assert superseded_still_present


def test_gc_expires_stale_snapshots(account):
    state = _state()
    now = 10_000_000_000
    state["snapshots"] = [
        ["stale", 1, now - SNAPSHOT_EXPIRY_MS - 1],
        ["fresh", 1, now],
    ]
    import time as time_module

    monkeypatch_time = now / 1000.0

    class FakeTime:
        @staticmethod
        def time():
            return monkeypatch_time

    original_time = gc_module.time
    gc_module.time = FakeTime()
    try:
        GarbageCollector(load_creds(account["creds_path"]), NullLogger()).run()
    finally:
        gc_module.time = original_time

    remaining_ids = {s[0] for s in state["snapshots"]}
    assert remaining_ids == {"fresh"}


def test_gc_deletes_retired_bundle_object_and_row_keeps_live(account):
    db_prefix, blob, umk = account["db_prefix"], account["blob"], account["umk"]
    state = _state()
    live_row = _bundle_row(blob, umk, "live-key", None)
    retired_row = _bundle_row(blob, umk, "retired-key", 123)
    state["bundles"] = [live_row, retired_row]
    FakeR2Client.store = {
        f"{db_prefix}/b/live-key": b"live-bytes",
        f"{db_prefix}/b/retired-key": b"retired-bytes",
    }

    GarbageCollector(load_creds(account["creds_path"]), NullLogger()).run()

    assert list(FakeR2Client.store) == [f"{db_prefix}/b/live-key"]
    assert [b[0] for b in state["bundles"]] == [live_row[0]]


def test_gc_sweeps_bundle_orphan_object_with_no_row(account):
    db_prefix = account["db_prefix"]
    FakeR2Client.store = {f"{db_prefix}/b/orphan-key": b"orphan-bytes"}

    GarbageCollector(load_creds(account["creds_path"]), NullLogger()).run()

    assert FakeR2Client.store == {}


def test_gc_sweeps_library_index_orphan_keeps_live_object(account):
    db_prefix, blob, umk = account["db_prefix"], account["blob"], account["umk"]
    state = _state()
    state["library_index"] = blob.encrypt(b"live-index-key", umk)
    FakeR2Client.store = {
        f"{db_prefix}/i/live-index-key": b"live-index-bytes",
        f"{db_prefix}/i/stale-index-key": b"stale-index-bytes",
    }

    GarbageCollector(load_creds(account["creds_path"]), NullLogger()).run()

    assert list(FakeR2Client.store) == [f"{db_prefix}/i/live-index-key"]


def test_gc_sweeps_orphaned_document_parts_keeps_live_document(account):
    db_prefix, db_master_key = account["db_prefix"], account["db_master_key"]
    pages = _seed_live_doc(db_master_key, "live-doc-prefix")
    _seed_pages(pages, version=1)
    FakeR2Client.store = {
        f"{db_prefix}/t/live-doc-prefix/part-a": b"live-part",
        f"{db_prefix}/t/orphan-doc-prefix/part-b": b"orphan-part",
    }

    GarbageCollector(load_creds(account["creds_path"]), NullLogger()).run()

    assert list(FakeR2Client.store) == [f"{db_prefix}/t/live-doc-prefix/part-a"]
