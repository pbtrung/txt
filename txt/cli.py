from pathlib import Path

import click

from .account_init import AccountInitializer
from .bucket_cleaner import BucketCleaner
from .creds import load_creds, load_user_creds
from .db_updater import DbUpdater
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
    is_flag=True,
    help="Provision an ordinary user's row in ctl (needs --admin-creds and "
    "--user-creds)",
)
@click.option(
    "--admin-creds",
    "admin_creds_path_for_user",
    metavar="CREDS_JSON",
    help="The administrator's own creds.json, for --init-user",
)
@click.option(
    "--user-creds",
    "user_creds_path",
    metavar="CREDS_JSON",
    help="The new user's own reduced creds.json, for --init-user",
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
@click.option(
    "--update-db",
    "update_db_creds_path",
    metavar="CREDS_JSON",
    help=(
        "Migrate txt.metadata to txt.catalog for every account this admin's "
        "creds.json can reach (needs --local-db-dir)"
    ),
)
@click.option(
    "--clean-bucket",
    "clean_bucket_creds_path",
    metavar="CREDS_JSON",
    help="Delete R2 objects not referenced by accounts reachable from this admin",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Report bucket objects that would be deleted without deleting them",
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
def cli(
    ctx: click.Context,
    admin_creds_path: str | None,
    init_user: bool,
    admin_creds_path_for_user: str | None,
    user_creds_path: str | None,
    replace_images_dirs: tuple[str, str],
    ingest_src_dir: str | None,
    local_db_dir: str | None,
    ingest_creds_path: str | None,
    update_db_creds_path: str | None,
    clean_bucket_creds_path: str | None,
    dry_run: bool,
    log_file_path: str,
    verbose: bool,
) -> None:
    cleanup_log = Path(log_file_path) if clean_bucket_creds_path else None
    logger = Logger(verbose, cleanup_log)
    try:
        if cleanup_log is not None:
            logger.info(f"Logging bucket cleanup to {cleanup_log}")
        if not _dispatch(ctx.params, logger):
            click.echo(ctx.get_help())
    finally:
        logger.close()


def _dispatch(opts: dict, logger: Logger) -> bool:
    if opts["dry_run"] and not opts["clean_bucket_creds_path"]:
        raise click.UsageError("--dry-run requires --clean-bucket CREDS_JSON")
    if opts["admin_creds_path"]:
        _run_init_admin(opts["admin_creds_path"], logger)
    elif opts["init_user"]:
        _run_init_user(
            opts["admin_creds_path_for_user"], opts["user_creds_path"], logger
        )
    elif opts["replace_images_dirs"]:
        _run_replace_images(opts["replace_images_dirs"], logger)
    elif opts["ingest_src_dir"]:
        _run_ingest(
            opts["ingest_src_dir"],
            opts["local_db_dir"],
            opts["ingest_creds_path"],
            logger,
        )
    elif opts["update_db_creds_path"]:
        _run_update_db(opts["update_db_creds_path"], opts["local_db_dir"], logger)
    elif opts["clean_bucket_creds_path"]:
        _run_clean_bucket(opts["clean_bucket_creds_path"], opts["dry_run"], logger)
    else:
        return False
    return True


def _run_init_admin(creds_path: str, logger: Logger) -> None:
    admin_creds = load_creds(creds_path)
    AccountInitializer(admin_creds, admin_creds, creds_path, logger, "admin").run()


def _run_init_user(
    admin_creds_path: str | None, user_creds_path: str | None, logger: Logger
) -> None:
    if not admin_creds_path or not user_creds_path:
        raise click.UsageError(
            "--init-user requires --admin-creds CREDS_JSON and --user-creds CREDS_JSON"
        )
    admin_creds = load_creds(admin_creds_path)
    user_creds = load_user_creds(user_creds_path)
    AccountInitializer(admin_creds, user_creds, user_creds_path, logger, "user").run()


def _run_replace_images(dirs: tuple[str, str], logger: Logger) -> None:
    src, dst = dirs
    ImageReplacer(Path(src), Path(dst), logger).run()


def _run_ingest(
    src_dir: str, local_db_dir: str | None, creds_path: str | None, logger: Logger
) -> None:
    if not local_db_dir or not creds_path:
        raise click.UsageError(
            "--ingest requires --local-db-dir DIR and --creds CREDS_JSON"
        )
    TxtIngester(Path(src_dir), Path(local_db_dir), load_creds(creds_path), logger).run()


def _run_update_db(creds_path: str, local_db_dir: str | None, logger: Logger) -> None:
    if not local_db_dir:
        raise click.UsageError("--update-db requires --local-db-dir DIR")
    DbUpdater(load_creds(creds_path), Path(local_db_dir), logger).run()


def _run_clean_bucket(creds_path: str, dry_run: bool, logger: Logger) -> None:
    BucketCleaner(load_creds(creds_path), logger, dry_run=dry_run).run()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
