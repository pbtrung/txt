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


def test_ingest_loads_creds_and_runs_ingester(monkeypatch, tmp_path):
    captured = {}
    creds = object()

    class FakeIngester:
        def __init__(self, src_dir, local_db_dir, loaded, path, logger):
            captured.update(
                src_dir=src_dir,
                local_db_dir=local_db_dir,
                creds=loaded,
                path=path,
                logger=logger,
            )

        def run(self):
            captured["ran"] = True

    src = tmp_path / "src"
    src.mkdir()
    local = tmp_path / "local"
    creds_path = tmp_path / "creds.json"
    creds_path.write_text("{}")
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda value: creds)
    monkeypatch.setattr(cli_module, "TxtIngester", FakeIngester)

    result = CliRunner().invoke(
        cli,
        [
            "--ingest",
            str(src),
            "--local-db-dir",
            str(local),
            "--creds",
            str(creds_path),
        ],
    )

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["ran"] is True


def test_clean_bucket_loads_creds_and_runs_cleaner(monkeypatch, tmp_path):
    captured = {}
    creds = object()

    class FakeCleaner:
        def __init__(self, loaded, path, logger, *, dry_run):
            captured.update(creds=loaded, path=path, dry_run=dry_run)

        def run(self):
            captured["ran"] = True

    path = tmp_path / "creds.json"
    path.write_text("{}")
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda value: creds)
    monkeypatch.setattr(cli_module, "BucketCleaner", FakeCleaner)

    result = CliRunner().invoke(cli, ["--clean-bucket", str(path), "--dry-run"])

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["path"] == str(path)
    assert captured["dry_run"] is True
    assert captured["ran"] is True


def test_clean_db_loads_creds_and_runs_cleaner(monkeypatch, tmp_path):
    captured = {}
    creds = object()

    class FakeCleaner:
        def __init__(self, loaded, path, logger, *, dry_run):
            captured.update(creds=loaded, path=path, dry_run=dry_run)

        def run(self):
            captured["ran"] = True

    path = tmp_path / "creds.json"
    path.write_text("{}")
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda value: creds)
    monkeypatch.setattr(cli_module, "DbCleaner", FakeCleaner)

    result = CliRunner().invoke(cli, ["--clean-db", str(path)])

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["path"] == str(path)
    assert captured["dry_run"] is False
    assert captured["ran"] is True


def test_update_db_loads_creds_and_runs_updater(monkeypatch, tmp_path):
    captured = {}
    creds = object()

    class FakeUpdater:
        def __init__(self, loaded, path, logger, *, dry_run):
            captured.update(creds=loaded, path=path, dry_run=dry_run)

        def run(self):
            captured["ran"] = True

    path = tmp_path / "creds.json"
    path.write_text("{}")
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda value: creds)
    monkeypatch.setattr(cli_module, "DbUpdater", FakeUpdater)

    result = CliRunner().invoke(cli, ["--update-db", str(path), "--dry-run"])

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["path"] == str(path)
    assert captured["dry_run"] is True
    assert captured["ran"] is True


def test_check_catalog_loads_creds_and_runs_checker(monkeypatch, tmp_path):
    captured = {}
    creds = object()

    class FakeChecker:
        def __init__(self, loaded, path, logger):
            captured.update(creds=loaded, path=path)

        def run(self):
            captured["ran"] = True

    path = tmp_path / "creds.json"
    path.write_text("{}")
    monkeypatch.setattr(cli_module, "load_owner_creds", lambda value: creds)
    monkeypatch.setattr(cli_module, "CatalogChecker", FakeChecker)

    result = CliRunner().invoke(cli, ["--check-catalog", str(path)])

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["path"] == str(path)
    assert captured["ran"] is True


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
