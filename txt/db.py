"""Turso connection and schema application."""

import click
import libsql

from .admin_creds import AdminCreds
from .leancrypto import library_name
from .schema import statements


class Database:
    """A Turso connection with the vault schema applied."""

    def __init__(self, creds: AdminCreds, verbose: bool = False) -> None:
        if verbose:
            click.echo(f"leancrypto: {library_name}")
            click.echo(f"Turso URL: {creds.turso_database_url}")
        self.conn = libsql.connect(creds.turso_database_url, auth_token=creds.turso_auth_token)

    def apply_schema(self, verbose: bool = False) -> None:
        stmts = statements()
        for stmt in stmts:
            self.conn.execute(stmt)
        self.conn.commit()
        if verbose:
            click.echo(f"Applied {len(stmts)} schema statement(s)")

    def username_exists(self, username_hash: bytes) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM users WHERE username_hash = ?", (username_hash,)
        ).fetchone()
        return row is not None
