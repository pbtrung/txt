"""Admin CLI entrypoint (see docs/data_model.md, docs/crypto.md)."""

import asyncio
import logging
from pathlib import Path

import click

from .admin import AdminInitializer
from .creds import AdminCreds
from .db import Database
from .delete import TxtDeleter
from .download import TxtDownloader
from .ingest import TxtIngester


def _cmd_init(admin_creds_path: str) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds)
    db.apply_schema()
    user_id = AdminInitializer(db, creds).run()
    click.echo(
        f"Initialized schema and admin user (id={user_id}, username={creds.username!r}, "
        f"display_name={creds.display_name!r})"
    )


def _cmd_add_txt(admin_creds_path: str, src: str) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds)
    txt_ids = asyncio.run(TxtIngester(db, creds).add_dir(Path(src)))
    click.echo(f"Ingested {len(txt_ids)} file(s): txt_id(s) = {txt_ids}")


def _cmd_download(admin_creds_path: str, dst: str) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds)
    paths = asyncio.run(TxtDownloader(db, creds).download_all(Path(dst)))
    click.echo(f"Downloaded {len(paths)} file(s) to {dst}")


def _cmd_delete_txt(admin_creds_path: str, skip_confirm: bool) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    if not skip_confirm:
        click.confirm(
            f"Delete ALL txt (and their R2 parts) for username={creds.username!r}? "
            "This cannot be undone.",
            abort=True,
        )
    db = Database(creds)
    count = asyncio.run(TxtDeleter(db, creds).delete_all())
    click.echo(f"Deleted {count} txt(s) and their R2 parts")


@click.command()
@click.option(
    "--init", "do_init", is_flag=True, help="Create schema and the admin user"
)
@click.option(
    "--add-txt",
    "add_txt_dir",
    metavar="DIR",
    default=None,
    help="Ingest .txt files (case-insensitive) from DIR",
)
@click.option(
    "--download",
    "download_dir",
    metavar="DIR",
    default=None,
    help="Download all txt (concatenated parts) to DIR",
)
@click.option(
    "--delete-txt",
    "do_delete_txt",
    is_flag=True,
    help="Delete all txt and their R2 parts",
)
@click.option(
    "--admin-creds",
    default="admin_creds.json",
    show_default=True,
    help="Credential JSON file, required by --init, --add-txt, --download, and --delete-txt",
)
@click.option(
    "--yes",
    "-y",
    "skip_confirm",
    is_flag=True,
    help="Skip the --delete-txt confirmation prompt",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable debug-level logging")
def main(
    do_init: bool,
    add_txt_dir: str | None,
    download_dir: str | None,
    do_delete_txt: bool,
    admin_creds: str,
    skip_confirm: bool,
    verbose: bool,
) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)-10s %(message)s",
    )
    # boto3/botocore/s3transfer/urllib3 are extremely chatty at DEBUG (full
    # request/response dumps) -- keep them quiet even under --verbose, which
    # is meant to surface *this* codebase's own steps, not the SDK's internals.
    for noisy in ("boto3", "botocore", "s3transfer", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if do_init:
        _cmd_init(admin_creds)
        return
    if add_txt_dir is not None:
        _cmd_add_txt(admin_creds, add_txt_dir)
        return
    if download_dir is not None:
        _cmd_download(admin_creds, download_dir)
        return
    if do_delete_txt:
        _cmd_delete_txt(admin_creds, skip_confirm)
        return
    raise click.UsageError(
        "No action specified. Use --init, --add-txt DIR, --download DIR, or --delete-txt."
    )
