import json
import secrets
import zipfile

import brotli
import pytest

import txt.ingest as ingest_module
from txt.account_session import Account
from txt.creds import Creds
from txt.ingest import TxtIngester
from txt.r2_client import R2Object, R2PreconditionFailed
from txt.sqlite_engine import SqliteEngine


class NullLogger:
    def verbose(self, message):
        pass

    def info(self, message):
        pass


ACCOUNT = Account(
    uid="uid-123",
    account_type="user",
    display_name="Trung",
    db_master_key=secrets.token_bytes(256),
    db_path="d" * 52,
    db_prefix="p" * 52,
)


class FakeAccountSession:
    def __init__(self, creds, logger):
        pass

    def connect(self):
        return ACCOUNT


class FakeR2Client:
    objects = {}
    versions = {}
    conflict_keys = set()

    def __init__(self, config):
        self.put_calls = []
        self.put_conditions = []

    def get_object_with_etag(self, key):
        if key not in self.objects:
            return None
        version = self.versions.setdefault(key, 1)
        return R2Object(self.objects[key], f'"v{version}"')

    def get_object(self, key):
        return self.objects.get(key)

    def put_object(self, key, body, *, if_match=None, if_none_match=False):
        if key in self.conflict_keys:
            self.conflict_keys.remove(key)
            self.versions[key] = self.versions.get(key, 1) + 1
        current = self.objects.get(key)
        current_etag = (
            f'"v{self.versions.setdefault(key, 1)}"' if current is not None else None
        )
        if if_match is not None and if_match != current_etag:
            raise R2PreconditionFailed("conflicted with a newer object")
        if if_none_match and current is not None:
            raise R2PreconditionFailed("conflicted with a newer object")
        self.put_calls.append((key, body))
        self.put_conditions.append((key, if_match, if_none_match))
        self.objects[key] = body
        self.versions[key] = self.versions.get(key, 0) + 1


@pytest.fixture(autouse=True)
def patch_clients(monkeypatch):
    monkeypatch.setattr(ingest_module, "AccountSession", FakeAccountSession)
    monkeypatch.setattr(ingest_module, "R2Client", FakeR2Client)
    FakeR2Client.objects = {}
    FakeR2Client.versions = {}
    FakeR2Client.conflict_keys = set()


CREDS = Creds(
    turso_org_token="tok",
    turso_ctl_db_name="ctlname",
    turso_ctl_db_url="libsql://ctlname-x.aws-us-east-1.turso.io",
    firebase_email="a@b.com",
    firebase_password="pw",
    firebase_api_key="key",
    user_root_key="ignored-by-fake-session",
)


def _write_epub(path, content=b"epub bytes"):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("content.opf", "<package><metadata/></package>")
    path.write_bytes(path.read_bytes() + content)  # pad so different epubs differ


def _reopen(local_path):
    # run() closes its own engine at the end, so verification reopens a
    # fresh, independent engine rather than reusing it. SQLCipher's page-1
    # salt overwrites the bytes SQLite would otherwise auto-detect the page
    # size from, so the pragma must be reissued (matching ingest.py's own
    # _ensure_schema, which does this on every run) before any other read.
    engine = SqliteEngine()
    engine.open(ACCOUNT.db_master_key, initial_bytes=local_path.read_bytes())
    engine.exec_sql(ingest_module.SET_PAGE_SIZE_SQL)
    return engine


def _txt_rows_from_disk(local_path):
    engine = _reopen(local_path)
    try:
        return [
            json.loads(brotli.decompress(row[0]))
            for row in engine.query("SELECT catalog FROM txt")
        ]
    finally:
        engine.close()


def test_fresh_database_gets_16kib_page_size(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub")

    ingester = TxtIngester(src, local, CREDS, NullLogger())
    ingester.run()

    engine = _reopen(local / ACCOUNT.db_path)
    try:
        assert int(engine.query("PRAGMA page_size")[0][0]) == 16384
        assert "last_cfi" in {row[1] for row in engine.query("PRAGMA table_info(txt)")}
        bookmark_columns = {
            row[1] for row in engine.query("PRAGMA table_info(txt_bookmarks)")
        }
        assert "cfi" in bookmark_columns
        assert "line" not in bookmark_columns
        [(bookmark_sql,)] = engine.query(
            "SELECT sql FROM sqlite_master "
            "WHERE type = 'table' AND name = 'txt_bookmarks'"
        )
        assert "AUTOINCREMENT" in bookmark_sql
        assert "<= 100" in bookmark_sql
    finally:
        engine.close()


def test_ingest_fresh_directory(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")
    _write_epub(src / "b.epub", b"two")

    ingester = TxtIngester(src, local, CREDS, NullLogger())
    ingester.run()

    local_path = local / ACCOUNT.db_path
    assert local_path.exists()
    assert ingester.r2.put_calls  # at least the content objects + final db upload

    names = {p["name"] for p in _txt_rows_from_disk(local_path)}
    assert names == {"a.epub", "b.epub"}


def test_ingest_records_opf_sidecar_catalog_fields(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub")
    (src / "a.opf").write_text(
        '<package><metadata xmlns:dc="urn:dc"><dc:title>Hello</dc:title>'
        "<dc:creator>Frank Herbert</dc:creator>"
        "<dc:publisher>Ace</dc:publisher>"
        "</metadata></package>"
    )

    ingester = TxtIngester(src, local, CREDS, NullLogger())
    ingester.run()

    payloads = _txt_rows_from_disk(local / ACCOUNT.db_path)
    assert payloads == [
        {
            "name": "a.epub",
            "title": "Hello",
            "authors": ["Frank Herbert"],
            "subjects": [],
            "publisher": "Ace",
        }
    ]


def test_ingest_collects_repeated_authors_and_subjects(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub")
    (src / "a.opf").write_text(
        '<package><metadata xmlns:dc="urn:dc">'
        "<dc:creator>Terry Pratchett</dc:creator>"
        "<dc:creator>Neil Gaiman</dc:creator>"
        "<dc:subject>Fantasy</dc:subject>"
        "<dc:subject>Humor</dc:subject>"
        "</metadata></package>"
    )

    ingester = TxtIngester(src, local, CREDS, NullLogger())
    ingester.run()

    [payload] = _txt_rows_from_disk(local / ACCOUNT.db_path)
    assert payload["authors"] == ["Terry Pratchett", "Neil Gaiman"]
    assert payload["subjects"] == ["Fantasy", "Humor"]
    assert payload["publisher"] is None
    assert payload["title"] == "a.epub"  # no dc:title -> falls back to the filename


def test_ingest_uploads_one_object_per_epub_plus_final_db(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")
    _write_epub(src / "b.epub", b"two")

    ingester = TxtIngester(src, local, CREDS, NullLogger())
    ingester.run()

    content_puts = [k for k, _ in ingester.r2.put_calls if k != ACCOUNT.db_path]
    db_puts = [k for k, _ in ingester.r2.put_calls if k == ACCOUNT.db_path]
    assert len(content_puts) == 2
    assert len(db_puts) == 1
    assert all(k.startswith(f"{ACCOUNT.db_prefix}/") for k in content_puts)
    assert (ACCOUNT.db_path, None, True) in ingester.r2.put_conditions


def test_second_run_skips_already_ingested_files(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")

    TxtIngester(src, local, CREDS, NullLogger()).run()

    _write_epub(src / "b.epub", b"two")
    second = TxtIngester(src, local, CREDS, NullLogger())
    second.run()

    names = {p["name"] for p in _txt_rows_from_disk(local / ACCOUNT.db_path)}
    assert names == {"a.epub", "b.epub"}
    content_puts = [k for k, _ in second.r2.put_calls if k != ACCOUNT.db_path]
    assert len(content_puts) == 1  # only b.epub uploaded this run


def test_downloads_r2_even_when_a_local_checkpoint_exists(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")
    TxtIngester(src, local, CREDS, NullLogger()).run()

    third = TxtIngester(src, local, CREDS, NullLogger())
    monkeypatch_calls = []
    real_get_object = FakeR2Client.get_object_with_etag

    def spy_get_object(self, key):
        monkeypatch_calls.append(key)
        return real_get_object(self, key)

    third.r2.get_object_with_etag = spy_get_object.__get__(third.r2, FakeR2Client)
    third.run()
    assert monkeypatch_calls == [ACCOUNT.db_path]
    assert not [key for key, _ in third.r2.put_calls if key == ACCOUNT.db_path]


def test_vacuum_runs_before_final_upload(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub")

    ingester = TxtIngester(src, local, CREDS, NullLogger())
    ingester.run()

    uploaded = dict(ingester.r2.put_calls)[ACCOUNT.db_path]
    assert uploaded == (local / ACCOUNT.db_path).read_bytes()


def test_conditional_db_upload_preserves_a_concurrent_browser_change(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    src.mkdir()
    _write_epub(src / "a.epub", b"one")
    TxtIngester(src, local, CREDS, NullLogger()).run()
    remote_before = FakeR2Client.objects[ACCOUNT.db_path]

    _write_epub(src / "b.epub", b"two")
    FakeR2Client.conflict_keys.add(ACCOUNT.db_path)
    with pytest.raises(R2PreconditionFailed, match="newer object"):
        TxtIngester(src, local, CREDS, NullLogger()).run()

    assert FakeR2Client.objects[ACCOUNT.db_path] == remote_before
