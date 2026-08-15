import click

from .admin_init import AdminInitializer
from .creds import load_creds
from .logger import Logger


@click.command()
@click.option(
    "--init-admin",
    "init_admin_flag",
    is_flag=True,
    help="Provision the administrator's row in ctl (users/key_store/cred_store)",
)
@click.option(
    "--creds",
    "creds_path",
    metavar="CREDS_JSON",
    help="creds.json for --init-admin",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(
    ctx: click.Context, init_admin_flag: bool, creds_path: str | None, verbose: bool
) -> None:
    logger = Logger(verbose)
    if init_admin_flag:
        _run_init_admin(creds_path, logger)
    else:
        click.echo(ctx.get_help())


def _run_init_admin(creds_path: str | None, logger: Logger) -> None:
    if not creds_path:
        raise click.UsageError("--init-admin requires --creds CREDS_JSON")
    AdminInitializer(load_creds(creds_path), creds_path, logger).run()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
