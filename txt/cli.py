import click

from .admin_init import AdminInitializer
from .creds import load_creds
from .logger import Logger


@click.command()
@click.option("--init-admin", "creds_path", metavar="CREDS_JSON", help="Provision the administrator account")
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(ctx: click.Context, creds_path: str | None, verbose: bool) -> None:
    if not creds_path:
        click.echo(ctx.get_help())
        return
    logger = Logger(verbose)
    AdminInitializer(load_creds(creds_path), logger).run()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
