from pathlib import Path
import libsql
import click
from .crypto import Crypto
from .utils import preprocess_text


class Downloader:
    def __init__(self, creds: dict):
        self._conn = libsql.connect(
            creds["turso_database_url"],
            auth_token=creds["turso_auth_token"],
        )

    def _all_txts(self):
        return self._conn.execute("SELECT id, name FROM txt").fetchall()

    def _fetch_part_blobs(self, txt_id: int) -> list[bytes]:
        rows = self._conn.execute(
            "SELECT content FROM txt_parts WHERE txt_id = ? ORDER BY part_num",
            (txt_id,),
        ).fetchall()
        return [bytes(r[0]) for r in rows]

    def _write_parts(self, dest: Path, blobs: list[bytes], crypto: Crypto, name: str, verbose: bool):
        dest.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        with dest.open("wb") as f:
            for i, blob in enumerate(blobs):
                plain = preprocess_text(crypto.decrypt_part(blob)).rstrip(b"\n")
                if i > 0:
                    f.write(b"\n\n")
                f.write(plain)
                total += len(plain)
            f.write(b"\n")
        if verbose:
            click.echo(f"  {name}: {len(blobs)} part(s) → {total:,}B")

    def download_all(self, crypto: Crypto, out_dir: str, verbose: bool = False):
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        for row in self._all_txts():
            txt_id, name_blob = row[0], bytes(row[1])
            try:
                name = crypto.decrypt_name(name_blob)
                blobs = self._fetch_part_blobs(txt_id)
                if not blobs:
                    continue
                self._write_parts(out / name, blobs, crypto, name, verbose)
            except Exception as e:
                click.echo(f"Warning: skipping id={txt_id}: {e}", err=True)
