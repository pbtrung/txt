"""--update-rql: applies pending numbered rqlite schema migrations.

Fresh databases receive the current schema snapshot from rqlite_schema.py,
including the markers for every migration represented by that snapshot. This
command applies later docker/migrations/NNNN_name.sql files to existing
databases in ascending order, each as one transactional batch. A VACUUM always
runs at the end, whether or not any migration applied.
"""

import sqlite3
from pathlib import Path

from .creds import OwnerCreds
from .logger import Logger
from .rqlite_client import RqliteClient

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "docker" / "migrations"


class RqliteUpdater:
    def __init__(
        self,
        creds: OwnerCreds,
        logger: Logger,
        *,
        rqlite: RqliteClient | None = None,
    ):
        self.logger = logger
        self.rqlite = rqlite or RqliteClient(
            creds.rqlite_operator_url,
            creds.rqlite_admin_username,
            creds.rqlite_admin_password,
        )

    def run(self) -> None:
        pending = self._pending_migrations(self._applied_names())
        if not pending:
            self.logger.info("rqlite schema is already up to date.")
        for name, path in pending:
            self._apply(name, path)
        self._vacuum()

    def _vacuum(self) -> None:
        self.logger.verbose("Vacuuming rqlite...")
        self.rqlite.vacuum()
        self.logger.info("rqlite vacuum complete.")

    def _applied_names(self) -> set[str]:
        rows = self.rqlite.query("SELECT name FROM schema_migrations")
        return {row["name"] for row in rows}

    def _pending_migrations(self, applied: set[str]) -> list[tuple[str, Path]]:
        migrations = []
        for path in sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql")):
            version, name = _parse_filename(path)
            if version > 1 and name not in applied:
                migrations.append((name, path))
        return migrations

    def _apply(self, name: str, path: Path) -> None:
        self.logger.info(f"Applying migration {path.name}...")
        self.rqlite.execute_batch(_split_statements(path.read_text()))
        self.logger.verbose(f"{path.name} applied.")


def _parse_filename(path: Path) -> tuple[int, str]:
    version_str, _, name = path.stem.partition("_")
    return int(version_str), name


def _split_statements(sql_text: str) -> list[str]:
    statements, buffer = [], []
    for char in sql_text:
        buffer.append(char)
        if char != ";":
            continue
        statement = _take_complete_statement(buffer)
        if statement:
            statements.append(statement)
    if not _comment_only("".join(buffer)):
        raise ValueError("migration ends with an incomplete SQL statement")
    return statements


def _take_complete_statement(buffer: list[str]) -> str | None:
    candidate = "".join(buffer)
    if not sqlite3.complete_statement(candidate):
        return None
    buffer.clear()
    return _strip_leading_comments(candidate[:-1])


def _strip_leading_comments(sql: str) -> str:
    lines = sql.strip().splitlines()
    while lines and (not lines[0].strip() or lines[0].lstrip().startswith("--")):
        lines.pop(0)
    return "\n".join(lines).strip()


def _comment_only(sql: str) -> bool:
    return all(
        not line.strip() or line.lstrip().startswith("--") for line in sql.splitlines()
    )
