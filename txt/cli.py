import click

from .admin_init import AdminInitializer
from .creds import load_creds
from .logger import Logger


@click.command()
@click.option(
    "--init-admin",
    "admin_creds_path",
    metavar="CREDS_JSON",
    help="Provision the administrator's row in ctl (users/key_store/cred_store)",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(ctx: click.Context, admin_creds_path: str | None, verbose: bool) -> None:
    logger = Logger(verbose)
    if admin_creds_path:
        AdminInitializer(load_creds(admin_creds_path), admin_creds_path, logger).run()
    else:
        click.echo(ctx.get_help())


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
