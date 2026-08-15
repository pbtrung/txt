from click.testing import CliRunner

from txt.cli import cli


def test_no_args_shows_help():
    result = CliRunner().invoke(cli, [])
    assert result.exit_code == 0
    assert "--init-admin" in result.output


def test_init_admin_without_a_value_is_a_usage_error():
    result = CliRunner().invoke(cli, ["--init-admin"])
    assert result.exit_code != 0
    assert "--init-admin" in result.output


def test_init_user_without_a_value_is_a_usage_error():
    result = CliRunner().invoke(cli, ["--init-user"])
    assert result.exit_code != 0
    assert "--init-user" in result.output


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
