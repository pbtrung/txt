from collections.abc import Callable
from pathlib import Path

import click

from .bucket_cleaner import BucketCleaner
from .creds import load_owner_creds
from .db_updater import DbUpdater
from .edit_epub import EpubEditor
from .ingest import TxtIngester
from .logger import Logger
from .owner_init import OwnerInitializer
from .replace_images import ImageReplacer
from .rqlite_updater import RqliteUpdater


@click.command()
@click.option(
    "--init-owner",
    "owner_creds_path",
    metavar="CREDS_JSON",
    help="Provision and validate the singleton owner row in rqlite",
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
    "--edit-epub",
    "edit_epub_dirs",
    nargs=2,
    type=click.Path(),
    metavar="SRC DST",
    help="Split EPUBs near 1.2 MB, rewrite part metadata, and replace images",
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
@click.option(
    "--update-db",
    "update_db_creds_path",
    metavar="CREDS_JSON",
    help=(
        "Migrate and validate the complete catalog/CFI schema for the singleton "
        "owner's database (needs --local-db-dir)"
    ),
)
@click.option(
    "--clean-bucket",
    "clean_bucket_creds_path",
    metavar="CREDS_JSON",
    help="Delete R2 objects not referenced by the singleton owner's database",
)
@click.option(
    "--update-rql",
    "update_rql_creds_path",
    metavar="CREDS_JSON",
    help="Apply pending rqlite schema migrations under docker/migrations/",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Report bucket changes without deleting anything",
)
@click.option(
    "--log-file",
    "log_file_path",
    type=click.Path(dir_okay=False),
    default="run.log",
    show_default=True,
    help="Mirror --clean-bucket output to FILE",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(ctx: click.Context, **opts) -> None:
    cleanup_log = _cleanup_log(opts)
    logger = Logger(opts["verbose"], cleanup_log)
    try:
        if cleanup_log is not None:
            logger.info(f"Logging bucket cleanup to {cleanup_log}")
        if not _dispatch(opts, logger):
            click.echo(ctx.get_help())
    finally:
        logger.close()


def _dispatch(opts: dict, logger: Logger) -> bool:
    _validate_options(opts)
    commands = _selected_commands(opts)
    if not commands:
        return False
    commands[0](opts, logger)
    return True


def _cleanup_log(opts: dict) -> Path | None:
    return Path(opts["log_file_path"]) if opts["clean_bucket_creds_path"] else None


def _validate_options(opts: dict) -> None:
    if opts["dry_run"] and not opts["clean_bucket_creds_path"]:
        raise click.UsageError("--dry-run requires --clean-bucket")
    if len(_selected_commands(opts)) > 1:
        raise click.UsageError("choose only one primary command")


def _selected_commands(opts: dict) -> list[Callable]:
    return [handler for option, handler in COMMAND_HANDLERS if opts[option]]


def _dispatch_init_owner(opts: dict, logger: Logger) -> None:
    _run_init_owner(opts["owner_creds_path"], logger)


def _dispatch_replace_images(opts: dict, logger: Logger) -> None:
    _run_replace_images(opts["replace_images_dirs"], logger)


def _dispatch_edit_epub(opts: dict, logger: Logger) -> None:
    _run_edit_epub(opts["edit_epub_dirs"], logger)


def _dispatch_ingest(opts: dict, logger: Logger) -> None:
    _run_ingest(
        opts["ingest_src_dir"],
        opts["local_db_dir"],
        opts["ingest_creds_path"],
        logger,
    )


def _dispatch_update_db(opts: dict, logger: Logger) -> None:
    _run_update_db(opts["update_db_creds_path"], opts["local_db_dir"], logger)


def _dispatch_clean_bucket(opts: dict, logger: Logger) -> None:
    _run_clean_bucket(opts["clean_bucket_creds_path"], opts["dry_run"], logger)


def _dispatch_update_rql(opts: dict, logger: Logger) -> None:
    _run_update_rql(opts["update_rql_creds_path"], logger)


COMMAND_HANDLERS = (
    ("owner_creds_path", _dispatch_init_owner),
    ("replace_images_dirs", _dispatch_replace_images),
    ("edit_epub_dirs", _dispatch_edit_epub),
    ("ingest_src_dir", _dispatch_ingest),
    ("update_db_creds_path", _dispatch_update_db),
    ("clean_bucket_creds_path", _dispatch_clean_bucket),
    ("update_rql_creds_path", _dispatch_update_rql),
)


def _run_init_owner(creds_path: str, logger: Logger) -> None:
    creds = load_owner_creds(creds_path)
    OwnerInitializer(creds, creds_path, logger).run()


def _run_replace_images(dirs: tuple[str, str], logger: Logger) -> None:
    src, dst = dirs
    ImageReplacer(Path(src), Path(dst), logger).run()


def _run_edit_epub(dirs: tuple[str, str], logger: Logger) -> None:
    src, dst = dirs
    EpubEditor(Path(src), Path(dst), logger).run()


def _run_ingest(
    src_dir: str, local_db_dir: str | None, creds_path: str | None, logger: Logger
) -> None:
    if not local_db_dir or not creds_path:
        raise click.UsageError(
            "--ingest requires --local-db-dir DIR and --creds CREDS_JSON"
        )
    creds = load_owner_creds(creds_path)
    TxtIngester(Path(src_dir), Path(local_db_dir), creds, creds_path, logger).run()


def _run_update_db(creds_path: str, local_db_dir: str | None, logger: Logger) -> None:
    if not local_db_dir:
        raise click.UsageError("--update-db requires --local-db-dir DIR")
    creds = load_owner_creds(creds_path)
    DbUpdater(creds, creds_path, Path(local_db_dir), logger).run()


def _run_clean_bucket(creds_path: str, dry_run: bool, logger: Logger) -> None:
    creds = load_owner_creds(creds_path)
    BucketCleaner(creds, creds_path, logger, dry_run=dry_run).run()


def _run_update_rql(creds_path: str, logger: Logger) -> None:
    RqliteUpdater(load_owner_creds(creds_path), logger).run()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
