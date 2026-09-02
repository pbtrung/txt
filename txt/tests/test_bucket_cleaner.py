import base64

import pytest

from txt.random_token import to_base32_crockford
from txt.sqlite_engine import SqliteEngine

# bucket_cleaner.py still targets the pre-Milestone-9 owner_init.py/
# account_data.py shape (StorageAccount, uid-based ownership) and hasn't
# been rewritten for the D1 design yet (docs/milestones.md Milestone 9).
# importorskip only catches "module not found", not "module found but
# broken internally" -- this one is deliberately broken internally, so
# skip explicitly instead of letting collection fail.
try:
    import txt.bucket_cleaner as bucket_cleaner_module
except ImportError as error:
    pytest.skip(f"pending Milestone 9's D1 rewrite: {error}", allow_module_level=True)
BucketCleaner = bucket_cleaner_module.BucketCleaner

DB_MASTER_KEY = b"k" * 256
ENCODED_DB_MASTER_KEY = base64.b64encode(DB_MASTER_KEY).decode()
OWNER_DB_PATH = "a" * 52
OWNER_DB_PREFIX = "b" * 52


class CapturingLogger:
    def __init__(self):
        self.info_messages = []
        self.verbose_messages = []

    def info(self, message):
        self.info_messages.append(message)

    def verbose(self, message):
        self.verbose_messages.append(message)


class FakeR2Client:
    def __init__(self, objects):
        self.objects = objects
        self.get_calls = []
        self.list_prefixes = []
        self.deleted = []

    def get_object(self, key):
        self.get_calls.append(key)
        return self.objects.get(key)

    def list_keys(self, prefix, on_progress=None):
        self.list_prefixes.append(prefix)
        if on_progress is not None:
            for count in range(1000, len(self.objects) + 1, 1000):
                on_progress(count)
            if len(self.objects) % 1000 or not self.objects:
                on_progress(len(self.objects))
        return list(self.objects)

    def delete_keys(self, keys, on_progress=None):
        for start in range(0, len(keys), 1000):
            self.deleted.extend(keys[start : start + 1000])
            if on_progress is not None:
                on_progress(len(self.deleted))


class FakeSqliteEngine:
    rows_by_database = {}
    tableless_databases = set()
    failing_databases = set()
    instances = []

    def __init__(self):
        self.database = None
        self.key = None
        self.page_size_configured = False
        self.closed = False
        self.__class__.instances.append(self)

    def open(self, key, initial_bytes=None):
        self.key = key
        self.database = initial_bytes

    def exec_sql(self, sql):
        assert sql == "PRAGMA page_size = 16384"
        self.page_size_configured = True

    def query(self, sql, args=None):
        assert self.page_size_configured
        if self.database in self.failing_databases:
            raise ValueError("malformed database")
        if "sqlite_master" in sql:
            return [] if self.database in self.tableless_databases else [[1]]
        assert sql == "SELECT txt_prefix, path FROM txt"
        return self.rows_by_database[self.database]

    def close(self):
        self.closed = True


class FakeOwnerInitializer:
    def __init__(self, uid, payload):
        self._current = (uid, b"u" * 128, payload)

    def load_current_owner(self):
        return self._current


class FailingOwnerInitializer:
    def load_current_owner(self):
        raise ValueError("owner is not provisioned in rqlite")


def account(uid, db_path, db_prefix):
    return (
        uid,
        {
            "db_path": db_path,
            "db_prefix": db_prefix,
            "db_master_key": ENCODED_DB_MASTER_KEY,
        },
    )


def content_key(prefix, txt_prefix, path):
    return f"{prefix}/{to_base32_crockford(txt_prefix)}/{to_base32_crockford(path)}"


def build_cleaner(
    monkeypatch,
    account,
    objects,
    *,
    rows_by_database=None,
    tableless_databases=None,
    failing_databases=None,
    dry_run=False,
    control_backup_prefix="control-backups/",
):
    FakeSqliteEngine.rows_by_database = rows_by_database or {}
    FakeSqliteEngine.tableless_databases = tableless_databases or set()
    FakeSqliteEngine.failing_databases = failing_databases or set()
    FakeSqliteEngine.instances = []
    monkeypatch.setattr(bucket_cleaner_module, "SqliteEngine", FakeSqliteEngine)

    cleaner = object.__new__(BucketCleaner)
    cleaner.logger = CapturingLogger()
    cleaner.dry_run = dry_run
    cleaner.control_backup_prefix = control_backup_prefix
    cleaner.r2 = FakeR2Client(objects)
    if account is None:
        cleaner.owner = FailingOwnerInitializer()
    else:
        uid, payload = account
        cleaner.owner = FakeOwnerInitializer(uid, payload)
    return cleaner


def test_deletes_unreferenced_objects_inside_valid_account_prefix(monkeypatch):
    txt_prefix, path = b"a" * 32, b"b" * 32
    referenced = content_key(OWNER_DB_PREFIX, txt_prefix, path)
    objects = {
        OWNER_DB_PATH: b"owner-database",
        referenced: b"book",
        f"{OWNER_DB_PREFIX}/stale/from-failed-commit": b"stale",
        f"{OWNER_DB_PREFIX}ish/not-owned": b"orphan",
        "orphan": b"orphan",
    }
    cleaner = build_cleaner(
        monkeypatch,
        account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX),
        objects,
        rows_by_database={b"owner-database": [(txt_prefix, path)]},
    )

    cleaner.run()

    assert cleaner.r2.get_calls == [OWNER_DB_PATH]
    assert cleaner.r2.list_prefixes == [""]
    assert cleaner.r2.deleted == [
        f"{OWNER_DB_PREFIX}/stale/from-failed-commit",
        f"{OWNER_DB_PREFIX}ish/not-owned",
        "orphan",
    ]
    assert cleaner.logger.info_messages[-1] == "Deleted 3 object(s)."
    assert all(engine.closed for engine in FakeSqliteEngine.instances)


def test_dry_run_reports_stale_objects_without_deleting(monkeypatch):
    txt_prefix, path = b"a" * 32, b"b" * 32
    referenced = content_key(OWNER_DB_PREFIX, txt_prefix, path)
    cleaner = build_cleaner(
        monkeypatch,
        account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX),
        {
            OWNER_DB_PATH: b"database",
            referenced: b"book",
            f"{OWNER_DB_PREFIX}/stale": b"stale",
        },
        rows_by_database={b"database": [(txt_prefix, path)]},
        dry_run=True,
    )

    cleaner.run()

    assert cleaner.r2.deleted == []
    assert f"Would delete {OWNER_DB_PREFIX}/stale" in cleaner.logger.verbose_messages
    assert cleaner.logger.info_messages[-1] == "Dry run: would delete 1 object(s)."


def test_preserves_every_shared_object_for_the_owner(monkeypatch):
    active_share = f"{OWNER_DB_PREFIX}/shared/{'e' * 52}/{'f' * 52}"
    stale = f"{OWNER_DB_PREFIX}/stale"
    cleaner = build_cleaner(
        monkeypatch,
        account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX),
        {
            OWNER_DB_PATH: b"owner-database",
            active_share: b"active share",
            stale: b"stale",
        },
        rows_by_database={b"owner-database": []},
    )

    cleaner.run()

    assert cleaner.r2.deleted == [stale]
    assert any(
        "3 bucket object(s), 2 retained (1 shared, 0 control backup(s)), 1 stale"
        in message
        for message in cleaner.logger.info_messages
    )


def test_preserves_configured_control_backup_prefix(monkeypatch):
    backup = "private/rqlite/control.sqlite"
    old_default = "control-backups/control.sqlite"
    cleaner = build_cleaner(
        monkeypatch,
        account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX),
        {
            OWNER_DB_PATH: b"owner-database",
            backup: b"backup",
            old_default: b"stale",
        },
        rows_by_database={b"owner-database": []},
        control_backup_prefix="private/rqlite/",
    )

    cleaner.run()

    assert cleaner.r2.deleted == [old_default]


def test_reports_listing_and_deletion_progress_per_thousand_objects(monkeypatch):
    objects = {f"orphan-{index:04d}": b"stale" for index in range(2501)}
    cleaner = build_cleaner(
        monkeypatch, account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX), objects
    )

    cleaner.run()

    for count in ("1,000", "2,000", "2,501"):
        assert f"Listed {count} bucket object(s)..." in cleaner.logger.info_messages
        assert (
            f"Deleted {count}/2,501 stale object(s)..." in cleaner.logger.info_messages
        )


def test_missing_database_means_prefix_has_no_referenced_content(monkeypatch):
    cleaner = build_cleaner(
        monkeypatch,
        account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX),
        {f"{OWNER_DB_PREFIX}/stale": b"stale", "orphan": b"orphan"},
    )

    cleaner.run()

    assert cleaner.r2.get_calls == [OWNER_DB_PATH]
    assert cleaner.r2.deleted == [f"{OWNER_DB_PREFIX}/stale", "orphan"]
    assert FakeSqliteEngine.instances == []
    assert any(
        "no content objects are referenced yet" in message
        for message in cleaner.logger.verbose_messages
    )
    assert any(
        "run --update-db first" in message for message in cleaner.logger.info_messages
    )


def test_database_without_txt_table_references_no_content(monkeypatch):
    cleaner = build_cleaner(
        monkeypatch,
        account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX),
        {
            OWNER_DB_PATH: b"empty-database",
            f"{OWNER_DB_PREFIX}/stale": b"stale",
        },
        tableless_databases={b"empty-database"},
    )

    cleaner.run()

    assert cleaner.r2.deleted == [f"{OWNER_DB_PREFIX}/stale"]
    assert FakeSqliteEngine.instances[0].closed


def test_reads_real_encrypted_database_with_16k_pages():
    txt_prefix, path = b"a" * 32, b"b" * 32
    engine = SqliteEngine()
    engine.open(DB_MASTER_KEY)
    engine.exec_sql("PRAGMA page_size = 16384")
    engine.exec_sql("CREATE TABLE txt (txt_prefix BLOB NOT NULL, path BLOB NOT NULL)")
    engine.execute(
        "INSERT INTO txt (txt_prefix, path) VALUES (?, ?)", [txt_prefix, path]
    )
    database = engine.to_bytes()
    engine.close()

    cleaner = object.__new__(BucketCleaner)
    cleaner.logger = CapturingLogger()
    cleaner.r2 = FakeR2Client({OWNER_DB_PATH: database})

    assert cleaner._content_keys(
        "owner", OWNER_DB_PATH, OWNER_DB_PREFIX, DB_MASTER_KEY
    ) == {content_key(OWNER_DB_PREFIX, txt_prefix, path)}


def test_database_error_aborts_before_bucket_is_listed_or_deleted(monkeypatch):
    cleaner = build_cleaner(
        monkeypatch,
        account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX),
        {
            OWNER_DB_PATH: b"broken-database",
            f"{OWNER_DB_PREFIX}/stale": b"stale",
        },
        failing_databases={b"broken-database"},
    )

    with pytest.raises(ValueError, match="malformed database"):
        cleaner.run()

    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []
    assert FakeSqliteEngine.instances[0].closed


def test_empty_database_object_aborts_before_bucket_is_listed(monkeypatch):
    cleaner = build_cleaner(
        monkeypatch,
        account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX),
        {OWNER_DB_PATH: b"", f"{OWNER_DB_PREFIX}/stale": b"stale"},
    )

    with pytest.raises(ValueError, match="empty database"):
        cleaner.run()

    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []
    assert FakeSqliteEngine.instances == []


def test_refuses_to_clean_when_owner_is_not_provisioned(monkeypatch):
    cleaner = build_cleaner(monkeypatch, None, {"orphan": b"orphan"})

    with pytest.raises(ValueError, match="owner is not provisioned"):
        cleaner.run()

    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []


@pytest.mark.parametrize("field", ["db_path", "db_prefix", "db_master_key"])
def test_refuses_to_clean_when_account_storage_reference_is_invalid(monkeypatch, field):
    uid, payload = account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX)
    payload[field] = ""
    cleaner = build_cleaner(monkeypatch, (uid, payload), {"orphan": b"orphan"})

    with pytest.raises(ValueError, match=field):
        cleaner.run()

    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []


def test_refuses_to_clean_when_database_key_is_not_valid_base64(monkeypatch):
    uid, payload = account("owner", OWNER_DB_PATH, OWNER_DB_PREFIX)
    payload["db_master_key"] = "not base64!"
    cleaner = build_cleaner(monkeypatch, (uid, payload), {"orphan": b"orphan"})

    with pytest.raises(ValueError, match="db_master_key"):
        cleaner.run()

    assert cleaner.r2.get_calls == []
    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []
