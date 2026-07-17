from pathlib import Path
from typing import Iterator
import libsql
import click
from .crypto import Crypto
from .utils import preprocess_text


class Downloader:
    def __init__(self, creds: dict):
        self._creds = creds
        self._connect()

    def _connect(self):
        self._conn = libsql.connect(
            self._creds["turso_database_url"],
            auth_token=self._creds["turso_auth_token"],
        )

    def _all_txts(self):
        return self._conn.execute("SELECT id, name FROM txt").fetchall()

    def _fetch_part_blobs(self, txt_id: int) -> Iterator[bytes]:
        cursor = self._conn.execute(
            "SELECT content FROM txt_parts WHERE txt_id = ? ORDER BY part_num",
            (txt_id,),
        )
        for row in cursor:
            yield bytes(row[0])

    def _write_blobs(
        self, f, blobs: Iterator[bytes], crypto: Crypto
    ) -> tuple[int, int]:
        count, total = 0, 0
        for blob in blobs:
            plain = preprocess_text(crypto.decrypt_part(blob)).rstrip(b"\n")
            if count > 0:
                f.write(b"\n\n")
            f.write(plain)
            total += len(plain)
            count += 1
        if count:
            f.write(b"\n")
        return count, total

    def _write_parts(
        self,
        dest: Path,
        blobs: Iterator[bytes],
        crypto: Crypto,
        name: str,
        verbose: bool,
    ):
        dest.parent.mkdir(parents=True, exist_ok=True)
        if verbose:
            click.echo(f"  {name}: downloading...", nl=False)
        with dest.open("wb") as f:
            count, total = self._write_blobs(f, blobs, crypto)
        if not count:
            dest.unlink(missing_ok=True)
            if verbose:
                click.echo(" skipped (empty)")
            return
        if verbose:
            click.echo(f" {count} part(s) → {total:,}B")

    def download_all(self, crypto: Crypto, out_dir: str, verbose: bool = False):
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        for row in self._all_txts():
            txt_id, name_blob = row[0], bytes(row[1])
            for attempt in range(2):
                try:
                    name = crypto.decrypt_name(name_blob)
                    self._write_parts(
                        out / name,
                        self._fetch_part_blobs(txt_id),
                        crypto,
                        name,
                        verbose,
                    )
                    break
                except Exception as e:
                    if attempt == 0 and "stream not found" in str(e):
                        self._connect()
                        continue
                    click.echo(f"Warning: skipping id={txt_id}: {e}", err=True)
                    break
