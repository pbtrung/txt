import base64
import json
import secrets

import pytest

import txt.account_session as account_session_module
import txt.ingest as ingest_module
from txt.creds import load_creds
from txt.crypto_blob import CryptoBlob
from txt.ingest import MAX_PART_SIZE, TxtIngester, split_parts

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


class FakeAaState:
    """A minimal, stateful stand-in for the handful of meta/page_versions
    statements _flush_pages issues -- real enough that a second
    TxtIngester run against the same url sees the first run's writes,
    which is what actually proves resumability.
    """

    def __init__(self):
        self.head_version = 0
        self.pages = {}  # page_no -> (version_created, version_deleted, data)
        self.bundles = []  # list of dicts, newest last
        self.library_index = None  # dict or None

    def apply(self, sql: str, args: list) -> None:
        if "UPDATE meta SET head_version" in sql:
            self.head_version = args[0]
        elif "INSERT INTO page_versions" in sql:
            page_no, version_created, data = args
            self.pages[page_no] = (version_created, None, data)
        elif "UPDATE page_versions SET version_deleted" in sql:
            version, page_no = args[0], args[1]
            if page_no in self.pages:
                vc, _vd, data = self.pages[page_no]
                self.pages[page_no] = (vc, version, data)
        elif "INSERT INTO bundles" in sql:
            keys = [
                "bundle_key",
                "bundle_enc_key",
                "built_at_version",
                "byte_size",
                "map_rows",
                "page_count",
                "built_at",
            ]
            self.bundles.append({**dict(zip(keys, args)), "retired_at": None})
        elif "UPDATE bundles SET retired_at" in sql:
            retired_at, bundle_key = args
            for bundle in self.bundles:
                if bundle["bundle_key"] == bundle_key:
                    bundle["retired_at"] = retired_at
        elif "INSERT INTO library_index" in sql:
            keys = [
                "object_key",
                "lib_idx_key",
                "built_at_version",
                "byte_size",
                "doc_count",
                "content_hash",
                "built_at",
            ]
            self.library_index = dict(zip(keys, args))
        elif "UPDATE library_index SET built_at_version" in sql:
            built_at_version, byte_size, doc_count, content_hash, built_at = args
            self.library_index.update(
                built_at_version=built_at_version,
                byte_size=byte_size,
                doc_count=doc_count,
                content_hash=content_hash,
                built_at=built_at,
            )

    def live_pages(self) -> list:
        hv = self.head_version
        return [
            [page_no, data]
            for page_no, (vc, vd, data) in self.pages.items()
            if vc <= hv and (vd is None or vd > hv)
        ]

    def live_pages_with_version(self) -> list:
        hv = self.head_version
        return [
            [page_no, vc, data]
            for page_no, (vc, vd, data) in self.pages.items()
            if vc <= hv and (vd is None or vd > hv)
        ]

    def live_bundle(self) -> list:
        for bundle in self.bundles:
            if bundle["retired_at"] is None:
                return [[bundle["bundle_key"], bundle["built_at_version"]]]
        return []

    def changed_page_count(self, since_version: int) -> int:
        return sum(
            1
            for _pn, (vc, vd, _d) in self.pages.items()
            if vc > since_version or (vd or 0) > since_version
        )

    def library_index_row(self) -> list:
        if self.library_index is None:
            return []
        li = self.library_index
        return [[li["object_key"], li["lib_idx_key"], li["built_at_version"]]]


class FakeLibsqlClient:
    preset = {}
    instances = {}
    states = {}

    def __init__(self, url, token):
        self.url = url
        self.calls = []
        FakeLibsqlClient.instances[url] = self
        FakeLibsqlClient.states.setdefault(url, FakeAaState())

    def execute(self, sql, args=None):
        normalized = " ".join(sql.split())
        self.calls.append(("execute", normalized, args))
        FakeLibsqlClient.states[self.url].apply(normalized, args or [])
        return {}

    def batch(self, statements):
        for sql, args in statements:
            self.execute(sql, args)

    def query(self, sql, args=None):
        normalized = " ".join(sql.split())
        self.calls.append(("query", normalized, args))
        state = FakeLibsqlClient.states[self.url]
        if "SELECT head_version FROM meta" in normalized:
            return [[state.head_version]]
        if "SELECT page_no, data FROM page_versions" in normalized:
            return state.live_pages()
        if "SELECT page_no, version_created, data FROM page_versions" in normalized:
            return state.live_pages_with_version()
        if "SELECT bundle_key, built_at_version FROM bundles" in normalized:
            return state.live_bundle()
        if "SELECT COUNT(DISTINCT page_no) FROM page_versions" in normalized:
            return [[state.changed_page_count(args[0])]]
        if (
            "SELECT object_key, lib_idx_key, built_at_version FROM library_index"
            in normalized
        ):
            return state.library_index_row()
        for needle, rows in FakeLibsqlClient.preset.get(self.url, {}).items():
            if needle in normalized:
                return rows
        return []


class FakeR2Client:
    instances = []
    should_fail = False

    def __init__(self, config):
        self.put_calls = []
        FakeR2Client.instances.append(self)

    def put_object(self, key, body):
        if FakeR2Client.should_fail:
            raise RuntimeError("simulated upload failure")
        self.put_calls.append((key, body))


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(account_session_module, "FirebaseAuth", FakeFirebaseAuth)
    monkeypatch.setattr(account_session_module, "TursoClient", FakeTursoClient)
    monkeypatch.setattr(account_session_module, "LibsqlClient", FakeLibsqlClient)
    monkeypatch.setattr(ingest_module, "R2Client", FakeR2Client)
    FakeLibsqlClient.preset = {}
    FakeLibsqlClient.instances = {}
    FakeLibsqlClient.states = {}
    FakeR2Client.instances = []
    FakeR2Client.should_fail = False
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
    payload = {
        "display_name": "Trung",
        "db_master_key": base64.b64encode(db_master_key).decode(),
    }
    wrapped_cred = blob.encrypt_json(payload, umk)

    data = {
        "turso_org_token": "tok",
        "turso_ctl_db_url": CTL_URL,
        "turso_group": "g",
        "turso_org": "x",
        "firebase_email": "a@b.com",
        "firebase_password": "pw",
        "firebase_api_key": "key",
        "display_name": "Trung",
        "user_root_key": base64.b64encode(root_key).decode(),
        "r2_config": {
            "endpoint": "https://x.r2.cloudflarestorage.com",
            "read_only_access_key_id": "ro",
            "read_only_secret_access_key": "ro-secret",
            "read_write_access_key_id": "rw",
            "read_write_secret_access_key": "rw-secret",
            "region": "auto",
            "bucket": "my-bucket",
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
    return str(creds_path), db_prefix


def _write_epub(directory, name, size):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(secrets.token_bytes(size))
    return path


def _calls_under(r2, db_prefix, population):
    return [c for c in r2.put_calls if c[0].startswith(f"{db_prefix}/{population}/")]


def test_split_parts_within_range_for_large_file():
    for size in (100_000, 250_000, 1_000_000, 3_333_333):
        parts = split_parts(size)
        assert sum(length for _, length in parts) == size
        assert all(49999 <= length <= MAX_PART_SIZE for _, length in parts[:-1])


def test_split_parts_single_small_file():
    assert split_parts(1000) == [(0, 1000)]


def test_ingest_uploads_part_and_writes_bb_row(account, tmp_path):
    creds_path, db_prefix = account
    src = tmp_path / "src"
    _write_epub(src, "book1.epub", 1000)

    TxtIngester(src, load_creds(creds_path), NullLogger()).run()

    r2 = FakeR2Client.instances[-1]
    part_calls = _calls_under(r2, db_prefix, "t")
    assert len(part_calls) == 1
    key, body = part_calls[0]
    assert key.startswith(f"{db_prefix}/t/")
    assert body != b"\x00" * len(body)  # actually encrypted, not the zero-filled buffer

    aa = FakeLibsqlClient.instances[AA_URL]
    version_inserts = [
        c for c in aa.calls if c[0] == "execute" and "INSERT INTO versions" in c[1]
    ]
    head_updates = [
        c
        for c in aa.calls
        if c[0] == "execute" and "UPDATE meta SET head_version" in c[1]
    ]
    assert len(version_inserts) == 1
    assert len(head_updates) == 1


def test_ingest_skips_already_ingested_filename(account, tmp_path):
    creds_path, db_prefix = account
    src = tmp_path / "src"
    _write_epub(src, "book1.epub", 1000)

    TxtIngester(src, load_creds(creds_path), NullLogger()).run()
    first_upload_count = len(_calls_under(FakeR2Client.instances[-1], db_prefix, "t"))

    TxtIngester(src, load_creds(creds_path), NullLogger()).run()
    second_upload_count = len(_calls_under(FakeR2Client.instances[-1], db_prefix, "t"))

    assert first_upload_count == 1
    assert second_upload_count == 0


def test_failed_upload_leaves_no_bb_row_or_aa_flush(account, tmp_path):
    creds_path, _ = account
    src = tmp_path / "src"
    _write_epub(src, "book1.epub", 1000)
    FakeR2Client.should_fail = True

    ingester = TxtIngester(src, load_creds(creds_path), NullLogger())
    ingester.run()

    assert ingester.bb.query("SELECT name FROM txt") == []
    aa = FakeLibsqlClient.instances[AA_URL]
    assert [
        c for c in aa.calls if c[0] == "execute" and "INSERT INTO versions" in c[1]
    ] == []


def test_ingest_writes_opf_metadata(account, tmp_path):
    creds_path, _ = account
    src = tmp_path / "src"
    _write_epub(src, "book1.epub", 1000)
    (src / "book1.opf").write_text(
        '<package><metadata xmlns:dc="urn:dc"><dc:title>My Title</dc:title></metadata></package>'
    )

    ingester = TxtIngester(src, load_creds(creds_path), NullLogger())
    ingester.run()

    rows = ingester.bb.query("SELECT metadata FROM txt_meta")
    assert len(rows) == 1


def test_ingest_splits_large_file_into_multiple_parts(account, tmp_path):
    creds_path, db_prefix = account
    src = tmp_path / "src"
    _write_epub(src, "big.epub", 150_000)

    TxtIngester(src, load_creds(creds_path), NullLogger()).run()

    r2 = FakeR2Client.instances[-1]
    assert len(_calls_under(r2, db_prefix, "t")) == len(split_parts(150_000))


def test_ingest_builds_bundle_and_library_index(account, tmp_path):
    creds_path, db_prefix = account
    src = tmp_path / "src"
    _write_epub(src, "book1.epub", 1000)

    TxtIngester(src, load_creds(creds_path), NullLogger()).run()

    r2 = FakeR2Client.instances[-1]
    assert len(_calls_under(r2, db_prefix, "b")) == 1
    assert len(_calls_under(r2, db_prefix, "i")) == 1

    aa = FakeLibsqlClient.instances[AA_URL]
    state = FakeLibsqlClient.states[AA_URL]
    assert len(state.bundles) == 1
    assert state.bundles[0]["built_at_version"] == state.head_version
    assert state.library_index["built_at_version"] == state.head_version
    bundle_inserts = [
        c for c in aa.calls if c[0] == "execute" and "INSERT INTO bundles" in c[1]
    ]
    assert len(bundle_inserts) == 1


def test_scan_hot_page_nos_matches_real_dbstat(account, tmp_path):
    creds_path, _db_prefix = account
    src = tmp_path / "src"
    _write_epub(src, "book1.epub", 1000)

    ingester = TxtIngester(src, load_creds(creds_path), NullLogger())
    ingester.run()

    hot = ingester._scan_hot_page_nos()
    assert 1 in hot  # page 1 is always hot

    internal_pages = {
        pageno
        for _name, pageno, pagetype in ingester.bb.query("SELECT name, pageno, pagetype FROM dbstat")
        if pagetype == "internal"
    }
    assert internal_pages <= hot  # every btree interior page must be carried


def test_ingest_rerun_with_no_new_files_skips_derived_rebuild(account, tmp_path):
    creds_path, db_prefix = account
    src = tmp_path / "src"
    _write_epub(src, "book1.epub", 1000)

    TxtIngester(src, load_creds(creds_path), NullLogger()).run()
    TxtIngester(src, load_creds(creds_path), NullLogger()).run()

    r2 = FakeR2Client.instances[-1]
    assert len(_calls_under(r2, db_prefix, "b")) == 0
    assert len(_calls_under(r2, db_prefix, "i")) == 0
    assert len(FakeLibsqlClient.states[AA_URL].bundles) == 1


def test_library_index_derived_rebuild_failure_does_not_crash_ingest(account, tmp_path):
    creds_path, _ = account
    src = tmp_path / "src"
    _write_epub(src, "book1.epub", 1000)
    FakeR2Client.should_fail = True

    ingester = TxtIngester(src, load_creds(creds_path), NullLogger())
    ingester.run()  # must not raise: derived-artifact failures are logged, not fatal

    assert ingester.bb.query("SELECT name FROM txt") == []
