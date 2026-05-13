import os
import json
import base64
import click
from pathlib import Path
from .constants import MASTER_KEY_LEN
from .utils import load_creds, get_master_key
from .crypto import Crypto
from .store import VaultStore, Downloader


def _cmd_gen_master_key(path: str):
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        data = {}
    if "master_key" in data:
        click.confirm("master_key already exists. Overwrite?", abort=True)
    data["master_key"] = base64.b64encode(os.urandom(MASTER_KEY_LEN)).decode()
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    click.echo(f"master_key written to {path}")


def _cmd_ingest(
    store: VaultStore, crypto: Crypto, src: str, verbose: bool, force: bool
):
    src_path = Path(src)
    files = sorted(p for p in src_path.rglob("*") if p.suffix.lower() == ".txt")
    if verbose:
        click.echo(f"Found {len(files)} .txt file(s) under {src_path}")
    for fp in files:
        stored_name = str(fp.relative_to(src_path))
        if verbose:
            click.echo(f"Ingesting {stored_name}")
        try:
            store.ingest_file(crypto, fp, stored_name, verbose, force=force)
        except Exception as e:
            click.echo(f"Warning: skipping {fp}: {e}", err=True)


def _dispatch_admin(
    store: VaultStore,
    do_recreate_bookmarks: bool,
    do_create_bookmarks: bool,
    upload_db_path: str | None,
    do_part_count: bool,
    verbose: bool,
) -> bool:
    if do_recreate_bookmarks:
        store.recreate_bookmarks(verbose=verbose)
        return True
    if do_create_bookmarks:
        store.create_bookmarks(verbose=verbose)
        return True
    if upload_db_path:
        store.upload_db(upload_db_path, verbose=verbose)
        return True
    if do_part_count:
        store.rebuild_part_count(verbose=verbose)
        return True
    return False


@click.command()
@click.option("--download", "do_download", is_flag=True, help="Download all files to --out directory")
@click.option("--src", type=click.Path(exists=True))
@click.option(
    "--force", is_flag=True, help="Overwrite existing entries when using --src"
)
@click.option("--creds", default="creds.json", show_default=True)
@click.option("--part-count", "do_part_count", is_flag=True)
@click.option("--create-bookmarks", "do_create_bookmarks", is_flag=True)
@click.option("--recreate-bookmarks", "do_recreate_bookmarks", is_flag=True)
@click.option(
    "--upload-db", "upload_db_path", type=click.Path(exists=True), metavar="FILE"
)
@click.option("--gen-master-key", "gen_key_path", metavar="PATH")
@click.option("--read-part", "read_part_id", type=int)
@click.option("--out")
@click.option("--verbose", "-v", is_flag=True)
def main(
    do_download,
    src,
    force,
    creds,
    do_part_count,
    do_create_bookmarks,
    do_recreate_bookmarks,
    upload_db_path,
    gen_key_path,
    read_part_id,
    out,
    verbose,
):
    if gen_key_path:
        _cmd_gen_master_key(gen_key_path)
        return
    loaded = load_creds(creds)
    store = VaultStore(loaded, verbose=verbose)
    if _dispatch_admin(
        store,
        do_recreate_bookmarks,
        do_create_bookmarks,
        upload_db_path,
        do_part_count,
        verbose,
    ):
        return
    crypto = Crypto(get_master_key(loaded))
    if do_download:
        if not out:
            raise click.UsageError("--out is required with --download")
        Downloader(loaded).download_all(crypto, out, verbose=verbose)
    elif read_part_id is not None:
        if not out:
            raise click.UsageError("--out is required with --read-part")
        store.read_part(crypto, read_part_id, out, verbose=verbose)
    elif src:
        _cmd_ingest(store, crypto, src, verbose, force=force)
