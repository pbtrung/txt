#!/usr/bin/env python3
"""txt_vault.py – split, compress, encrypt, and store .txt files in Turso libSQL."""

import base64
import json
import os
import re
import sys
from pathlib import Path

import brotli
import click
import nacl.bindings
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

import libsql_experimental as libsql

# ── constants ────────────────────────────────────────────────────────────────

PART_TARGET  = 100 * 1024          # 100 KB
HKDF_INFO    = b"txt_vault v1"
HKDF_LEN     = 56                  # 32-byte key + 24-byte nonce
PARA_SPLIT   = re.compile(r"\r?\n\r?\n")

# ── key helpers ──────────────────────────────────────────────────────────────

def load_master_key(path: str) -> bytes:
    with open(path) as f:
        data = json.load(f)
    return base64.b64decode(data["key"])


def gen_master_key(path: str) -> None:
    if Path(path).exists():
        raise click.ClickException(f"{path} already exists; remove it first")
    raw = os.urandom(32)
    payload = {"version": 1, "key": base64.b64encode(raw).decode()}
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    click.echo(f"Master key written to {path}")


def _derive(master_key: bytes, salt: bytes) -> tuple[bytes, bytes]:
    km = HKDF(
        algorithm=hashes.SHA3_256(),
        length=HKDF_LEN,
        salt=salt,
        info=HKDF_INFO,
    ).derive(master_key)
    return km[:32], km[32:]   # key, nonce

# ── encryption ───────────────────────────────────────────────────────────────

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

def open_db() -> libsql.Connection:
    url   = os.environ.get("TURSO_DATABASE_URL")
    token = os.environ.get("TURSO_AUTH_TOKEN", "")
    if not url:
        raise click.ClickException("TURSO_DATABASE_URL environment variable not set")
    return libsql.connect(database=url, auth_token=token)


def ensure_schema(conn: libsql.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS txt (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS txt_parts (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
            part_index INTEGER NOT NULL,
            content    BLOB NOT NULL
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id ON txt_parts(txt_id)"
    )
    conn.commit()


def ingest_file(conn: libsql.Connection, path: Path, master_key: bytes) -> None:
    text  = path.read_text(encoding="utf-8", errors="replace")
    parts = split_paragraphs(text)

    conn.execute("INSERT OR IGNORE INTO txt (name) VALUES (?)", [path.name])
    row    = conn.execute("SELECT id FROM txt WHERE name = ?", [path.name]).fetchone()
    txt_id = row[0]

    conn.execute("DELETE FROM txt_parts WHERE txt_id = ?", [txt_id])

    for idx, part_bytes in enumerate(parts):
        blob = encrypt_part(part_bytes, master_key)
        conn.execute(
            "INSERT INTO txt_parts (txt_id, part_index, content) VALUES (?, ?, ?)",
            [txt_id, idx, blob],
        )

    conn.commit()
    click.echo(f"  {path.name}: {len(parts)} part(s)")

# ── CLI ──────────────────────────────────────────────────────────────────────

@click.command()
@click.option("--src",            type=click.Path(exists=True, file_okay=False), default=None)
@click.option("--master-key",     "master_key_path", type=click.Path(), default="master_key.json", show_default=True)
@click.option("--gen-master-key", "gen_key_path",    type=click.Path(), default=None)
def main(src: str, master_key_path: str, gen_key_path: str) -> None:
    """Split, compress, encrypt, and store .txt files in Turso libSQL."""
    if gen_key_path:
        gen_master_key(gen_key_path)
        return

    if not src:
        raise click.UsageError("--src is required")

    master_key = load_master_key(master_key_path)
    conn       = open_db()
    ensure_schema(conn)

    txt_files = sorted(Path(src).glob("*.txt"))
    if not txt_files:
        click.echo("No .txt files found.")
        return

    click.echo(f"Ingesting {len(txt_files)} file(s)...")
    errors = 0
    for path in txt_files:
        try:
            ingest_file(conn, path, master_key)
        except Exception as exc:
            click.echo(f"  WARNING: skipping {path.name}: {exc}", err=True)
            errors += 1

    status = f"Done. ({errors} error(s))" if errors else "Done."
    click.echo(status)
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
