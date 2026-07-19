"""Admin CLI entrypoint (see docs/data_model.md, docs/crypto.md)."""

import logging
from pathlib import Path

import click

from .admin import AdminInitializer
from .creds import AdminCreds
from .db import Database
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
    txt_ids = TxtIngester(db, creds).add_dir(Path(src))
    click.echo(f"Ingested {len(txt_ids)} file(s): txt_id(s) = {txt_ids}")


@click.command()
@click.option(
    "--init", "do_init", is_flag=True, help="Create schema and the admin user"
)
@click.option(
    "--add-txt", "do_add_txt", is_flag=True, help="Ingest .txt files from --src"
)
@click.option(
    "--admin-creds",
    default="admin_creds.json",
    show_default=True,
    help="Credential JSON file, required by --init and --add-txt",
)
@click.option(
    "--src",
    default="txt_src",
    show_default=True,
    help="Directory to scan for .txt files (case-insensitive), with --add-txt",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable debug-level logging")
def main(
    do_init: bool, do_add_txt: bool, admin_creds: str, src: str, verbose: bool
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
    if do_add_txt:
        _cmd_add_txt(admin_creds, src)
        return
    raise click.UsageError("No action specified. Use --init or --add-txt.")
