from collections.abc import Callable
from pathlib import Path

import click

from .creds import load_owner_creds
from .edit_epub import EpubEditor
from .ingest import TxtIngester
from .logger import Logger
from .migrate_rql import RqlMigrator, load_rql_creds
from .owner_init import OwnerInitializer
from .replace_images import ImageReplacer


@click.command()
@click.option(
    "--init-owner",
    "owner_creds_path",
    metavar="CREDS_JSON",
    help="Provision and validate the singleton owner row in D1",
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
    "--migrate-rql",
    "migrate_rql_creds",
    nargs=2,
    type=click.Path(),
    metavar="RQL_CREDS_JSON CF_CREDS_JSON",
    help=(
        "Import one owner's rqlite+SQLCipher library (RQL_CREDS_JSON) into "
        "the D1 owner in CF_CREDS_JSON (needs --local-db-dir)"
    ),
)
@click.option(
    "--local-db-dir",
    "local_db_dir",
    type=click.Path(),
    metavar="DIR",
    help=(
        "Local working directory for the recovery checkpoint, "
        "for --ingest and --migrate-rql"
    ),
)
@click.option(
    "--creds",
    "ingest_creds_path",
    metavar="CREDS_JSON",
    help="creds.json for --ingest",
)
@click.option(
    "--limit",
    "migrate_limit",
    type=int,
    metavar="N",
    help="Migrate at most N not-yet-migrated documents, for --migrate-rql",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(ctx: click.Context, **opts) -> None:
    logger = Logger(opts["verbose"], None)
    try:
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


def _validate_options(opts: dict) -> None:
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


def _dispatch_migrate_rql(opts: dict, logger: Logger) -> None:
    _run_migrate_rql(
        opts["migrate_rql_creds"],
        opts["local_db_dir"],
        opts["migrate_limit"],
        logger,
    )


COMMAND_HANDLERS = (
    ("owner_creds_path", _dispatch_init_owner),
    ("replace_images_dirs", _dispatch_replace_images),
    ("edit_epub_dirs", _dispatch_edit_epub),
    ("ingest_src_dir", _dispatch_ingest),
    ("migrate_rql_creds", _dispatch_migrate_rql),
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


def _run_migrate_rql(
    creds_paths: tuple[str, str],
    local_db_dir: str | None,
    limit: int | None,
    logger: Logger,
) -> None:
    if not local_db_dir:
        raise click.UsageError("--migrate-rql requires --local-db-dir DIR")
    rql_creds_path, cf_creds_path = creds_paths
    rql_creds = load_rql_creds(rql_creds_path)
    cf_creds = load_owner_creds(cf_creds_path)
    RqlMigrator(
        rql_creds, cf_creds, cf_creds_path, Path(local_db_dir), logger, limit=limit
    ).run()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
