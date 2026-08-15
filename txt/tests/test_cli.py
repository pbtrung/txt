from click.testing import CliRunner

from txt.cli import cli


def test_no_args_shows_help():
    result = CliRunner().invoke(cli, [])
    assert result.exit_code == 0
    assert "--init-admin" in result.output


def test_init_admin_without_creds_is_a_usage_error():
    result = CliRunner().invoke(cli, ["--init-admin"])
    assert result.exit_code != 0
    assert "--creds" in result.output
