import sqlite3 as _sqlite3
from pathlib import Path
import libsql
import click
from .constants import BATCH
from .leancrypto import library_name as _lc_name
from .schema import _SCHEMA, _BOOKMARKS_STMTS
from .crypto import Crypto
from .utils import split_parts, preprocess_text


class VaultStore:
    """Database connection and all storage operations."""

    def __init__(self, creds: dict, verbose: bool = False):
        if verbose:
            click.echo(f"leancrypto: {_lc_name}")
            click.echo(f"Turso URL: {creds['turso_database_url']}")
        self._conn = libsql.connect(
            creds["turso_database_url"],
            auth_token=creds["turso_auth_token"],
        )
        self._apply_schema()
        if verbose:
            n = self._conn.execute("SELECT COUNT(*) FROM txt").fetchone()[0]
            click.echo(f"Connected: {n} txt row(s)")

    def _apply_schema(self):
        for stmt in _SCHEMA.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                self._conn.execute(stmt)

    def _insert_parts(
        self, crypto: Crypto, txt_id: int, parts: list[bytes], verbose: bool
    ):
        total_plain = total_blob = 0
        for i, part in enumerate(parts):
            blob = crypto.encrypt_part(part)
            self._conn.execute(
                "INSERT INTO txt_parts (txt_id, part_num, content) VALUES (?, ?, ?)",
                (txt_id, i + 1, blob),
            )
            total_plain += len(part)
            total_blob += len(blob)
            if verbose:
                click.echo(
                    f"  part {i+1}/{len(parts)}: {len(part):,}B → {len(blob):,}B"
                )
        if verbose and len(parts) > 1:
            click.echo(
                f"  total: {total_plain:,}B → {total_blob:,}B ({total_plain/total_blob:.2f}x)"
            )

    def _resolve_txt_id(
        self, crypto: Crypto, stored_name: str, force: bool, verbose: bool
    ) -> tuple[int | None, str | None]:
        txt_id = crypto.find_txt_id(self._conn, stored_name)
        if txt_id is not None and not force:
            if verbose:
                click.echo(
                    f"  [skip] {stored_name} already exists (use --force to overwrite)"
                )
            return None, None
        if txt_id is None:
            name_blob, name_mac = crypto.encrypt_name(stored_name)
            cur = self._conn.execute(
                "INSERT INTO txt (name, name_hmac) VALUES (?, ?)", (name_blob, name_mac)
            )
            return cur.lastrowid, "new"
        self._conn.execute("DELETE FROM txt_parts WHERE txt_id = ?", (txt_id,))
        return txt_id, "update"

    def ingest_file(
        self,
        crypto: Crypto,
        filepath: Path,
        stored_name: str,
        verbose: bool,
        force: bool = False,
    ):
        content = preprocess_text(filepath.read_bytes())
        parts = split_parts(content)
        txt_id, action = self._resolve_txt_id(crypto, stored_name, force, verbose)
        if txt_id is None:
            return
        if verbose:
            click.echo(
                f"  [{action}] txt_id={txt_id}, {len(content):,}B, {len(parts)} part(s)"
            )
        self._insert_parts(crypto, txt_id, parts, verbose)
        self._conn.execute(
            "INSERT OR REPLACE INTO part_count (txt_id, count) VALUES (?, ?)",
            (txt_id, len(parts)),
        )
        self._conn.commit()
        if verbose:
            click.echo("  committed")

    def create_bookmarks(self, verbose: bool = False):
        labels = ["table", "index", "trigger"]
        for label, stmt in zip(labels, _BOOKMARKS_STMTS):
            if verbose:
                click.echo(f"  Creating {label}...", nl=False)
            self._conn.execute(stmt.strip())
            if verbose:
                click.echo(" done")
        self._conn.commit()
        if verbose:
            click.echo("  Committed.")

    def recreate_bookmarks(self, verbose: bool = False):
        if verbose:
            click.echo("  Dropping existing bookmarks table...", nl=False)
        self._conn.execute("DROP TABLE IF EXISTS bookmarks")
        self._conn.commit()
        if verbose:
            click.echo(" done")
        self.create_bookmarks(verbose=verbose)

    def rebuild_part_count(self, verbose: bool = False):
        self._conn.execute("DELETE FROM part_count")
        self._conn.execute("""
            INSERT INTO part_count (txt_id, count)
            SELECT txt_id, COUNT(*) FROM txt_parts GROUP BY txt_id
        """)
        self._conn.commit()
        if verbose:
            n = self._conn.execute("SELECT COUNT(*) FROM part_count").fetchone()[0]
            click.echo(f"Rebuilt part_count for {n} txt row(s)")

    def _table_names(self, conn) -> set[str]:
        return {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master"
                " WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }

    def _ensure_upload_schema(self, local_t: set, turso_t: set, verbose: bool):
        if verbose:
            click.echo(f"local : {', '.join(sorted(local_t))}")
            click.echo(f"turso : {', '.join(sorted(turso_t)) or '(empty)'}")
        if "bookmarks" in local_t and "bookmarks" not in turso_t:
            if verbose:
                click.echo("bookmarks missing on Turso — creating:")
            self.create_bookmarks(verbose=verbose)

    def _check_turso_empty(self):
        n = self._conn.execute("SELECT COUNT(*) FROM txt").fetchone()[0]
        if n > 0:
            raise click.ClickException(
                f"Turso txt already has {n} row(s); aborting to avoid duplicates"
            )

    def _upload_rows(self, rows, sql: str, verbose: bool, label: str):
        if verbose:
            click.echo(f"  {label:<16}: {len(rows):>5} row(s)...", nl=False)
        for i, row in enumerate(rows):
            self._conn.execute(sql, tuple(row))
            if (i + 1) % BATCH == 0:
                self._conn.commit()
        self._conn.commit()
        if verbose:
            click.echo(" done")

    def _upload_table(self, local, table: str, verbose: bool):
        rows = local.execute(f"SELECT * FROM {table}").fetchall()
        if not rows:
            if verbose:
                click.echo(f"  {table:<16}:  0 rows, skipped")
            return
        cols = rows[0].keys()
        sql = (
            f"INSERT INTO {table} ({', '.join(cols)})"
            f" VALUES ({', '.join('?' * len(cols))})"
        )
        self._upload_rows(rows, sql, verbose, table)

    def upload_db(self, local_path: str, verbose: bool = False):
        local = _sqlite3.connect(local_path)
        local.row_factory = _sqlite3.Row
        local_t = self._table_names(local)
        turso_t = self._table_names(self._conn)
        self._ensure_upload_schema(local_t, turso_t, verbose)
        self._check_turso_empty()
        for table in ["txt", "txt_parts", "part_count", "txt_access", "bookmarks"]:
            if table not in local_t:
                if verbose:
                    click.echo(f"  {table:<16}: not in local db, skipped")
                continue
            self._upload_table(local, table, verbose)
        local.close()

    def read_part(
        self, crypto: Crypto, part_id: int, out_path: str, verbose: bool = False
    ):
        row = self._conn.execute(
            "SELECT content FROM txt_parts WHERE id = ?", (part_id,)
        ).fetchone()
        if not row:
            raise ValueError(f"No part with id={part_id}")
        blob = bytes(row[0])
        data = crypto.decrypt_part(blob)
        Path(out_path).write_bytes(data)
        if verbose:
            click.echo(
                f"Part {part_id}: {len(blob):,}B blob → {len(data):,}B plain → {out_path}"
            )
