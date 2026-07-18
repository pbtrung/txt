"""Admin CLI entrypoint (see docs/data_model.md, docs/crypto.md)."""

from pathlib import Path

import click

from .admin import AdminInitializer
from .admin_creds import AdminCreds
from .db import Database


def _cmd_init(admin_creds_path: str, verbose: bool) -> None:
    creds = AdminCreds.load(Path(admin_creds_path))
    db = Database(creds, verbose=verbose)
    db.apply_schema(verbose=verbose)
    password = click.prompt("Admin password", hide_input=True, confirmation_prompt=True)
    user_id = AdminInitializer(db, creds).run(password, verbose=verbose)
    click.echo(f"Initialized schema and admin user (id={user_id}, display_name={creds.display_name!r})")


@click.command()
@click.option("--init", "do_init", is_flag=True, help="Create schema and the admin user")
@click.option("--admin-creds", default="admin_creds.json", show_default=True)
@click.option("--verbose", "-v", is_flag=True)
def main(do_init: bool, admin_creds: str, verbose: bool) -> None:
    if do_init:
        _cmd_init(admin_creds, verbose)
        return
    raise click.UsageError("No action specified. Use --init.")
