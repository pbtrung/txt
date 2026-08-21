import sqlite3
from pathlib import Path

import txt.rqlite_updater as rqlite_updater_module
from txt.rqlite_schema import CONTROL_SCHEMA
from txt.rqlite_updater import RqliteUpdater, _parse_filename, _split_statements


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
    def __init__(self, applied_names=()):
        self.applied_names = set(applied_names)
        self.batches = []
        self.vacuum_calls = 0

    def query(self, sql, params=None):
        return [{"name": name} for name in sorted(self.applied_names)]

    def execute_batch(self, statements):
        self.batches.append(list(statements))
        return [{} for _ in statements]

    def vacuum(self):
        self.vacuum_calls += 1
        return {}


def _write_migration(directory: Path, filename: str, sql: str) -> None:
    (directory / filename).write_text(sql)


def test_parse_filename_splits_the_version_prefix_and_name():
    assert _parse_filename(Path("0002_share_object_path_hash.sql")) == (
        2,
        "share_object_path_hash",
    )
    assert _parse_filename(Path("0013_add_widgets.sql")) == (13, "add_widgets")


def test_split_statements_strips_comments_and_empty_fragments():
    sql = """
-- a leading comment
CREATE TABLE foo (id INTEGER); -- an inline trailing comment

-- another comment
CREATE INDEX idx_foo ON foo(id);
"""
    assert _split_statements(sql) == [
        "CREATE TABLE foo (id INTEGER)",
        "CREATE INDEX idx_foo ON foo(id)",
    ]


def test_split_statements_preserves_semicolons_inside_sql_constructs():
    sql = """
CREATE TABLE messages (value TEXT);
CREATE TRIGGER copy_message AFTER INSERT ON messages BEGIN
  INSERT INTO messages VALUES ('copy;
--value');
END;
"""

    statements = _split_statements(sql)

    assert len(statements) == 2
    assert "'copy;\n--value'" in statements[1]


def test_split_statements_rejects_incomplete_sql():
    try:
        _split_statements("CREATE TABLE broken (id INTEGER)")
    except ValueError as error:
        assert "incomplete" in str(error)
    else:
        raise AssertionError("incomplete migration was accepted")


def test_applies_pending_migrations_in_order_and_skips_version_one(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(rqlite_updater_module, "MIGRATIONS_DIR", tmp_path)
    _write_migration(tmp_path, "0001_control.sql", "CREATE TABLE owner_control (x);")
    _write_migration(tmp_path, "0003_third.sql", "ALTER TABLE t ADD COLUMN c;")
    _write_migration(tmp_path, "0002_second.sql", "ALTER TABLE t ADD COLUMN b;")
    rqlite = FakeRqliteClient()

    RqliteUpdater(None, NullLogger(), rqlite=rqlite).run()

    assert rqlite.batches == [
        ["ALTER TABLE t ADD COLUMN b"],
        ["ALTER TABLE t ADD COLUMN c"],
    ]
    assert rqlite.vacuum_calls == 1


def test_skips_a_migration_already_recorded_as_applied(tmp_path, monkeypatch):
    monkeypatch.setattr(rqlite_updater_module, "MIGRATIONS_DIR", tmp_path)
    _write_migration(tmp_path, "0002_second.sql", "ALTER TABLE t ADD COLUMN b;")
    rqlite = FakeRqliteClient(applied_names=["second"])

    RqliteUpdater(None, NullLogger(), rqlite=rqlite).run()

    assert rqlite.batches == []
    assert rqlite.vacuum_calls == 1


def test_vacuums_even_when_nothing_is_pending(tmp_path, monkeypatch):
    monkeypatch.setattr(rqlite_updater_module, "MIGRATIONS_DIR", tmp_path)
    _write_migration(tmp_path, "0001_control.sql", "CREATE TABLE owner_control (x);")
    logger = CaptureLogger()
    rqlite = FakeRqliteClient()

    RqliteUpdater(None, logger, rqlite=rqlite).run()

    assert "rqlite schema is already up to date." in logger.messages
    assert rqlite.vacuum_calls == 1


def test_every_real_migration_file_parses_and_splits_cleanly():
    for path in sorted(rqlite_updater_module.MIGRATIONS_DIR.glob("*.sql")):
        version, name = _parse_filename(path)
        assert version >= 1
        assert name
        assert _split_statements(path.read_text())


def test_fresh_schema_records_every_numbered_migration():
    connection = sqlite3.connect(":memory:")
    for statement in CONTROL_SCHEMA:
        connection.execute(statement)
    recorded = connection.execute(
        "SELECT version, name FROM schema_migrations ORDER BY version"
    ).fetchall()
    expected = [
        _parse_filename(path)
        for path in sorted(rqlite_updater_module.MIGRATIONS_DIR.glob("*.sql"))
    ]

    assert recorded == expected
