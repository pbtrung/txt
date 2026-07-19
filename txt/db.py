"""Turso connection and schema application."""

import logging

import libsql

from .creds import Creds
from .leancrypto import library_name
from .schema import statements

logger = logging.getLogger(__name__)


class Database:
    """A Turso connection with the vault schema applied."""

    def __init__(self, creds: Creds) -> None:
        logger.debug("Using leancrypto: %s", library_name)
        logger.info("Connecting to Turso at %s", creds.turso_database_url)
        self.conn = libsql.connect(
            creds.turso_database_url, auth_token=creds.turso_auth_token
        )
        logger.debug("Connected to Turso")

    def apply_schema(self) -> None:
        stmts = statements()
        logger.info("Applying schema (%d statement(s))...", len(stmts))
        for stmt in stmts:
            self.conn.execute(stmt)
        self.conn.commit()
        logger.info("Applied %d schema statement(s)", len(stmts))
