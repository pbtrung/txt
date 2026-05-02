# Design: txt_vault.py

A single-file CLI tool that ingests `.txt` files, splits them into compressed and encrypted parts, and stores them in a Turso cloud libSQL database.

---

## CLI Interface

```
python3 txt_vault.py --src <folder_path> --master-key creds.json
python3 txt_vault.py --gen-master-key creds.json
```

### Flags

| Flag | Description |
|------|-------------|
| `--src <folder_path>` | Directory to scan for `*.txt` files |
| `--master-key creds.json` | Path to credentials JSON file (default: `creds.json`) |
| `--gen-master-key creds.json` | Add/update `master_key` in the credentials file, then exit |

### Credentials JSON Format

```json
{
  "turso_database_url": "libsql://your-db.turso.io",
  "turso_auth_token": "your-token-here",
  "master_key": "<base64-encoded 32-byte random key>"
}
```

`--gen-master-key` generates 32 cryptographically random bytes, base64-encodes them, and writes only the `master_key` field. If `master_key` already exists in the file, the user is prompted to confirm before overwriting. All other fields are left untouched. The file must be kept secret — `master_key` is the root of all encryption.

---

## Processing Pipeline

```
for each *.txt in --src:
  1. Read file content (UTF-8)
  2. Split into parts at paragraph boundaries, targeting ~100 KB per part
  3. For each part:
     a. Compress with Brotli (quality 6)
     b. Derive per-part key and nonce via HKDF (see Encryption)
     c. Encrypt compressed bytes with XChaCha20-Poly1305
     d. Serialize as: [32-byte salt] || [ciphertext+MAC]
     e. Store as a BLOB in txt_parts.content
  4. Insert a row into txt for the file; insert one row per part into txt_parts
```

### Paragraph Splitting

Parts are split on blank-line boundaries (`\n\n` or `\r\n\r\n`). The splitter accumulates paragraphs until adding the next paragraph would push the UTF-8 byte count past 100 KB (102 400 bytes), then starts a new part. A single paragraph larger than 100 KB becomes its own part unchanged.

---

## Database Schema (Turso / libSQL)

```sql
CREATE TABLE IF NOT EXISTS txt (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      BLOB NOT NULL,         -- 32-byte salt || XChaCha20-Poly1305(filename)
    name_hmac BLOB NOT NULL UNIQUE   -- HMAC-SHA3-256(filename) under a key derived from master_key via HKDF
);

CREATE TABLE IF NOT EXISTS txt_parts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id  INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    content BLOB    NOT NULL     -- 32-byte salt || encrypted(brotli(plaintext))
);

CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id ON txt_parts(txt_id);
```

Connection is made over HTTPS to a Turso database URL. The URL and auth token are read first from environment variables (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`); if not set, they fall back to the `turso_database_url` and `turso_auth_token` fields in `creds.json`.

---

## Encryption Design

### Key Material

The master key is a 64-byte random secret stored base64-encoded in the JSON key file.

### Per-Part Key Derivation

Each part gets its own 32-byte random **salt** (generated fresh at write time with `os.urandom(32)`).

HKDF-SHA3-256 is applied once to produce 56 bytes of key material:

```
key_material = HKDF(
    algorithm  = SHA3-256,
    length     = 56,           # 32-byte key + 24-byte nonce
    salt       = random_salt,  # 32 bytes, stored alongside ciphertext
    ikm        = master_key,   # 64 bytes from the JSON key file
    info       = b""
)

key   = key_material[:32]   # XChaCha20-Poly1305 key
nonce = key_material[32:]   # 24-byte nonce
```

HKDF is provided by the `cryptography` package (`cryptography.hazmat.primitives.kdf.hkdf` with `hashes.SHA3_256()`). PyNaCl's low-level bindings (`nacl.bindings.crypto_aead_xchacha20poly1305_ietf_encrypt`) perform the authenticated encryption.

### Encrypt

```
plaintext      = utf-8 bytes of one part
compressed     = brotli.compress(plaintext, quality=6)
ciphertext_mac = nacl.bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
                     message=compressed,
                     aad=None,
                     nonce=nonce,      # 24 bytes
                     key=key           # 32 bytes
                 )
blob           = random_salt + ciphertext_mac   # stored in txt_parts.content
```

The Poly1305 authentication tag (16 bytes) is appended by libsodium and included in `ciphertext_mac`.

### Decrypt (read path, for reference)

```
random_salt    = blob[:32]
ciphertext_mac = blob[32:]
key_material   = HKDF(...)            # same derivation as above
key, nonce     = key_material[:32], key_material[32:]
compressed     = nacl.bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
                     ciphertext=ciphertext_mac, aad=None, nonce=nonce, key=key
                 )
plaintext      = brotli.decompress(compressed)
```

### Security Properties

| Property | Mechanism |
|----------|-----------|
| Confidentiality | XChaCha20-Poly1305 (256-bit key, 192-bit nonce) |
| Integrity / authenticity | Poly1305 MAC (16-byte tag) |
| Key isolation per part | HKDF with unique random salt per part |
| Compression oracle mitigation | Compress before encrypt; no adaptive queries |
| Forward secrecy of parts | Rotating master key invalidates all derived keys |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `pynacl` | XChaCha20-Poly1305 via `nacl.bindings` |
| `cryptography` | HKDF-SHA3-256 |
| `brotli` | Compression |
| `libsql-experimental` | Turso / libSQL sync client |
| `click` | CLI argument parsing |

---

## Error Handling

- If `--src` contains a file that cannot be read (permissions, encoding), log a warning and skip it; do not abort the run.
- If a database write fails, the entire transaction for that file is rolled back. Partial ingestion of a single file is not allowed.
- If `--gen-master-key` target file already contains a `master_key` field, prompt the user to confirm before overwriting it; abort on refusal. Other fields are never modified.
