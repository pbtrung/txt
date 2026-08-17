import base64

import pytest

import txt.bucket_cleaner as bucket_cleaner_module
from txt.bucket_cleaner import BucketCleaner
from txt.random_token import to_base32_crockford

DB_MASTER_KEY = b"k" * 256
ENCODED_DB_MASTER_KEY = base64.b64encode(DB_MASTER_KEY).decode()


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

    def list_keys(self, prefix):
        self.list_prefixes.append(prefix)
        return list(self.objects)

    def delete_keys(self, keys):
        self.deleted.extend(keys)


class FakeSqliteEngine:
    rows_by_database = {}
    tableless_databases = set()
    failing_databases = set()
    instances = []

    def __init__(self):
        self.database = None
        self.key = None
        self.closed = False
        self.__class__.instances.append(self)

    def open(self, key, initial_bytes=None):
        self.key = key
        self.database = initial_bytes

    def query(self, sql):
        if self.database in self.failing_databases:
            raise ValueError("malformed database")
        if "sqlite_master" in sql:
            return [] if self.database in self.tableless_databases else [[1]]
        assert sql == "SELECT txt_prefix, path FROM txt"
        return self.rows_by_database[self.database]

    def close(self):
        self.closed = True


class FakeCtl:
    def __init__(self, user_ids, account_rows):
        self.user_ids = user_ids
        self.account_rows = account_rows

    def query(self, sql, args=None):
        if sql == "SELECT id FROM users":
            return [[uid] for uid in self.user_ids]
        return self.account_rows


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
    accounts,
    objects,
    *,
    rows_by_database=None,
    tableless_databases=None,
    failing_databases=None,
    dry_run=False,
):
    FakeSqliteEngine.rows_by_database = rows_by_database or {}
    FakeSqliteEngine.tableless_databases = tableless_databases or set()
    FakeSqliteEngine.failing_databases = failing_databases or set()
    FakeSqliteEngine.instances = []
    monkeypatch.setattr(bucket_cleaner_module, "SqliteEngine", FakeSqliteEngine)

    cleaner = object.__new__(BucketCleaner)
    cleaner.logger = CapturingLogger()
    cleaner.dry_run = dry_run
    cleaner.r2 = FakeR2Client(objects)
    cleaner._sign_in = lambda: "admin"
    cleaner._connect_ctl = lambda: object()
    cleaner._admin_umk = lambda ctl, uid: b"umk"
    cleaner._reachable_accounts = lambda ctl, uid, umk: accounts
    return cleaner


def test_deletes_unreferenced_objects_inside_valid_account_prefixes(monkeypatch):
    admin_txt_prefix, admin_path = b"a" * 32, b"b" * 32
    user_txt_prefix, user_path = b"c" * 32, b"d" * 32
    admin_content = content_key("books-admin", admin_txt_prefix, admin_path)
    user_content = content_key("books-user", user_txt_prefix, user_path)
    accounts = [
        account("admin", "db-admin", "books-admin"),
        account("user", "db-user", "books-user"),
    ]
    objects = {
        "db-admin": b"admin-database",
        admin_content: b"book",
        "books-admin/stale/from-failed-commit": b"stale",
        "db-user": b"user-database",
        user_content: b"book",
        "books-user/": b"stale folder marker",
        "books-userish/not-owned": b"orphan",
        "orphan": b"orphan",
    }
    cleaner = build_cleaner(
        monkeypatch,
        accounts,
        objects,
        rows_by_database={
            b"admin-database": [(admin_txt_prefix, admin_path)],
            b"user-database": [(user_txt_prefix, user_path)],
        },
    )

    cleaner.run()

    assert cleaner.r2.get_calls == ["db-admin", "db-user"]
    assert cleaner.r2.list_prefixes == [""]
    assert cleaner.r2.deleted == [
        "books-admin/stale/from-failed-commit",
        "books-user/",
        "books-userish/not-owned",
        "orphan",
    ]
    assert cleaner.logger.info_messages[-1] == "Deleted 4 object(s)."
    assert all(engine.closed for engine in FakeSqliteEngine.instances)


def test_dry_run_reports_stale_objects_without_deleting(monkeypatch):
    txt_prefix, path = b"a" * 32, b"b" * 32
    referenced = content_key("books", txt_prefix, path)
    cleaner = build_cleaner(
        monkeypatch,
        [account("admin", "db", "books")],
        {"db": b"database", referenced: b"book", "books/stale": b"stale"},
        rows_by_database={b"database": [(txt_prefix, path)]},
        dry_run=True,
    )

    cleaner.run()

    assert cleaner.r2.deleted == []
    assert "Would delete books/stale" in cleaner.logger.verbose_messages
    assert cleaner.logger.info_messages[-1] == "Dry run: would delete 1 object(s)."


def test_missing_database_means_prefix_has_no_referenced_content(monkeypatch):
    cleaner = build_cleaner(
        monkeypatch,
        [account("admin", "missing-db", "books")],
        {"books/stale": b"stale", "orphan": b"orphan"},
    )

    cleaner.run()

    assert cleaner.r2.get_calls == ["missing-db"]
    assert cleaner.r2.deleted == ["books/stale", "orphan"]
    assert FakeSqliteEngine.instances == []
    assert any(
        "no content objects are referenced yet" in message
        for message in cleaner.logger.verbose_messages
    )


def test_database_without_txt_table_references_no_content(monkeypatch):
    cleaner = build_cleaner(
        monkeypatch,
        [account("admin", "db", "books")],
        {"db": b"empty-database", "books/stale": b"stale"},
        tableless_databases={b"empty-database"},
    )

    cleaner.run()

    assert cleaner.r2.deleted == ["books/stale"]
    assert FakeSqliteEngine.instances[0].closed


def test_database_error_aborts_before_bucket_is_listed_or_deleted(monkeypatch):
    cleaner = build_cleaner(
        monkeypatch,
        [account("admin", "db", "books")],
        {"db": b"broken-database", "books/stale": b"stale"},
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
        [account("admin", "db", "books")],
        {"db": b"", "books/stale": b"stale"},
    )

    with pytest.raises(ValueError, match="empty database"):
        cleaner.run()

    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []
    assert FakeSqliteEngine.instances == []


def test_refuses_to_clean_when_no_accounts_are_reachable(monkeypatch):
    cleaner = build_cleaner(monkeypatch, [], {"orphan": b"orphan"})

    with pytest.raises(ValueError, match="No accounts are reachable"):
        cleaner.run()

    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []


def test_refuses_to_clean_when_any_user_lacks_an_admin_backup():
    cleaner = object.__new__(BucketCleaner)
    cleaner.blob = object()
    ctl = FakeCtl(["admin", "old-user"], [["admin", b"content"]])

    with pytest.raises(ValueError, match="old-user"):
        cleaner._reachable_accounts(ctl, "admin", b"umk")


@pytest.mark.parametrize("field", ["db_path", "db_prefix", "db_master_key"])
def test_refuses_to_clean_when_account_storage_reference_is_invalid(monkeypatch, field):
    uid, payload = account("user", "db", "books")
    payload[field] = ""
    cleaner = build_cleaner(monkeypatch, [(uid, payload)], {"orphan": b"orphan"})

    with pytest.raises(ValueError, match=field):
        cleaner.run()

    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []


def test_refuses_to_clean_when_database_key_is_not_valid_base64(monkeypatch):
    uid, payload = account("user", "db", "books")
    payload["db_master_key"] = "not base64!"
    cleaner = build_cleaner(monkeypatch, [(uid, payload)], {"orphan": b"orphan"})

    with pytest.raises(ValueError, match="db_master_key"):
        cleaner.run()

    assert cleaner.r2.get_calls == []
    assert cleaner.r2.list_prefixes == []
    assert cleaner.r2.deleted == []
