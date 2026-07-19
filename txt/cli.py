"""Admin CLI entrypoint (see docs/data_model.md, docs/crypto.md)."""

import logging
from pathlib import Path

import click

from .admin import AdminInitializer
from .creds import AdminCreds
from .db import Database


def _cmd_init(admin_creds_path: str) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds)
    db.apply_schema()
    user_id = AdminInitializer(db, creds).run()
    click.echo(
        f"Initialized schema and admin user (id={user_id}, username={creds.username!r}, "
        f"display_name={creds.display_name!r})"
    )


@click.command()
@click.option(
    "--init", "do_init", is_flag=True, help="Create schema and the admin user"
)
@click.option("--admin-creds", default="admin_creds.json", show_default=True)
@click.option("--verbose", "-v", is_flag=True, help="Enable debug-level logging")
def main(do_init: bool, admin_creds: str, verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)-10s %(message)s",
    )
    if do_init:
        _cmd_init(admin_creds)
        return
    raise click.UsageError("No action specified. Use --init.")
