from click.testing import CliRunner

import txt.cli as cli_module
from txt.cli import cli


def test_no_args_shows_help():
    result = CliRunner().invoke(cli, [])
    assert result.exit_code == 0
    assert "--init-admin" in result.output


def test_init_admin_without_a_value_is_a_usage_error():
    result = CliRunner().invoke(cli, ["--init-admin"])
    assert result.exit_code != 0
    assert "--init-admin" in result.output


def test_init_user_without_admin_or_user_creds_is_a_usage_error():
    result = CliRunner().invoke(cli, ["--init-user"])
    assert result.exit_code != 0
    assert "--admin-creds" in result.output
    assert "--user-creds" in result.output


def test_init_user_without_user_creds_is_a_usage_error(tmp_path):
    admin_path = tmp_path / "admin.json"
    admin_path.write_text("{}")
    result = CliRunner().invoke(cli, ["--init-user", "--admin-creds", str(admin_path)])
    assert result.exit_code != 0
    assert "--user-creds" in result.output


def test_replace_images_processes_a_directory(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    result = CliRunner().invoke(cli, ["--replace-images", str(src), str(dst)])
    assert result.exit_code == 0
    assert dst.is_dir()


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
        def __init__(self, creds, logger, dry_run):
            captured.update(creds=creds, logger=logger, dry_run=dry_run)

        def run(self):
            captured["ran"] = True

    creds_path = tmp_path / "creds.json"
    creds_path.write_text("{}")
    creds = object()
    monkeypatch.setattr(cli_module, "load_creds", lambda path: creds)
    monkeypatch.setattr(cli_module, "BucketCleaner", FakeCleaner)
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(
        cli,
        ["--clean-bucket", str(creds_path), "--verbose", "--dry-run"],
    )

    assert result.exit_code == 0
    assert captured["creds"] is creds
    assert captured["logger"].verbose_enabled is True
    assert captured["dry_run"] is True
    assert captured["ran"] is True
    assert "Logging bucket cleanup to run.log" in (tmp_path / "run.log").read_text()


def test_dry_run_without_clean_bucket_is_a_usage_error():
    result = CliRunner().invoke(cli, ["--dry-run"])

    assert result.exit_code != 0
    assert "--dry-run requires --clean-bucket" in result.output


def test_rejects_multiple_primary_commands(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    result = CliRunner().invoke(
        cli,
        ["--replace-images", str(src), str(dst), "--init-user"],
    )

    assert result.exit_code != 0
    assert "choose only one primary command" in result.output
