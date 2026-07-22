"""Admin CLI entrypoint (see docs/data_model.md, docs/crypto.md)."""

import asyncio
import logging
from pathlib import Path

import click

from .admin import AdminInitializer
from .bucket import BucketPurger, TxtBucketCleaner
from .creds import AdminCreds
from .db import Database
from .delete import TxtDeleter
from .download import TxtDownloader
from .ingest import TxtIngester
from .schema_update import SchemaUpdater


def _confirm_destructive(message: str, skip_confirm: bool) -> None:
    if not skip_confirm:
        click.confirm(message, abort=True)


def _cmd_init(admin_creds_path: str) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds)
    db.apply_schema()
    user_id = AdminInitializer(db, creds).run()
    click.echo(
        f"Initialized schema and admin user (id={user_id}, username={creds.username!r}, "
        f"display_name={creds.display_name!r})"
    )


def _cmd_update_schema(admin_creds_path: str) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds)
    user_id = SchemaUpdater(db, creds).run()
    click.echo(
        f"Updated schema: dropped old txt_access/bookmarks design, recreated "
        f"current tables, and backfilled txt_access_key/bookmark_key for "
        f"user_id={user_id}"
    )


def _cmd_txt_ingest(admin_creds_path: str, src: str) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds)
    txt_ids = asyncio.run(TxtIngester(db, creds).add_dir(Path(src)))
    click.echo(f"Ingested {len(txt_ids)} file(s): txt_id(s) = {txt_ids}")


def _cmd_txt_download(admin_creds_path: str, dst: str) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds)
    paths = asyncio.run(TxtDownloader(db, creds).download_all(Path(dst)))
    click.echo(f"Downloaded {len(paths)} file(s) to {dst}")


def _cmd_txt_delete(admin_creds_path: str, skip_confirm: bool) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    _confirm_destructive(
        f"Delete ALL txt (and their R2 parts) for username={creds.username!r}? This cannot be undone.",
        skip_confirm,
    )
    db = Database(creds)
    count = asyncio.run(TxtDeleter(db, creds).delete_all())
    click.echo(f"Deleted {count} txt(s) and their R2 parts")


def _cmd_purge_bucket(admin_creds_path: str, skip_confirm: bool) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    _confirm_destructive(
        "Delete EVERY object in the R2 bucket, regardless of what's tracked in the DB? This cannot be undone.",
        skip_confirm,
    )
    count = asyncio.run(BucketPurger(creds).purge_all())
    click.echo(f"Purged {count} object(s) from the R2 bucket")


def _cmd_txt_clean_bucket(admin_creds_path: str, skip_confirm: bool) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    _confirm_destructive(
        f"Delete every R2 object not referenced by any txt in the DB for username={creds.username!r}? "
        "This cannot be undone.",
        skip_confirm,
    )
    db = Database(creds)
    count = asyncio.run(TxtBucketCleaner(db, creds).clean_bucket())
    click.echo(f"Deleted {count} orphaned object(s) from the R2 bucket")


@click.command()
@click.option(
    "--init", "do_init", is_flag=True, help="Create schema and the admin user"
)
@click.option(
    "--update-schema",
    "do_update_schema",
    is_flag=True,
    help=(
        "Migrate an existing DB's txt_access/bookmarks from the old "
        "per-(txt_id,user_id)-row design to the current one-row-per-user "
        "design (drops and recreates both tables, losing existing rows)"
    ),
)
@click.option(
    "--txt-ingest",
    "txt_ingest_dir",
    metavar="DIR",
    default=None,
    help="Ingest .txt files (case-insensitive) from DIR",
)
@click.option(
    "--txt-download",
    "txt_download_dir",
    metavar="DIR",
    default=None,
    help="Download all txt (concatenated parts) to DIR",
)
@click.option(
    "--txt-delete",
    "do_txt_delete",
    is_flag=True,
    help="Delete all txt and their R2 parts",
)
@click.option(
    "--purge-bucket",
    "do_purge_bucket",
    is_flag=True,
    help="Delete every object in the R2 bucket, regardless of the DB",
)
@click.option(
    "--txt-clean-bucket",
    "do_txt_clean_bucket",
    is_flag=True,
    help="Delete every R2 object not referenced by any txt in the DB",
)
@click.option(
    "--admin-creds",
    default="admin_creds.json",
    show_default=True,
    help=(
        "Credential JSON file, required by --init, --update-schema, "
        "--txt-ingest, --txt-download, --txt-delete, --purge-bucket, "
        "and --txt-clean-bucket"
    ),
)
@click.option(
    "--yes",
    "-y",
    "skip_confirm",
    is_flag=True,
    help="Skip the --txt-delete/--purge-bucket/--txt-clean-bucket confirmation prompt",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable debug-level logging")
def main(
    do_init: bool,
    do_update_schema: bool,
    txt_ingest_dir: str | None,
    txt_download_dir: str | None,
    do_txt_delete: bool,
    do_purge_bucket: bool,
    do_txt_clean_bucket: bool,
    admin_creds: str,
    skip_confirm: bool,
    verbose: bool,
) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-6s %(name)s %(message)s",
    )
    # boto3/botocore/s3transfer/urllib3 are extremely chatty at DEBUG (full
    # request/response dumps) -- keep them quiet even under --verbose, which
    # is meant to surface *this* codebase's own steps, not the SDK's internals.
    for noisy in ("boto3", "botocore", "s3transfer", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if do_init:
        _cmd_init(admin_creds)
        return
    if do_update_schema:
        _cmd_update_schema(admin_creds)
        return
    if txt_ingest_dir is not None:
        _cmd_txt_ingest(admin_creds, txt_ingest_dir)
        return
    if txt_download_dir is not None:
        _cmd_txt_download(admin_creds, txt_download_dir)
        return
    if do_txt_delete:
        _cmd_txt_delete(admin_creds, skip_confirm)
        return
    if do_purge_bucket:
        _cmd_purge_bucket(admin_creds, skip_confirm)
        return
    if do_txt_clean_bucket:
        _cmd_txt_clean_bucket(admin_creds, skip_confirm)
        return
    raise click.UsageError(
        "No action specified. Use --init, --update-schema, --txt-ingest DIR, "
        "--txt-download DIR, --txt-delete, --purge-bucket, or --txt-clean-bucket."
    )
