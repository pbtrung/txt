from pathlib import Path

import click

from .admin_init import AdminInitializer
from .clean_bucket import BucketCleaner
from .creds import load_creds
from .gc import GarbageCollector
from .ingest import TxtIngester
from .init_db import DbInitializer
from .init_user import UserInitializer
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
    help="Initialize this user's own database (admin or otherwise); "
    "with --admin-creds/--user-creds instead, also pushes the backup to the admin's AA",
)
@click.option(
    "--init-user",
    "init_user_flag",
    is_flag=True,
    help="Register an ordinary user's ctl.users row (needs --admin-creds/--user-creds)",
)
@click.option(
    "--admin-creds",
    "admin_only_creds_path",
    metavar="CREDS_JSON",
    help="Administrator's own creds.json, for --init-user or --init-db's cross-account form",
)
@click.option(
    "--user-creds",
    "user_only_creds_path",
    metavar="CREDS_JSON",
    help="Ordinary user's own creds.json, for --init-user or --init-db's cross-account form",
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
    "--collect-garbage",
    "collect_garbage",
    is_flag=True,
    help="Reclaim superseded BB pages and orphaned R2 objects (needs --creds)",
)
@click.option(
    "--clean-bucket",
    "clean_bucket",
    is_flag=True,
    help="Sweep R2 for whole account prefixes unknown to ctl.users (needs --creds)",
)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="With --clean-bucket, report what would be deleted without deleting anything",
)
@click.option(
    "--creds",
    "creds_path",
    metavar="CREDS_JSON",
    help="creds.json for --ingest/--collect-garbage/--clean-bucket",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(
    ctx: click.Context,
    admin_creds_path: str | None,
    db_creds_path: str | None,
    init_user_flag: bool,
    admin_only_creds_path: str | None,
    user_only_creds_path: str | None,
    replace_images_dirs: tuple[str, str],
    ingest_dir: str | None,
    collect_garbage: bool,
    clean_bucket: bool,
    dry_run: bool,
    creds_path: str | None,
    verbose: bool,
) -> None:
    logger = Logger(verbose)
    if init_user_flag:
        _run_init_user(admin_only_creds_path, user_only_creds_path, logger)
    elif admin_only_creds_path and user_only_creds_path:
        _run_init_db_cross_account(admin_only_creds_path, user_only_creds_path, logger)
    elif admin_creds_path:
        AdminInitializer(load_creds(admin_creds_path), logger).run()
    elif db_creds_path:
        DbInitializer(load_creds(db_creds_path), db_creds_path, logger).run()
    elif replace_images_dirs:
        _run_replace_images(replace_images_dirs, logger)
    elif ingest_dir:
        _run_ingest(ingest_dir, creds_path, logger)
    elif collect_garbage:
        _run_collect_garbage(creds_path, logger)
    elif clean_bucket:
        _run_clean_bucket(creds_path, dry_run, logger)
    else:
        click.echo(ctx.get_help())


def _run_init_user(
    admin_creds_path: str | None, user_creds_path: str | None, logger: Logger
) -> None:
    if not admin_creds_path or not user_creds_path:
        raise click.UsageError("--init-user requires --admin-creds and --user-creds")
    UserInitializer(
        load_creds(admin_creds_path), load_creds(user_creds_path), logger
    ).run()


def _run_init_db_cross_account(
    admin_creds_path: str, user_creds_path: str, logger: Logger
) -> None:
    DbInitializer(
        load_creds(user_creds_path),
        user_creds_path,
        logger,
        admin_creds=load_creds(admin_creds_path),
    ).run()


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


def _run_collect_garbage(creds_path: str | None, logger: Logger) -> None:
    if not creds_path:
        raise click.UsageError("--collect-garbage requires --creds CREDS_JSON")
    collector = GarbageCollector(load_creds(creds_path), logger)
    try:
        collector.run()
    finally:
        collector.bb.close()


def _run_clean_bucket(creds_path: str | None, dry_run: bool, logger: Logger) -> None:
    if not creds_path:
        raise click.UsageError("--clean-bucket requires --creds CREDS_JSON")
    BucketCleaner(load_creds(creds_path), dry_run, logger).run()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
