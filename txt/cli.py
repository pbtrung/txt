from pathlib import Path

import click

from .admin_init import AdminInitializer
from .creds import load_creds
from .ingest import TxtIngester
from .init_db import DbInitializer
from .logger import Logger
from .replace_images import ImageReplacer


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
@click.option(
    "--ingest",
    "ingest_dir",
    type=click.Path(),
    metavar="DIR",
    help="Ingest every *.epub in DIR into BB and R2 (needs --creds)",
)
@click.option(
    "--creds", "ingest_creds_path", metavar="CREDS_JSON", help="creds.json for --ingest"
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(
    ctx: click.Context,
    admin_creds_path: str | None,
    db_creds_path: str | None,
    replace_images_dirs: tuple[str, str],
    ingest_dir: str | None,
    ingest_creds_path: str | None,
    verbose: bool,
) -> None:
    logger = Logger(verbose)
    if admin_creds_path:
        AdminInitializer(load_creds(admin_creds_path), logger).run()
    elif db_creds_path:
        DbInitializer(load_creds(db_creds_path), db_creds_path, logger).run()
    elif replace_images_dirs:
        _run_replace_images(replace_images_dirs, logger)
    elif ingest_dir:
        _run_ingest(ingest_dir, ingest_creds_path, logger)
    else:
        click.echo(ctx.get_help())


def _run_replace_images(dirs: tuple[str, str], logger: Logger) -> None:
    src, dst = dirs
    ImageReplacer(Path(src), Path(dst), logger).run()


def _run_ingest(ingest_dir: str, creds_path: str | None, logger: Logger) -> None:
    if not creds_path:
        raise click.UsageError("--ingest requires --creds CREDS_JSON")
    ingester = TxtIngester(Path(ingest_dir), load_creds(creds_path), logger)
    try:
        ingester.run()
    finally:
        ingester.bb.close()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
