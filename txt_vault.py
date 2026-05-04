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
PART_TARGET = 200 * 1024

# ===== leancrypto loading =====


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

# ===== Schema =====

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
    if len(key) != 128:
        raise ValueError(f"master_key must be 128 bytes, got {len(key)}")
    return key


# ===== Crypto =====


class Crypto:
    """All cryptographic operations: primitives, key derivation, encrypt/decrypt."""

    def __init__(self, master_key: bytes):
        self._mk = master_key

    # --- primitives ---

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

    # --- key derivation ---

    def _derive_part(self, salt: bytes) -> tuple[bytes, bytes]:
        okm = self._hkdf(self._mk, salt, KEY_LEN + IV_LEN)
        return okm[:KEY_LEN], okm[KEY_LEN:]

    def _derive_name(self, salt: bytes) -> tuple[bytes, bytes, bytes]:
        okm = self._hkdf(self._mk, salt, KEY_LEN + IV_LEN + HMAC_LEN)
        return okm[:KEY_LEN], okm[KEY_LEN : KEY_LEN + IV_LEN], okm[KEY_LEN + IV_LEN :]

    # --- public interface ---

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

    def __init__(self, creds: dict):
        self._conn = libsql.connect(
            ":memory:",
            sync_url=creds["turso_database_url"],
            auth_token=creds["turso_auth_token"],
        )
        self._conn.sync()
        self._conn.executescript(_SCHEMA)
        self._conn.sync()

    def _insert_parts(
        self, crypto: Crypto, txt_id: int, parts: list[bytes], verbose: bool
    ):
        for i, part in enumerate(parts):
            blob = crypto.encrypt_part(part)
            self._conn.execute(
                "INSERT INTO txt_parts (txt_id, content) VALUES (?, ?)", (txt_id, blob)
            )
            if verbose:
                click.echo(
                    f"  part {i + 1}/{len(parts)}: {len(part):,} → {len(blob):,} bytes"
                )

    def ingest_file(
        self, crypto: Crypto, filepath: Path, stored_name: str, verbose: bool
    ):
        content = filepath.read_bytes()
        parts = split_parts(content)
        txt_id = crypto.find_txt_id(self._conn, stored_name)
        if txt_id is None:
            name_blob, name_mac = crypto.encrypt_name(stored_name)
            cur = self._conn.execute(
                "INSERT INTO txt (name, name_hmac) VALUES (?, ?)", (name_blob, name_mac)
            )
            txt_id = cur.lastrowid
        else:
            self._conn.execute("DELETE FROM txt_parts WHERE txt_id = ?", (txt_id,))
        self._insert_parts(crypto, txt_id, parts, verbose)
        self._conn.execute(
            "INSERT OR REPLACE INTO part_count (txt_id, count) VALUES (?, ?)",
            (txt_id, len(parts)),
        )
        self._conn.commit()
        self._conn.sync()
        if verbose:
            click.echo(f"  {stored_name}: {len(parts)} part(s), txt_id={txt_id}")

    def rebuild_part_count(self):
        self._conn.execute("DELETE FROM part_count")
        self._conn.execute("""
            INSERT INTO part_count (txt_id, count)
            SELECT txt_id, COUNT(*) FROM txt_parts GROUP BY txt_id
        """)
        self._conn.commit()
        self._conn.sync()

    def read_part(self, crypto: Crypto, part_id: int, out_path: str):
        cur = self._conn.execute(
            "SELECT content FROM txt_parts WHERE id = ?", (part_id,)
        )
        row = cur.fetchone()
        if not row:
            raise ValueError(f"No part with id={part_id}")
        Path(out_path).write_bytes(crypto.decrypt_part(bytes(row[0])))


# ===== CLI =====


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


def _cmd_ingest(store: VaultStore, crypto: Crypto, src: str, verbose: bool):
    src_path = Path(src)
    files = sorted(p for p in src_path.rglob("*") if p.suffix.lower() == ".txt")
    for fp in files:
        stored_name = str(fp.relative_to(src_path))
        if verbose:
            click.echo(f"Ingesting {stored_name}")
        try:
            store.ingest_file(crypto, fp, stored_name, verbose)
        except Exception as e:
            click.echo(f"Warning: skipping {fp}: {e}", err=True)


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
    store = VaultStore(loaded)
    if do_part_count:
        store.rebuild_part_count()
        return
    crypto = Crypto(get_master_key(loaded))
    if read_part_id is not None:
        if not out:
            raise click.UsageError("--out is required with --read-part")
        store.read_part(crypto, read_part_id, out)
    elif src:
        _cmd_ingest(store, crypto, src, verbose)


if __name__ == "__main__":
    main()
