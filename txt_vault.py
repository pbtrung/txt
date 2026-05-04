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
PART_TARGET = 100 * 1024

# ===== leancrypto bindings =====


def _bind_hkdf_hmac(lib):
    lib.lc_hkdf.restype = ctypes.c_int
    lib.lc_hkdf.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_char_p,
        ctypes.c_size_t,
    ]
    lib.lc_hmac.restype = ctypes.c_int
    lib.lc_hmac.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_char_p,
    ]


def _bind_aead(lib):
    _A = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_char_p,
        ctypes.c_size_t,
    ]
    lib.lc_ak_alloc_taglen.restype = ctypes.c_int
    lib.lc_ak_alloc_taglen.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint8,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    lib.lc_aead_setkey.restype = ctypes.c_int
    lib.lc_aead_setkey.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_char_p,
        ctypes.c_size_t,
    ]
    lib.lc_aead_encrypt.restype = ctypes.c_int
    lib.lc_aead_encrypt.argtypes = _A
    lib.lc_aead_decrypt.restype = ctypes.c_int
    lib.lc_aead_decrypt.argtypes = _A
    lib.lc_aead_zero_free.restype = None
    lib.lc_aead_zero_free.argtypes = [ctypes.c_void_p]


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

# ===== Crypto primitives =====


def hkdf(ikm: bytes, salt: bytes, length: int) -> bytes:
    out = ctypes.create_string_buffer(length)
    ret = _lib.lc_hkdf(_sha3_512, ikm, len(ikm), salt, len(salt), None, 0, out, length)
    if ret != 0:
        raise RuntimeError(f"lc_hkdf failed: {ret}")
    return bytes(out)


def hmac_sha3_256(key: bytes, data: bytes) -> bytes:
    out = ctypes.create_string_buffer(HMAC_LEN)
    ret = _lib.lc_hmac(_sha3_256, key, len(key), data, len(data), out)
    if ret != 0:
        raise RuntimeError(f"lc_hmac failed: {ret}")
    return bytes(out)


def _aead_alloc():
    ctx = ctypes.c_void_p(None)
    ret = _lib.lc_ak_alloc_taglen(_sha3_512, TAG_LEN, ctypes.byref(ctx))
    if ret != 0:
        raise RuntimeError(f"lc_ak_alloc_taglen failed: {ret}")
    return ctx


def aead_encrypt(key: bytes, iv: bytes, pt: bytes, aad: bytes) -> bytes:
    ctx = _aead_alloc()
    try:
        if _lib.lc_aead_setkey(ctx, key, len(key), iv, len(iv)) != 0:
            raise RuntimeError("lc_aead_setkey failed")
        ct = ctypes.create_string_buffer(len(pt))
        tag = ctypes.create_string_buffer(TAG_LEN)
        if _lib.lc_aead_encrypt(ctx, pt, ct, len(pt), aad, len(aad), tag, TAG_LEN) != 0:
            raise RuntimeError("lc_aead_encrypt failed")
        return bytes(ct) + bytes(tag)
    finally:
        _lib.lc_aead_zero_free(ctx)


def aead_decrypt(key: bytes, iv: bytes, ct_tag: bytes, aad: bytes) -> bytes:
    ctx = _aead_alloc()
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


# ===== Key derivation =====


def _derive_part(master_key: bytes, salt: bytes) -> tuple[bytes, bytes]:
    okm = hkdf(master_key, salt, KEY_LEN + IV_LEN)
    return okm[:KEY_LEN], okm[KEY_LEN:]


def _derive_name(master_key: bytes, salt: bytes) -> tuple[bytes, bytes, bytes]:
    okm = hkdf(master_key, salt, KEY_LEN + IV_LEN + HMAC_LEN)
    return okm[:KEY_LEN], okm[KEY_LEN : KEY_LEN + IV_LEN], okm[KEY_LEN + IV_LEN :]


# ===== Encryption =====


def encrypt_part(master_key: bytes, plaintext: bytes) -> bytes:
    compressed = brotli.compress(plaintext, quality=6)
    salt = os.urandom(SALT_LEN)
    key, iv = _derive_part(master_key, salt)
    return salt + aead_encrypt(key, iv, compressed, salt)


def decrypt_part(master_key: bytes, blob: bytes) -> bytes:
    salt, ct_tag = blob[:SALT_LEN], blob[SALT_LEN:]
    key, iv = _derive_part(master_key, salt)
    return brotli.decompress(aead_decrypt(key, iv, ct_tag, salt))


def encrypt_name(master_key: bytes, name: str) -> tuple[bytes, bytes]:
    name_b = name.encode()
    salt = os.urandom(SALT_LEN)
    key, iv, hmac_key = _derive_name(master_key, salt)
    blob = salt + aead_encrypt(key, iv, name_b, salt)
    return blob, hmac_sha3_256(hmac_key, name_b)


def decrypt_name(master_key: bytes, blob: bytes) -> str:
    salt, ct_tag = blob[:SALT_LEN], blob[SALT_LEN:]
    key, iv, _ = _derive_name(master_key, salt)
    return aead_decrypt(key, iv, ct_tag, salt).decode()


# ===== Content splitting =====


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


# ===== Credentials =====


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
    if len(key) != 128:
        raise ValueError(f"master_key must be 128 bytes, got {len(key)}")
    return key


# ===== Database =====

_SCHEMA = """
CREATE TABLE IF NOT EXISTS txt (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      BLOB NOT NULL,
    name_hmac BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_parts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id  INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id ON txt_parts(txt_id);
CREATE TABLE IF NOT EXISTS part_count (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL
);
"""


def get_connection(creds: dict):
    conn = libsql.connect(
        ":memory:",
        sync_url=creds["turso_database_url"],
        auth_token=creds["turso_auth_token"],
    )
    conn.sync()
    return conn


def setup_schema(conn):
    conn.executescript(_SCHEMA)
    conn.sync()


# ===== Ingest =====


def _find_txt_id(conn, master_key: bytes, name: str) -> int | None:
    name_b = name.encode()
    for row_id, name_blob, stored_mac in conn.execute(
        "SELECT id, name, name_hmac FROM txt"
    ).fetchall():
        salt = bytes(name_blob)[:SALT_LEN]
        _, _, hmac_key = _derive_name(master_key, salt)
        if _hmac.compare_digest(hmac_sha3_256(hmac_key, name_b), bytes(stored_mac)):
            return row_id
    return None


def _insert_parts(
    conn, txt_id: int, master_key: bytes, parts: list[bytes], verbose: bool
):
    for i, part in enumerate(parts):
        blob = encrypt_part(master_key, part)
        conn.execute(
            "INSERT INTO txt_parts (txt_id, content) VALUES (?, ?)", (txt_id, blob)
        )
        if verbose:
            click.echo(
                f"  part {i + 1}/{len(parts)}: {len(part):,} → {len(blob):,} bytes"
            )


def ingest_file(
    conn, master_key: bytes, filepath: Path, stored_name: str, verbose: bool
):
    content = filepath.read_bytes()
    parts = split_parts(content)
    txt_id = _find_txt_id(conn, master_key, stored_name)
    if txt_id is None:
        name_blob, name_hmac_val = encrypt_name(master_key, stored_name)
        cur = conn.execute(
            "INSERT INTO txt (name, name_hmac) VALUES (?, ?)",
            (name_blob, name_hmac_val),
        )
        txt_id = cur.lastrowid
    else:
        conn.execute("DELETE FROM txt_parts WHERE txt_id = ?", (txt_id,))
    _insert_parts(conn, txt_id, master_key, parts, verbose)
    conn.execute(
        "INSERT OR REPLACE INTO part_count (txt_id, count) VALUES (?, ?)",
        (txt_id, len(parts)),
    )
    conn.commit()
    conn.sync()
    if verbose:
        click.echo(f"  {stored_name}: {len(parts)} part(s), txt_id={txt_id}")


# ===== Part count rebuild =====


def rebuild_part_count(conn):
    conn.execute("DELETE FROM part_count")
    conn.execute("""
        INSERT INTO part_count (txt_id, count)
        SELECT txt_id, COUNT(*) FROM txt_parts GROUP BY txt_id
    """)
    conn.commit()
    conn.sync()


# ===== Read part =====


def read_part(conn, master_key: bytes, part_id: int, out_path: str):
    cur = conn.execute("SELECT content FROM txt_parts WHERE id = ?", (part_id,))
    row = cur.fetchone()
    if not row:
        raise ValueError(f"No part with id={part_id}")
    plaintext = decrypt_part(master_key, bytes(row[0]))
    Path(out_path).write_bytes(plaintext)


# ===== CLI helpers =====


def _cmd_gen_master_key(path: str):
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        data = {}
    if "master_key" in data:
        click.confirm("master_key already exists. Overwrite?", abort=True)
    data["master_key"] = base64.b64encode(os.urandom(128)).decode()
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    click.echo(f"master_key written to {path}")


def _cmd_ingest(conn, master_key: bytes, src: str, verbose: bool):
    src_path = Path(src)
    files = sorted(p for p in src_path.rglob("*") if p.suffix.lower() == ".txt")
    for fp in files:
        stored_name = str(fp.relative_to(src_path))
        if verbose:
            click.echo(f"Ingesting {stored_name}")
        try:
            ingest_file(conn, master_key, fp, stored_name, verbose)
        except Exception as e:
            click.echo(f"Warning: skipping {fp}: {e}", err=True)


def _cmd_read_part(conn, mk: bytes, part_id: int, out: str):
    if not out:
        raise click.UsageError("--out is required with --read-part")
    read_part(conn, mk, part_id, out)


# ===== CLI =====


@click.command()
@click.option("--src", type=click.Path(exists=True))
@click.option("--creds", default="creds.json", show_default=True)
@click.option("--part-count", "do_part_count", is_flag=True)
@click.option("--gen-master-key", "gen_key_path", metavar="PATH")
@click.option("--read-part", "read_part_id", type=int)
@click.option("--out")
@click.option("--verbose", "-v", is_flag=True)
def main(src, creds, do_part_count, gen_key_path, read_part_id, out, verbose):
    if gen_key_path:
        _cmd_gen_master_key(gen_key_path)
        return
    loaded = load_creds(creds)
    conn = get_connection(loaded)
    setup_schema(conn)
    if do_part_count:
        rebuild_part_count(conn)
        return
    mk = get_master_key(loaded)
    if read_part_id is not None:
        _cmd_read_part(conn, mk, read_part_id, out)
    elif src:
        _cmd_ingest(conn, mk, src, verbose)


if __name__ == "__main__":
    main()
