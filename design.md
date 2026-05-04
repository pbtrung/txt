# Design: txt_vault.py

A single-file CLI tool that ingests `.txt` files, splits them into compressed and encrypted parts, and stores them in a Turso cloud libSQL database.

---

## CLI Interface

```
python3 txt_vault.py --src <folder_path> --creds creds.json
python3 txt_vault.py --part-count --creds creds.json
python3 txt_vault.py --gen-master-key creds.json
```

### Flags

| Flag | Description |
|------|-------------|
| `--src <folder_path>` | Directory to scan for `.txt` files (case-insensitive) |
| `--creds <path>` | Credentials JSON file with Turso URL/token and master key (default: `creds.json`) |
| `--part-count` | Rebuild `part_count` table from existing `txt_parts` rows, then exit |
| `--gen-master-key <path>` | Add/update `master_key` in the credentials file, then exit |
| `--read-part <id>` | Decrypt a single part by `txt_parts.id` and write to `--out` |
| `--out <path>` | Output path for `--read-part` |
| `--verbose`, `-v` | Enable debug logging (per-part progress, DB URL, schema setup) |

### Credentials JSON Format

```json
{
  "turso_database_url": "libsql://your-db.turso.io",
  "turso_auth_token": "your-token-here",
  "master_key": "<base64-encoded 64-byte random key>"
}
```

`--gen-master-key` generates 64 cryptographically random bytes, base64-encodes them, and writes only the `master_key` field. If `master_key` already exists in the file, the user is prompted to confirm before overwriting. All other fields are left untouched. The file must be kept secret — `master_key` is the root of all encryption.

---

## Processing Pipeline

```
for each .txt file (case-insensitive) in --src:
  1. Read file content (UTF-8)
  2. Encrypt filename → (salt || ciphertext) stored in txt.name
     Compute HMAC-SHA3-256 of filename → stored in txt.name_hmac
     (see Filename Encryption below)
  3. INSERT OR IGNORE into txt; SELECT id WHERE name_hmac = ?
  4. DELETE existing txt_parts for this txt_id
  5. Split content into parts at paragraph boundaries, targeting ~100 KB per part
  6. For each part:
     a. Compress with Brotli (quality 6)
     b. Generate 64-byte random salt
     c. Derive 64-byte key and 64-byte IV via HKDF-SHA3-512(master_key, salt)
     d. Encrypt compressed bytes with Ascon-Keccak AEAD; pass salt as AAD
     e. Store salt || ciphertext+tag as a single BLOB in txt_parts.content
  7. Upsert total part count into part_count (txt_id, count)
  8. Commit transaction
```

### Paragraph Splitting

Parts are split on blank-line boundaries (`\n\n` or `\r\n\r\n`). The splitter accumulates paragraphs until adding the next paragraph would push the UTF-8 byte count past 100 KB (102 400 bytes), then starts a new part. A single paragraph larger than 100 KB becomes its own part unchanged.

---

## Database Schema (Turso / libSQL)

```sql
CREATE TABLE IF NOT EXISTS txt (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      BLOB NOT NULL,         -- 64-byte salt || Ascon-Keccak(filename); key/iv/hmac_key from HKDF(salt)
    name_hmac BLOB NOT NULL          -- HMAC-SHA3-256(filename) under hmac_key from same HKDF call
);

CREATE TABLE IF NOT EXISTS txt_parts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id  INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    content BLOB    NOT NULL     -- 64-byte salt || Ascon-Keccak(brotli(plaintext)); salt is AAD
);

CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id ON txt_parts(txt_id);

CREATE TABLE IF NOT EXISTS part_count (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL      -- total number of parts for this txt entry
);
```

`part_count` is kept in sync automatically: `ingest_file` upserts the count after committing each file's parts. The `--part-count` flag can backfill it for data ingested before this table existed.

Connection is made over HTTPS to a Turso database URL. The URL and auth token are read first from environment variables (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`); if not set, they fall back to the `turso_database_url` and `turso_auth_token` fields in `creds.json`.

---

## Encryption Design

All cryptographic operations use **leancrypto**, loaded as a system shared library via ctypes. No other crypto dependency is required.

### Key Material

The master key is a 128-byte random secret stored base64-encoded in the JSON credentials file.

### Primitives

| Primitive | leancrypto API | Parameters |
|-----------|---------------|------------|
| AEAD | Ascon-Keccak (`lc_ak_alloc_taglen`) | 64-byte key, 64-byte IV, 64-byte tag |
| KDF | HKDF-SHA3-512 (`lc_hkdf_*`) | produces 128 or 160 bytes of OKM |
| MAC | HMAC-SHA3-256 (`lc_hmac_*`) | 32-byte digest |

### Filename Encryption

A fresh 64-byte random salt is generated per ingestion:

```
salt         = os.urandom(64)
key_material = HKDF-SHA3-512(ikm=master_key, salt=salt, info=b"", length=160)

key      = key_material[:64]
iv       = key_material[64:128]
hmac_key = key_material[128:]        # 32 bytes

name_blob = salt || Ascon-Keccak-encrypt(filename_bytes, key, iv, aad=salt)
name_hmac = HMAC-SHA3-256(hmac_key, filename_bytes)
```

`name_blob` is stored in `txt.name`; `name_hmac` is stored in `txt.name_hmac` and used for row lookup. Because `hmac_key` is derived from the random salt, `name_hmac` is non-deterministic across separate ingest runs of the same file.

Decryption reads the 64-byte salt prefix from `txt.name`, re-derives the same 160-byte key material, and decrypts.

### Per-Part Key Derivation

Each part gets its own 64-byte random salt generated at write time:

```
key_material = HKDF-SHA3-512(ikm=master_key, salt=salt, info=b"", length=128)

key = key_material[:64]    # Ascon-Keccak key
iv  = key_material[64:]    # Ascon-Keccak IV
```

### Encrypt

```
plaintext  = UTF-8 bytes of one part
compressed = brotli.compress(plaintext, quality=6)
salt       = os.urandom(64)
key, iv    = derive(salt)
ct_tag     = Ascon-Keccak-encrypt(compressed, key, iv, aad=salt)
blob       = salt || ct_tag          # stored in txt_parts.content
```

The 64-byte Ascon-Keccak authentication tag is appended by leancrypto and included in `ct_tag`. Passing `salt` as AAD binds the salt to the ciphertext: any tampering with the stored salt causes tag verification to fail on decrypt.

### Decrypt

```
salt   = blob[:64]
ct_tag = blob[64:]
key, iv = derive(salt)
compressed = Ascon-Keccak-decrypt(ct_tag, key, iv, aad=salt)
plaintext  = brotli.decompress(compressed)
```

### Security Properties

| Property | Mechanism |
|----------|-----------|
| Confidentiality | Ascon-Keccak (512-bit key+IV, 512-bit tag) |
| Integrity / authenticity | 64-byte Ascon-Keccak tag |
| Salt integrity | Salt passed as AAD; tag covers it |
| Filename confidentiality | Filename encrypted with per-ingestion random salt |
| Filename lookup | HMAC-SHA3-256 under `hmac_key` co-derived with encryption key |
| Key isolation per part | HKDF with unique random salt per part |
| Compression oracle mitigation | Compress before encrypt; no adaptive queries |

---

## leancrypto ctypes Symbols

| Symbol | Kind | Used for |
|--------|------|----------|
| `lc_sha3_512` | `const struct lc_hash *` | HKDF context |
| `lc_sha3_256` | `const struct lc_hash *` | HMAC context |
| `lc_hkdf_alloc` | function | HKDF context allocation |
| `lc_hkdf_extract` | function | HKDF-Extract (PRK) |
| `lc_hkdf_expand` | function | HKDF-Expand (OKM) |
| `lc_hkdf_zero_free` | function | HKDF context teardown |
| `lc_hmac_alloc` | function | HMAC context allocation |
| `lc_hmac_update` | function | HMAC feed |
| `lc_hmac_final` | function | HMAC digest |
| `lc_hmac_zero_free` | function | HMAC context teardown |
| `lc_ak_alloc_taglen` | function | Ascon-Keccak AEAD allocation |
| `lc_aead_setkey` | function | Set key and IV |
| `lc_aead_encrypt` | function | Authenticated encryption |
| `lc_aead_decrypt` | function | Authenticated decryption |
| `lc_aead_zero_free` | function | AEAD context teardown |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `leancrypto` | AEAD, HKDF, HMAC (system shared library, loaded via ctypes) |
| `brotli` | Compression |
| `libsql` | Turso / libSQL client |
| `click` | CLI argument parsing |

---

## Error Handling

- If `--src` contains a file that cannot be read (permissions, encoding), log a warning and skip it; do not abort the run.
- If a database write fails, the entire transaction for that file is rolled back. Partial ingestion of a single file is not allowed.
- If `--gen-master-key` target file already contains a `master_key` field, prompt the user to confirm before overwriting it; abort on refusal. Other fields are never modified.
