from pathlib import Path

import click

from .admin_init import AdminInitializer
from .creds import load_creds
from .init_db import DbInitializer
from .logger import Logger
from .replace_images import replace_images_dir


@click.command()
@click.option(
    "--init-admin",
    "admin_creds_path",
    metavar="CREDS_JSON",
    help="Provision the administrator account",
)
@click.option(
    "--init-db",
    "db_creds_path",
    metavar="CREDS_JSON",
    help="Initialize this user's own database (admin or otherwise)",
)
@click.option(
    "--replace-images",
    "replace_images_dirs",
    nargs=2,
    type=click.Path(),
    metavar="SRC DST",
    help="Replace images in every *.epub under SRC into DST, and copy every *.opf",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(
    ctx: click.Context,
    admin_creds_path: str | None,
    db_creds_path: str | None,
    replace_images_dirs: tuple[str, str],
    verbose: bool,
) -> None:
    logger = Logger(verbose)
    if admin_creds_path:
        AdminInitializer(load_creds(admin_creds_path), logger).run()
    elif db_creds_path:
        DbInitializer(load_creds(db_creds_path), db_creds_path, logger).run()
    elif replace_images_dirs:
        _run_replace_images(replace_images_dirs, logger)
    else:
        click.echo(ctx.get_help())


def _run_replace_images(dirs: tuple[str, str], logger: Logger) -> None:
    src, dst = dirs
    replace_images_dir(Path(src), Path(dst), logger)


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
