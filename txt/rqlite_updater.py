"""--update-rql: applies pending numbered rqlite schema migrations.

docker/migrations/0001_control.sql is the initial schema, installed
automatically by --init-owner/--migrate when rqlite is empty. Every later
docker/migrations/NNNN_name.sql file is applied here instead, each as one
transactional batch, in ascending order, skipped once its own trailing
INSERT INTO schema_migrations has recorded its name as already applied.
A VACUUM always runs at the end, whether or not any migration applied.
"""

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
    without_comments = "\n".join(
        line for line in sql_text.splitlines() if not line.strip().startswith("--")
    )
    return [
        statement.strip()
        for statement in without_comments.split(";")
        if statement.strip()
    ]
