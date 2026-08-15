from pathlib import Path

import click

from .account_init import AccountInitializer
from .creds import load_creds
from .ingest import TxtIngester
from .logger import Logger
from .replace_images import ImageReplacer


@click.command()
@click.option(
    "--init-admin",
    "admin_creds_path",
    metavar="CREDS_JSON",
    help="Provision the administrator's row in ctl (users/key_store/cred_store)",
)
@click.option(
    "--init-user",
    "user_creds_path",
    metavar="CREDS_JSON",
    help="Provision an ordinary user's row in ctl (users/key_store/cred_store)",
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
    "ingest_src_dir",
    type=click.Path(),
    metavar="SRC_DIR",
    help="Ingest every *.epub in SRC_DIR (needs --local-db-dir and --creds)",
)
@click.option(
    "--local-db-dir",
    "local_db_dir",
    type=click.Path(),
    metavar="DIR",
    help="Local working directory for the SQLCipher database file, for --ingest",
)
@click.option(
    "--creds",
    "ingest_creds_path",
    metavar="CREDS_JSON",
    help="creds.json for --ingest",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(
    ctx: click.Context,
    admin_creds_path: str | None,
    user_creds_path: str | None,
    replace_images_dirs: tuple[str, str],
    ingest_src_dir: str | None,
    local_db_dir: str | None,
    ingest_creds_path: str | None,
    verbose: bool,
) -> None:
    logger = Logger(verbose)
    if not _dispatch(ctx.params, logger):
        click.echo(ctx.get_help())


def _dispatch(opts: dict, logger: Logger) -> bool:
    if opts["admin_creds_path"]:
        _run_init(opts["admin_creds_path"], "admin", logger)
    elif opts["user_creds_path"]:
        _run_init(opts["user_creds_path"], "user", logger)
    elif opts["replace_images_dirs"]:
        _run_replace_images(opts["replace_images_dirs"], logger)
    elif opts["ingest_src_dir"]:
        _run_ingest(
            opts["ingest_src_dir"], opts["local_db_dir"], opts["ingest_creds_path"], logger
        )
    else:
        return False
    return True


def _run_init(creds_path: str, account_type: str, logger: Logger) -> None:
    AccountInitializer(load_creds(creds_path), creds_path, logger, account_type).run()


def _run_replace_images(dirs: tuple[str, str], logger: Logger) -> None:
    src, dst = dirs
    ImageReplacer(Path(src), Path(dst), logger).run()


def _run_ingest(
    src_dir: str, local_db_dir: str | None, creds_path: str | None, logger: Logger
) -> None:
    if not local_db_dir or not creds_path:
        raise click.UsageError("--ingest requires --local-db-dir DIR and --creds CREDS_JSON")
    TxtIngester(Path(src_dir), Path(local_db_dir), load_creds(creds_path), logger).run()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
