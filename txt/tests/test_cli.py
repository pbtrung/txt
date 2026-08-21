from click.testing import CliRunner

import txt.cli as cli_module
from txt.cli import cli


def test_no_args_shows_help():
    result = CliRunner().invoke(cli, [])
    assert result.exit_code == 0
    assert "--init-owner" in result.output
    assert "--init-admin" not in result.output
    assert "--init-user" not in result.output


def test_init_owner_without_a_value_is_a_usage_error():
    result = CliRunner().invoke(cli, ["--init-owner"])
    assert result.exit_code != 0
    assert "--init-owner" in result.output


def test_init_owner_loads_creds_and_runs_initializer(monkeypatch, tmp_path):
    captured = {}
    creds = object()

    class FakeInitializer:
        def __init__(self, loaded, path, logger):
            captured.update(creds=loaded, path=path, logger=logger)

        def run(self):
            captured["ran"] = True

    path = tmp_path / "owner.json"
    path.write_text("{}")
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda value: creds)
    monkeypatch.setattr(cli_module, "OwnerInitializer", FakeInitializer)

    result = CliRunner().invoke(cli, ["--init-owner", str(path), "--verbose"])

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["path"] == str(path)
    assert captured["logger"].verbose_enabled is True
    assert captured["ran"] is True


def test_migrate_loads_both_creds_and_passes_dry_run(monkeypatch, tmp_path):
    captured = {}

    class FakeMigrator:
        def __init__(self, *args):
            captured["args"] = args

        def run(self):
            captured["ran"] = True

    old_path, new_path = tmp_path / "turso.json", tmp_path / "rqlite.json"
    old_path.write_text("{}")
    new_path.write_text("{}")
    old_creds, new_creds = object(), object()
    monkeypatch.setattr(cli_module, "load_creds", lambda _path: old_creds)
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda _path: new_creds)
    monkeypatch.setattr(cli_module, "OwnerMigrator", FakeMigrator)

    result = CliRunner().invoke(
        cli, ["--migrate", str(old_path), str(new_path), "--dry-run", "--verbose"]
    )

    assert result.exit_code == 0
    assert captured["args"][0:2] == (old_creds, new_creds)
    assert captured["args"][2] == str(new_path)
    assert captured["args"][4] is True
    assert captured["ran"] is True


def test_replace_images_processes_a_directory(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    result = CliRunner().invoke(cli, ["--replace-images", str(src), str(dst)])
    assert result.exit_code == 0
    assert dst.is_dir()


def test_edit_epub_processes_a_directory(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    result = CliRunner().invoke(
        cli,
        ["--edit-epub", str(src), str(dst), "--verbose"],
    )
    assert result.exit_code == 0
    assert dst.is_dir()
    assert "Edited 0 EPUB(s)" in result.output


def test_ingest_without_local_db_dir_or_creds_is_a_usage_error(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    result = CliRunner().invoke(cli, ["--ingest", str(src)])
    assert result.exit_code != 0
    assert "--local-db-dir" in result.output


def test_update_db_without_local_db_dir_is_a_usage_error(tmp_path):
    creds_path = tmp_path / "creds.json"
    creds_path.write_text("{}")
    result = CliRunner().invoke(cli, ["--update-db", str(creds_path)])
    assert result.exit_code != 0
    assert "--local-db-dir" in result.output


def test_clean_bucket_passes_dry_run_and_verbose_to_cleaner(monkeypatch, tmp_path):
    captured = {}

    class FakeCleaner:
        def __init__(self, creds, creds_path, logger, dry_run):
            captured.update(
                creds=creds, creds_path=creds_path, logger=logger, dry_run=dry_run
            )

        def run(self):
            captured["ran"] = True

    creds_path = tmp_path / "creds.json"
    creds_path.write_text("{}")
    creds = object()
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda path: creds)
    monkeypatch.setattr(cli_module, "BucketCleaner", FakeCleaner)
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(
        cli,
        ["--clean-bucket", str(creds_path), "--verbose", "--dry-run"],
    )

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["creds_path"] == str(creds_path)
    assert captured["logger"].verbose_enabled is True
    assert captured["dry_run"] is True
    assert captured["ran"] is True
    assert "Logging bucket cleanup to run.log" in (tmp_path / "run.log").read_text()


def test_update_rql_loads_creds_and_runs_updater(monkeypatch, tmp_path):
    captured = {}

    class FakeUpdater:
        def __init__(self, creds, logger):
            captured.update(creds=creds, logger=logger)

        def run(self):
            captured["ran"] = True

    creds_path = tmp_path / "creds.json"
    creds_path.write_text("{}")
    creds = object()
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda path: creds)
    monkeypatch.setattr(cli_module, "RqliteUpdater", FakeUpdater)

    result = CliRunner().invoke(cli, ["--update-rql", str(creds_path), "--verbose"])

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["logger"].verbose_enabled is True
    assert captured["ran"] is True


def test_dry_run_without_clean_bucket_is_a_usage_error():
    result = CliRunner().invoke(cli, ["--dry-run"])

    assert result.exit_code != 0
    assert "--dry-run requires --migrate or --clean-bucket" in result.output


def test_rejects_multiple_primary_commands(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    creds = tmp_path / "owner.json"
    creds.write_text("{}")
    result = CliRunner().invoke(
        cli,
        ["--replace-images", str(src), str(dst), "--init-owner", str(creds)],
    )

    assert result.exit_code != 0
    assert "choose only one primary command" in result.output
