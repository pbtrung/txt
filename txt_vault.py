#!/usr/bin/env python3

import os
import re
import hmac as _hmac
import json
import base64
import ctypes
import ctypes.util
import brotli
import libsql
import click
from pathlib import Path

# ===== Constants =====

SALT_LEN = 64
TAG_LEN = 64
KEY_LEN = 64
IV_LEN = 64
HMAC_LEN = 32
MASTER_KEY_LEN = 128
PART_TARGET = 200 * 1024
BOOKMARK_LIMIT = 12
BATCH = 10

# ===== leancrypto loading =====


def _bind_hkdf_hmac(lib):
    S, CP, VP = ctypes.c_size_t, ctypes.c_char_p, ctypes.c_void_p
    lib.lc_hkdf.restype = ctypes.c_int
    lib.lc_hkdf.argtypes = [VP, CP, S, CP, S, CP, S, CP, S]
    lib.lc_hmac.restype = ctypes.c_int
    lib.lc_hmac.argtypes = [VP, CP, S, CP, S, CP]


def _bind_aead(lib):
    S, CP, VP = ctypes.c_size_t, ctypes.c_char_p, ctypes.c_void_p
    _A = [VP, CP, CP, S, CP, S, CP, S]
    lib.lc_ak_alloc_taglen.restype = ctypes.c_int
    lib.lc_ak_alloc_taglen.argtypes = [VP, ctypes.c_uint8, ctypes.POINTER(VP)]
    lib.lc_aead_setkey.restype = ctypes.c_int
    lib.lc_aead_setkey.argtypes = [VP, CP, S, CP, S]
    lib.lc_aead_encrypt.restype = ctypes.c_int
    lib.lc_aead_encrypt.argtypes = _A
    lib.lc_aead_decrypt.restype = ctypes.c_int
    lib.lc_aead_decrypt.argtypes = _A
    lib.lc_aead_zero_free.restype = None
    lib.lc_aead_zero_free.argtypes = [VP]


def _load_leancrypto():
    name = ctypes.util.find_library("leancrypto")
    if not name:
        raise RuntimeError("leancrypto not found; install it and run ldconfig")
    lib = ctypes.CDLL(name)
    sha3_512 = ctypes.c_void_p.in_dll(lib, "lc_sha3_512")
    sha3_256 = ctypes.c_void_p.in_dll(lib, "lc_sha3_256")
    _bind_hkdf_hmac(lib)
    _bind_aead(lib)
    return lib, sha3_512, sha3_256


_lib, _sha3_512, _sha3_256 = _load_leancrypto()

# ===== Schema =====

_SCHEMA = """
CREATE TABLE IF NOT EXISTS txt (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      BLOB NOT NULL,
    name_hmac BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    content  BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id_part_num ON txt_parts(txt_id, part_num);
CREATE TABLE IF NOT EXISTS part_count (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_access (
    txt_id        INTEGER PRIMARY KEY REFERENCES txt(id) ON DELETE CASCADE,
    last_part_num INTEGER NOT NULL DEFAULT 1,
    last_accessed INTEGER NOT NULL
);
"""

# Stored as a list to avoid splitting the trigger body on semicolons.
_BOOKMARKS_STMTS = [
    """
    CREATE TABLE IF NOT EXISTS bookmarks (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
        bookmark BLOB NOT NULL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_bookmarks_txt_id
        ON bookmarks(txt_id)
    """,
    f"""
    CREATE TRIGGER IF NOT EXISTS trg_limit_bookmarks_per_file
    BEFORE INSERT ON bookmarks
    WHEN (SELECT COUNT(*) FROM bookmarks WHERE txt_id = NEW.txt_id) >= {BOOKMARK_LIMIT}
    BEGIN
        DELETE FROM bookmarks
        WHERE id = (
            SELECT id FROM bookmarks
            WHERE txt_id = NEW.txt_id
            ORDER BY id ASC
            LIMIT 1
        );
    END
    """,
]

# ===== Utilities =====


def split_parts(content: bytes, target: int = PART_TARGET) -> list[bytes]:
    paras = re.split(rb"\r?\n\r?\n", content)
    parts, cur = [], b""
    for p in paras:
        chunk = p + b"\n\n"
        if cur and len(cur) + len(chunk) > target:
            parts.append(cur)
            cur = chunk
        else:
            cur += chunk
    if cur:
        parts.append(cur)
    return parts


def load_creds(path: str) -> dict:
    with open(path) as f:
        creds = json.load(f)
    url = os.environ.get("TURSO_DATABASE_URL") or creds.get("turso_database_url")
    token = os.environ.get("TURSO_AUTH_TOKEN") or creds.get("turso_auth_token")
    if not url or not token:
        raise ValueError("Missing Turso URL or auth token in creds or environment")
    creds["turso_database_url"] = url
    creds["turso_auth_token"] = token
    return creds


def get_master_key(creds: dict) -> bytes:
    raw = creds.get("master_key", "")
    if not raw:
        raise ValueError("No master_key in credentials; run --gen-master-key first")
    key = base64.b64decode(raw)
    if len(key) != MASTER_KEY_LEN:
        raise ValueError(f"master_key must be {MASTER_KEY_LEN} bytes, got {len(key)}")
    return key


# ===== Crypto =====


class Crypto:
    """All cryptographic operations: primitives, key derivation, encrypt/decrypt."""

    def __init__(self, master_key: bytes):
        self._mk = master_key

    def _hkdf(self, ikm: bytes, salt: bytes, length: int) -> bytes:
        out = ctypes.create_string_buffer(length)
        ret = _lib.lc_hkdf(
            _sha3_512, ikm, len(ikm), salt, len(salt), None, 0, out, length
        )
        if ret != 0:
            raise RuntimeError(f"lc_hkdf failed: {ret}")
        return bytes(out)

    def _hmac(self, key: bytes, data: bytes) -> bytes:
        out = ctypes.create_string_buffer(HMAC_LEN)
        ret = _lib.lc_hmac(_sha3_256, key, len(key), data, len(data), out)
        if ret != 0:
            raise RuntimeError(f"lc_hmac failed: {ret}")
        return bytes(out)

    def _aead_alloc(self):
        ctx = ctypes.c_void_p(None)
        ret = _lib.lc_ak_alloc_taglen(_sha3_512, TAG_LEN, ctypes.byref(ctx))
        if ret != 0:
            raise RuntimeError(f"lc_ak_alloc_taglen failed: {ret}")
        return ctx

    def _aead_encrypt(self, key: bytes, iv: bytes, pt: bytes, aad: bytes) -> bytes:
        ctx = self._aead_alloc()
        try:
            if _lib.lc_aead_setkey(ctx, key, len(key), iv, len(iv)) != 0:
                raise RuntimeError("lc_aead_setkey failed")
            ct = ctypes.create_string_buffer(len(pt))
            tag = ctypes.create_string_buffer(TAG_LEN)
            if (
                _lib.lc_aead_encrypt(ctx, pt, ct, len(pt), aad, len(aad), tag, TAG_LEN)
                != 0
            ):
                raise RuntimeError("lc_aead_encrypt failed")
            return bytes(ct) + bytes(tag)
        finally:
            _lib.lc_aead_zero_free(ctx)

    def _aead_decrypt(self, key: bytes, iv: bytes, ct_tag: bytes, aad: bytes) -> bytes:
        ctx = self._aead_alloc()
        try:
            if _lib.lc_aead_setkey(ctx, key, len(key), iv, len(iv)) != 0:
                raise RuntimeError("lc_aead_setkey failed")
            ct, tag = ct_tag[:-TAG_LEN], ct_tag[-TAG_LEN:]
            pt = ctypes.create_string_buffer(len(ct))
            if (
                _lib.lc_aead_decrypt(ctx, ct, pt, len(ct), aad, len(aad), tag, len(tag))
                != 0
            ):
                raise ValueError("AEAD tag verification failed")
            return bytes(pt)
        finally:
            _lib.lc_aead_zero_free(ctx)

    def _derive_part(self, salt: bytes) -> tuple[bytes, bytes]:
        okm = self._hkdf(self._mk, salt, KEY_LEN + IV_LEN)
        return okm[:KEY_LEN], okm[KEY_LEN:]

    def _derive_name(self, salt: bytes) -> tuple[bytes, bytes, bytes]:
        okm = self._hkdf(self._mk, salt, KEY_LEN + IV_LEN + HMAC_LEN)
        return okm[:KEY_LEN], okm[KEY_LEN : KEY_LEN + IV_LEN], okm[KEY_LEN + IV_LEN :]

    def encrypt_part(self, plaintext: bytes) -> bytes:
        compressed = brotli.compress(plaintext, quality=11)
        salt = os.urandom(SALT_LEN)
        key, iv = self._derive_part(salt)
        return salt + self._aead_encrypt(key, iv, compressed, salt)

    def decrypt_part(self, blob: bytes) -> bytes:
        salt, ct_tag = blob[:SALT_LEN], blob[SALT_LEN:]
        key, iv = self._derive_part(salt)
        return brotli.decompress(self._aead_decrypt(key, iv, ct_tag, salt))

    def encrypt_name(self, name: str) -> tuple[bytes, bytes]:
        name_b = name.encode()
        salt = os.urandom(SALT_LEN)
        key, iv, hmac_key = self._derive_name(salt)
        blob = salt + self._aead_encrypt(key, iv, name_b, salt)
        return blob, self._hmac(hmac_key, name_b)

    def decrypt_name(self, blob: bytes) -> str:
        salt, ct_tag = blob[:SALT_LEN], blob[SALT_LEN:]
        key, iv, _ = self._derive_name(salt)
        return self._aead_decrypt(key, iv, ct_tag, salt).decode()

    def find_txt_id(self, conn, name: str) -> int | None:
        name_b = name.encode()
        for row_id, name_blob, stored_mac in conn.execute(
            "SELECT id, name, name_hmac FROM txt"
        ).fetchall():
            salt = bytes(name_blob)[:SALT_LEN]
            _, _, hmac_key = self._derive_name(salt)
            if _hmac.compare_digest(self._hmac(hmac_key, name_b), bytes(stored_mac)):
                return row_id
        return None


# ===== VaultStore =====


class VaultStore:
    """Database connection and all storage operations."""

    def __init__(self, creds: dict, verbose: bool = False):
        if verbose:
            click.echo(f"leancrypto: {ctypes.util.find_library('leancrypto')}")
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
        content = filepath.read_bytes()
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
        if verbose:
            click.echo(f"  {table:<16}: {len(rows):>5} row(s)...", nl=False)
        for i, row in enumerate(rows):
            self._conn.execute(sql, tuple(row))
            if (i + 1) % BATCH == 0:
                self._conn.commit()
        self._conn.commit()
        if verbose:
            click.echo(" done")

    def upload_db(self, local_path: str, verbose: bool = False):
        import sqlite3 as _sqlite3

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


# ===== CLI =====


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
    if read_part_id is not None:
        if not out:
            raise click.UsageError("--out is required with --read-part")
        store.read_part(crypto, read_part_id, out, verbose=verbose)
    elif src:
        _cmd_ingest(store, crypto, src, verbose, force=force)


if __name__ == "__main__":
    main()
