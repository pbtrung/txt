#!/usr/bin/env python3
"""txt_vault.py – split, compress, encrypt, and store .txt files in Turso libSQL."""

import base64
import hmac as _hmac
import json
import logging
import os
import re
import sys
from pathlib import Path

import brotli
import click
import nacl.bindings
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.hmac import HMAC as CHMAC
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

import libsql

log = logging.getLogger("txt_vault")

# ── constants ────────────────────────────────────────────────────────────────

PART_TARGET  = 100 * 1024          # 100 KB
HKDF_LEN     = 56                  # 32-byte key + 24-byte nonce
PARA_SPLIT   = re.compile(r"\r?\n\r?\n")

# ── key helpers ──────────────────────────────────────────────────────────────

def load_master_key(path: str) -> bytes:
    with open(path) as f:
        data = json.load(f)
    return base64.b64decode(data["master_key"])


def gen_master_key(path: str) -> None:
    p = Path(path)
    data: dict = {}
    if p.exists():
        with open(path) as f:
            data = json.load(f)
        if "master_key" in data:
            if not click.confirm(f"master_key already exists in {path}. Overwrite?"):
                raise click.Abort()
    data["master_key"] = base64.b64encode(os.urandom(64)).decode()
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    log.info("master_key written to %s", path)


def _derive(master_key: bytes, salt: bytes) -> tuple[bytes, bytes]:
    km = HKDF(
        algorithm=hashes.SHA3_256(),
        length=HKDF_LEN,
        salt=salt,
        info=b"",
    ).derive(master_key)
    return km[:32], km[32:]   # key, nonce

# ── encryption ───────────────────────────────────────────────────────────────

def _derive_name(master_key: bytes, salt: bytes) -> tuple[bytes, bytes, bytes]:
    km = HKDF(
        algorithm=hashes.SHA3_256(),
        length=88,   # 32 key + 24 nonce + 32 hmac_key
        salt=salt,
        info=b"",
    ).derive(master_key)
    return km[:32], km[32:56], km[56:]  # key, nonce, hmac_key


def name_hmac(name: str, master_key: bytes, salt: bytes) -> bytes:
    _, _, hmac_key = _derive_name(master_key, salt)
    h = CHMAC(hmac_key, hashes.SHA3_256())
    h.update(name.encode())
    return h.finalize()


def find_txt_id(conn, name: str, master_key: bytes) -> int | None:
    rows = conn.execute("SELECT id, name, name_hmac FROM txt").fetchall()
    for row_id, enc_name, stored_hmac in rows:
        salt = bytes(enc_name)[:32]
        candidate = name_hmac(name, master_key, salt)
        if _hmac.compare_digest(candidate, bytes(stored_hmac)):
            return row_id
    return None


def encrypt_name(name: str, master_key: bytes) -> tuple[bytes, bytes]:
    salt = os.urandom(32)
    key, nonce, _ = _derive_name(master_key, salt)
    ct = nacl.bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        message=name.encode(), aad=b"", nonce=nonce, key=key
    )
    return salt + ct, salt


def decrypt_name(blob: bytes, master_key: bytes) -> str:
    salt, ct = blob[:32], blob[32:]
    key, nonce, _ = _derive_name(master_key, salt)
    return nacl.bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
        ciphertext=ct, aad=b"", nonce=nonce, key=key
    ).decode()


def encrypt_part(plaintext: bytes, master_key: bytes) -> bytes:
    salt = os.urandom(32)
    key, nonce = _derive(master_key, salt)
    compressed = brotli.compress(plaintext, quality=6)
    ct = nacl.bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        message=compressed, aad=b"", nonce=nonce, key=key
    )
    return salt + ct  # 32-byte salt || ciphertext+MAC


def decrypt_part(blob: bytes, master_key: bytes) -> bytes:
    salt, ct = blob[:32], blob[32:]
    key, nonce = _derive(master_key, salt)
    compressed = nacl.bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
        ciphertext=ct, aad=b"", nonce=nonce, key=key
    )
    return brotli.decompress(compressed)

# ── splitting ────────────────────────────────────────────────────────────────

def split_paragraphs(text: str) -> list[bytes]:
    paragraphs = PARA_SPLIT.split(text)
    parts: list[bytes] = []
    buf: list[bytes] = []
    buf_size = 0

    for para in paragraphs:
        chunk = (para + "\n\n").encode("utf-8")
        if buf and buf_size + len(chunk) > PART_TARGET:
            parts.append(b"".join(buf))
            buf, buf_size = [], 0
        buf.append(chunk)
        buf_size += len(chunk)

    if buf:
        parts.append(b"".join(buf))

    return parts or [b""]

# ── database ─────────────────────────────────────────────────────────────────

def open_db(creds_path: str | None = None):
    url   = os.environ.get("TURSO_DATABASE_URL")
    token = os.environ.get("TURSO_AUTH_TOKEN", "")
    if not url and creds_path and Path(creds_path).exists():
        with open(creds_path) as f:
            data = json.load(f)
        url   = data.get("turso_database_url") or url
        token = data.get("turso_auth_token", token)
    if not url:
        raise click.ClickException(
            "TURSO_DATABASE_URL not set and not found in creds file"
        )
    log.debug("connecting to %s", url)
    return libsql.connect(database=url, auth_token=token)


def ensure_schema(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS txt (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            name      BLOB NOT NULL,
            name_hmac BLOB NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS txt_parts (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            txt_id  INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
            content BLOB NOT NULL
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id ON txt_parts(txt_id)"
    )
    conn.execute("""
        CREATE TABLE IF NOT EXISTS part_count (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
            count  INTEGER NOT NULL
        )
    """)
    conn.commit()


def upsert_part_count(conn, txt_id: int, count: int) -> None:
    conn.execute(
        "INSERT INTO part_count (txt_id, count) VALUES (?, ?)"
        " ON CONFLICT(txt_id) DO UPDATE SET count = excluded.count",
        [txt_id, count],
    )


def ingest_file(conn, path: Path, master_key: bytes) -> None:
    text  = path.read_text(encoding="utf-8", errors="replace")
    parts = split_paragraphs(text)

    txt_id = find_txt_id(conn, path.name, master_key)
    if txt_id is None:
        enc_name, salt = encrypt_name(path.name, master_key)
        hmac_val = name_hmac(path.name, master_key, salt)
        conn.execute("INSERT INTO txt (name, name_hmac) VALUES (?, ?)", [enc_name, hmac_val])
        txt_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    log.debug("%s: splitting into %d part(s)", path.name, len(parts))
    conn.execute("DELETE FROM txt_parts WHERE txt_id = ?", [txt_id])

    for i, part_bytes in enumerate(parts):
        log.debug("%s: encrypting part %d/%d (%d bytes)", path.name, i + 1, len(parts), len(part_bytes))
        blob = encrypt_part(part_bytes, master_key)
        conn.execute(
            "INSERT INTO txt_parts (txt_id, content) VALUES (?, ?)",
            [txt_id, blob],
        )

    upsert_part_count(conn, txt_id, len(parts))
    conn.commit()
    log.info("%s: %d part(s) committed", path.name, len(parts))

# ── CLI ──────────────────────────────────────────────────────────────────────

@click.command()
@click.option("--src",            type=click.Path(exists=True, file_okay=False), default=None)
@click.option("--creds",          "creds_path",      type=click.Path(), default="creds.json", show_default=True)
@click.option("--gen-master-key", "gen_key_path",    type=click.Path(), default=None)
@click.option("--read-part",      "read_part_id",    type=int,          default=None)
@click.option("--out",            "out_path",        type=click.Path(), default=None)
@click.option("--part-count",     "do_part_count",   is_flag=True,      default=False,
              help="Rebuild part_count table from existing txt_parts rows.")
@click.option("--verbose", "-v",  is_flag=True, default=False, help="Enable debug logging.")
def main(src: str, creds_path: str, gen_key_path: str,
         read_part_id: int, out_path: str, do_part_count: bool, verbose: bool) -> None:
    """Split, compress, encrypt, and store .txt files in Turso libSQL."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(message)s",
        datefmt="%H:%M:%S",
    )

    if gen_key_path:
        gen_master_key(gen_key_path)
        return

    if read_part_id is not None:
        if not out_path:
            raise click.UsageError("--out is required with --read-part")
        master_key = load_master_key(creds_path)
        conn = open_db(creds_path)
        row = conn.execute("SELECT content FROM txt_parts WHERE id = ?", [read_part_id]).fetchone()
        if row is None:
            raise click.ClickException(f"no part with id {read_part_id}")
        plaintext = decrypt_part(bytes(row[0]), master_key)
        Path(out_path).write_bytes(plaintext)
        log.info("part %d written to %s (%d bytes)", read_part_id, out_path, len(plaintext))
        return

    if do_part_count:
        conn = open_db(creds_path)
        ensure_schema(conn)
        rows = conn.execute(
            "SELECT txt_id, COUNT(*) FROM txt_parts GROUP BY txt_id"
        ).fetchall()
        for txt_id, count in rows:
            upsert_part_count(conn, txt_id, count)
        conn.commit()
        log.info("part_count updated for %d txt(s)", len(rows))
        return

    if not src:
        raise click.UsageError("--src or --part-count is required")

    log.info("loading master key from %s", creds_path)
    master_key = load_master_key(creds_path)
    conn       = open_db(creds_path)
    log.debug("ensuring schema")
    ensure_schema(conn)

    txt_files = sorted(p for p in Path(src).iterdir() if p.is_file() and p.suffix.lower() == ".txt")
    if not txt_files:
        log.info("no .txt files found in %s", src)
        return

    log.info("found %d file(s) in %s", len(txt_files), src)
    errors = 0
    for path in txt_files:
        log.info("ingesting %s", path.name)
        try:
            ingest_file(conn, path, master_key)
        except Exception as exc:
            log.warning("skipping %s: %s", path.name, exc)
            errors += 1

    if errors:
        log.warning("done with %d error(s)", errors)
        sys.exit(1)
    else:
        log.info("done")


if __name__ == "__main__":
    main()
