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
    click.echo(f"master_key written to {path}")


def _derive(master_key: bytes, salt: bytes) -> tuple[bytes, bytes]:
    km = HKDF(
        algorithm=hashes.SHA3_256(),
        length=HKDF_LEN,
        salt=salt,
        info=b"",
    ).derive(master_key)
    return km[:32], km[32:]   # key, nonce

# ── encryption ───────────────────────────────────────────────────────────────

def encrypt_name(name: str, master_key: bytes) -> bytes:
    name_bytes = name.encode()
    km = HKDF(
        algorithm=hashes.SHA3_256(),
        length=HKDF_LEN,
        salt=name_bytes,
        info=b"",
    ).derive(master_key)
    key, nonce = km[:32], km[32:]
    return nacl.bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        message=name_bytes, aad=b"", nonce=nonce, key=key
    )


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

def open_db(creds_path: str | None = None) -> libsql.Connection:
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
    return libsql.connect(database=url, auth_token=token)


def ensure_schema(conn: libsql.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS txt (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name BLOB NOT NULL UNIQUE
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
    conn.commit()


def ingest_file(conn: libsql.Connection, path: Path, master_key: bytes) -> None:
    text  = path.read_text(encoding="utf-8", errors="replace")
    parts = split_paragraphs(text)

    name_blob = encrypt_name(path.name, master_key)
    conn.execute("INSERT OR IGNORE INTO txt (name) VALUES (?)", [name_blob])
    row    = conn.execute("SELECT id FROM txt WHERE name = ?", [name_blob]).fetchone()
    txt_id = row[0]

    conn.execute("DELETE FROM txt_parts WHERE txt_id = ?", [txt_id])

    for part_bytes in parts:
        blob = encrypt_part(part_bytes, master_key)
        conn.execute(
            "INSERT INTO txt_parts (txt_id, content) VALUES (?, ?)",
            [txt_id, blob],
        )

    conn.commit()
    click.echo(f"  {path.name}: {len(parts)} part(s)")

# ── CLI ──────────────────────────────────────────────────────────────────────

@click.command()
@click.option("--src",            type=click.Path(exists=True, file_okay=False), default=None)
@click.option("--master-key",     "master_key_path", type=click.Path(), default="creds.json", show_default=True)
@click.option("--gen-master-key", "gen_key_path",    type=click.Path(), default=None)
def main(src: str, master_key_path: str, gen_key_path: str) -> None:
    """Split, compress, encrypt, and store .txt files in Turso libSQL."""
    if gen_key_path:
        gen_master_key(gen_key_path)
        return

    if not src:
        raise click.UsageError("--src is required")

    master_key = load_master_key(master_key_path)
    conn       = open_db(master_key_path)
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
