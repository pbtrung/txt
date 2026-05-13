# Design: txt_vault

A CLI tool that ingests `.txt` files, splits them into compressed and encrypted parts, and stores them in a Turso cloud libSQL database. `txt_vault.py` is a 4-line entry point; all logic lives in the `txt_vault/` package.

---

## CLI Interface

```
python3 txt_vault.py --src <folder_path> --creds creds.json
python3 txt_vault.py --src <folder_path> --force --creds creds.json
python3 txt_vault.py --download --out <out_dir> --creds creds.json
python3 txt_vault.py --upload-db <file.db> --creds creds.json
python3 txt_vault.py --part-count --creds creds.json
python3 txt_vault.py --create-bookmarks --creds creds.json
python3 txt_vault.py --recreate-bookmarks --creds creds.json
python3 txt_vault.py --gen-master-key creds.json
```

### Flags

| Flag | Description |
|------|-------------|
| `--src <folder_path>` | Directory to scan for `.txt` files (case-insensitive); skips files already in the database unless `--force` is set |
| `--force` | With `--src`: overwrite existing entries instead of skipping them |
| `--download` | Decrypt and export all stored files to the `--out` directory |
| `--creds <path>` | Credentials JSON file with Turso URL/token and master key (default: `creds.json`) |
| `--upload-db <file>` | Upload all rows from a local SQLite db to Turso; Turso `txt` must be empty |
| `--part-count` | Rebuild `part_count` table from existing `txt_parts` rows, then exit |
| `--create-bookmarks` | Create bookmarks table, index, and trigger and exit; progress shown with `-v` |
| `--recreate-bookmarks` | Drop and recreate bookmarks table (all bookmarks lost) and exit; progress shown with `-v` |
| `--gen-master-key <path>` | Add/update `master_key` in the credentials file, then exit |
| `--read-part <id>` | Decrypt a single part by `txt_parts.id` and write to `--out` |
| `--out <path>` | Output path: file for `--read-part`, directory for `--download` |
| `--verbose`, `-v` | Enable debug logging (per-part progress, DB URL, schema setup, upload progress) |

### Credentials JSON Format

```json
{
  "turso_database_url": "libsql://your-db.turso.io",
  "turso_auth_token": "your-token-here",
  "master_key": "<base64-encoded 128-byte random key>"
}
```

`--gen-master-key` generates 128 cryptographically random bytes, base64-encodes them, and writes only the `master_key` field. If `master_key` already exists in the file, the user is prompted to confirm before overwriting. All other fields are left untouched. The file must be kept secret — `master_key` is the root of all encryption.

---

## Processing Pipeline

```
for each .txt file (case-insensitive) in --src:
  1. Read file bytes
  2. Scan all txt rows; for each row re-derive hmac_key from the stored salt
     and compare HMAC-SHA3-256(hmac_key, filename) against stored name_hmac
     (constant-time).
     - No match → encrypt filename and INSERT a new txt row.
     - Match + no --force → skip this file entirely.
     - Match + --force → reuse txt_id and DELETE existing parts.
  3. Preprocess: normalise paragraph spacing via preprocess_text()
     - Insert a blank line between any two consecutive non-blank lines.
     - Collapse multiple consecutive blank lines to one.
  4. Split preprocessed content into parts at paragraph boundaries,
     targeting ~200 KB per part
  5. For each part (1-based index i):
     a. Compress with Brotli (quality 11)
     b. Generate 64-byte random salt
     c. Derive 64-byte key and 64-byte IV via HKDF-SHA3-512(master_key, salt)
     d. Encrypt compressed bytes with Ascon-Keccak AEAD; pass salt as AAD
     e. Store (txt_id, part_num=i, salt || ciphertext+tag) in txt_parts
  6. Upsert total part count into part_count (txt_id, count)
  7. Commit to Turso
```

### Text Preprocessing

`preprocess_text()` (in `utils.py`) normalises paragraph spacing before splitting or reassembling:

- Any two consecutive non-blank lines get a blank line inserted between them.
- Multiple consecutive blank lines are collapsed to one.

This runs on every file at ingest time and on every part at download time, ensuring the on-disk representation is consistent regardless of the source file's original whitespace style.

### Paragraph Splitting

Parts are split on blank-line boundaries (`\n\n` or `\r\n\r\n`). The splitter accumulates paragraphs until adding the next paragraph would push the UTF-8 byte count past 200 KB (204 800 bytes), then starts a new part. A single paragraph larger than 200 KB becomes its own part unchanged.

### Download Pipeline

`Downloader.download_all()` is the inverse of ingest:

```
for each row in txt:
  1. Decrypt the stored name blob → filename string
  2. Fetch all txt_parts rows for this txt_id, ordered by part_num
  3. For each part blob:
     a. Decrypt with Ascon-Keccak AEAD → brotli-decompress → plaintext bytes
     b. Run preprocess_text() on the plaintext
     c. Strip trailing newlines
  4. Join parts with b"\n\n" (one blank line between parts)
  5. Write to out_dir/<filename>; create intermediate directories as needed
```

Files with no stored parts are skipped silently. Per-file errors are printed as warnings and do not abort the rest of the download.

---

## Database Schema (Turso / libSQL)

```sql
CREATE TABLE IF NOT EXISTS txt (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      BLOB NOT NULL,         -- 64-byte salt || Ascon-Keccak(filename); key/iv/hmac_key from HKDF(salt)
    name_hmac BLOB NOT NULL          -- HMAC-SHA3-256(filename) under hmac_key from same HKDF call
);

CREATE TABLE IF NOT EXISTS txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,       -- 1-based part index, set at ingest time
    content  BLOB    NOT NULL        -- 64-byte salt || Ascon-Keccak(brotli(plaintext)); salt is AAD
);

CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id_part_num ON txt_parts(txt_id, part_num);

CREATE TABLE IF NOT EXISTS part_count (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL          -- total number of parts for this txt entry
);

CREATE TABLE IF NOT EXISTS txt_access (
    txt_id        INTEGER PRIMARY KEY REFERENCES txt(id) ON DELETE CASCADE,
    last_part_num INTEGER NOT NULL DEFAULT 1,  -- last part the user read
    last_accessed INTEGER NOT NULL             -- Unix timestamp in milliseconds
);
```

`part_count` is kept in sync automatically: `ingest_file` upserts the count after committing each file's parts. The `--part-count` flag can backfill it for data ingested before this table existed.

`txt_access` has at most one row per file ever opened. `upsertAccess` writes a single `INSERT OR REPLACE` from the browser whenever a part is loaded. `fetchRecentAccess` reads at most 5 rows ordered by `last_accessed DESC` — no joins, no scans.

`fetchRecentBookmarks` reads at most 5 rows ordered by `id DESC` (most recently inserted first), across all files: `SELECT id, txt_id, bookmark FROM bookmarks ORDER BY id DESC LIMIT 5`. The browser decrypts each blob and resolves the `txt_id` against the already-fetched file list; entries whose file no longer exists are silently dropped.

```sql
CREATE TABLE IF NOT EXISTS bookmarks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    bookmark BLOB NOT NULL   -- brotli(JSON) encrypted with same scheme as txt_parts
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_txt_id ON bookmarks(txt_id);

CREATE TRIGGER IF NOT EXISTS trg_limit_bookmarks_per_file
BEFORE INSERT ON bookmarks
WHEN (SELECT COUNT(*) FROM bookmarks WHERE txt_id = NEW.txt_id) >= 12
BEGIN
    DELETE FROM bookmarks
    WHERE id = (
        SELECT id FROM bookmarks
        WHERE txt_id = NEW.txt_id
        ORDER BY id ASC LIMIT 1
    );
END;
```

The `bookmark` blob is an AEAD-encrypted, brotli-compressed JSON object:

```json
{"part_num": 3, "line": 42, "txt_preview": "First sixty characters of the line…"}
```

Key derivation and wire format are identical to `txt_parts.content` (64-byte random salt prefix, same HKDF call, same AEAD cipher). The database stores only the FK `txt_id` as plaintext — part number, line index, and preview are all inside the ciphertext.

The `--create-bookmarks` flag creates the table, index, and trigger (idempotent: `IF NOT EXISTS`). The `--recreate-bookmarks` flag drops the table first (cascading the index and trigger) then recreates it; all existing bookmarks are lost. Both flags print per-step progress when `-v` is set.

All queries execute directly against the Turso cloud database over HTTPS — there is no local replica. The URL and auth token are read first from environment variables (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`); if not set, they fall back to the `turso_database_url` and `turso_auth_token` fields in `creds.json`.

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
compressed = brotli.compress(plaintext, quality=11)
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

### Bookmark Encryption

Bookmarks use the same encrypt-then-MAC format as `txt_parts`:

```
plaintext  = JSON.stringify({part_num, line, txt_preview})
compressed = brotli(plaintext)
salt       = random(64 bytes)
key, iv    = HKDF-SHA3-512(master_key, salt, length=128)[:64], [64:]
ct_tag     = Ascon-Keccak-encrypt(compressed, key, iv, aad=salt)
blob       = salt || ct_tag          # stored in bookmarks.bookmark
```

Decryption is the symmetric reverse. The FK `txt_id` is the only plaintext metadata; part number, line index, and preview are never visible to the database.

### Security Properties

| Property | Mechanism |
|----------|-----------|
| Confidentiality | Ascon-Keccak (512-bit key+IV, 512-bit tag) |
| Integrity / authenticity | 64-byte Ascon-Keccak tag |
| Salt integrity | Salt passed as AAD; tag covers it |
| Filename confidentiality | Filename encrypted with per-ingestion random salt |
| Filename lookup | HMAC-SHA3-256 under `hmac_key` co-derived with encryption key |
| Key isolation per part | HKDF with unique random salt per part |
| Bookmark confidentiality | Bookmark JSON encrypted with per-bookmark random salt |
| Bookmark per-file cap | DB trigger evicts oldest bookmark (FIFO) when count ≥ 12 |
| Compression oracle mitigation | Compress before encrypt; no adaptive queries |

---

## Code Structure

`txt_vault.py` is a 4-line entry point. All logic lives in the `txt_vault/` package:

| Module | Contents |
|--------|----------|
| `constants.py` | All numeric constants (`SALT_LEN`, `TAG_LEN`, `KEY_LEN`, `IV_LEN`, `HMAC_LEN`, `MASTER_KEY_LEN`, `PART_TARGET`, `BOOKMARK_LIMIT`, `BATCH`) |
| `leancrypto.py` | ctypes binding helpers and module-level singletons (`library_name`, `lib`, `sha3_512`, `sha3_256`) |
| `schema.py` | `_SCHEMA` DDL string and `_BOOKMARKS_STMTS` list (trigger interpolates `BOOKMARK_LIMIT`) |
| `utils.py` | `preprocess_text`, `split_parts`, `load_creds`, `get_master_key` |
| `crypto.py` | `Crypto` class |
| `store.py` | `VaultStore` class, `Downloader` class |
| `cli.py` | Click command definitions, `_cmd_gen_master_key`, `_cmd_ingest`, `_dispatch_admin`, `main` |

### `Crypto`

Owns the master key and all cryptographic logic. Constructed once per run with the decoded master key.

| Method | Role |
|--------|------|
| `_hkdf` | One-shot HKDF-SHA3-512 via `lc_hkdf` |
| `_hmac` | One-shot HMAC-SHA3-256 via `lc_hmac` |
| `_aead_alloc` | Allocate Ascon-Keccak context |
| `_aead_encrypt` / `_aead_decrypt` | Authenticated encryption / decryption |
| `_derive_part` | Derive (key, IV) for a part from its salt |
| `_derive_name` | Derive (key, IV, hmac\_key) for a filename from its salt |
| `encrypt_part` / `decrypt_part` | Compress + encrypt / decrypt + decompress a part blob |
| `encrypt_name` | Encrypt a filename blob with a fresh random salt; returns `(blob, hmac)` |
| `decrypt_name` | Recover the plaintext filename from a stored name blob |
| `find_txt_id` | Scan `txt` rows to find an existing entry by filename via HMAC comparison |

### `VaultStore`

Owns the libSQL connection. Constructed once per run; establishes the direct Turso connection and applies the schema in `__init__`.

| Method | Role |
|--------|------|
| `_apply_schema` | Execute `_SCHEMA` DDL statements on the connection |
| `_resolve_txt_id` | Look up an existing entry by filename; INSERT new row or DELETE old parts on force |
| `_insert_parts` | Encrypt and insert all parts for a `txt_id`, with 1-based `part_num` |
| `ingest_file` | Full ingest pipeline for one file; skips if name exists and `force=False`, overwrites if `force=True` |
| `create_bookmarks` | Create bookmarks table, index, and trigger; progress with `-v` |
| `recreate_bookmarks` | Drop bookmarks table then call `create_bookmarks`; all bookmarks lost |
| `rebuild_part_count` | Backfill `part_count` from `txt_parts` |
| `_table_names` | Return set of non-sqlite table names from a connection |
| `_ensure_upload_schema` | Compare local and Turso tables; create bookmarks on Turso if needed |
| `_check_turso_empty` | Abort if Turso `txt` already has rows |
| `_upload_rows` / `_upload_table` | Upload one table in `BATCH`-row commits |
| `upload_db` | Orchestrate full local-SQLite-to-Turso upload |
| `read_part` | Fetch and decrypt a single part by id |

### `Downloader`

Opens its own Turso connection (read-only use; no schema application). Constructed once per `--download` run.

| Method | Role |
|--------|------|
| `_all_txts` | Fetch all `(id, name)` rows from the `txt` table |
| `_fetch_part_blobs` | Fetch all encrypted part blobs for a `txt_id`, ordered by `part_num` |
| `_assemble` | Decrypt + preprocess each part, strip trailing newlines, join with `b"\n\n"` |
| `_write_file` | Create parent directories and write assembled bytes to destination |
| `download_all` | Iterate all txt rows; decrypt filename, assemble parts, write file; skip empties, warn on errors |

---

## leancrypto ctypes Symbols

| Symbol | Kind | Used for |
|--------|------|----------|
| `lc_sha3_512` | `const struct lc_hash *` | HKDF and AEAD contexts |
| `lc_sha3_256` | `const struct lc_hash *` | HMAC context |
| `lc_hkdf` | one-shot function | HKDF-SHA3-512 key derivation |
| `lc_hmac` | one-shot function | HMAC-SHA3-256 digest |
| `lc_ak_alloc_taglen` | function | Ascon-Keccak AEAD allocation |
| `lc_aead_setkey` | function | Set key and IV |
| `lc_aead_encrypt` | function | Authenticated encryption |
| `lc_aead_decrypt` | function | Authenticated decryption |
| `lc_aead_zero_free` | function | AEAD context teardown |

---

## Browser UI

A React + Bootstrap SPA in `ui/`. All decryption runs client-side in the browser using leancrypto compiled to WebAssembly (`leancrypto.wasm`). The Turso database is accessed directly over the libSQL HTTP pipeline API — no backend server is involved.

### Component Structure

| Component | File | Responsibility |
|-----------|------|----------------|
| `App` | `App.jsx` | Toggles between `LoginScreen` and `DataScreen` based on credential state |
| `LoginScreen` | `LoginScreen.jsx` | Collects Turso URL, auth token, and master key; calls `initDb` then passes credentials up |
| `DataScreen` | `DataScreen.jsx` | Owns all reader state and business logic; renders layout skeleton and delegates views to sub-components |
| `TopBar` | `TopBar.jsx` | Title, bookmark toggle (flag icon), home button (house icon), disconnect button (power icon); bookmark and home buttons are disabled when no file is open |
| `LandingView` | `LandingView.jsx` | No-file-selected state: "Recently opened" list (up to 5) and "Recent bookmarks" list (up to 5 cross-file) |
| `BookmarkChooser` | `BookmarkChooser.jsx` | "Pick up where you left off" list shown after opening a file that has existing bookmarks |
| `ReaderView` | `ReaderView.jsx` | Line-by-line reader; each line has a clickable bar on the left to toggle a bookmark |
| `BookmarkPanel` | `BookmarkPanel.jsx` | Dropdown panel listing all bookmarks for the current file with jump and delete actions |
| `FileDropdown` | `FileDropdown.jsx` | Searchable file selector in the card header |
| `PartFooter` | `PartFooter.jsx` | Part navigation controls and font-size adjuster |

### Data Flow on Mount

On mount `DataScreen` issues a single `Promise.all` with three queries: `fetchTxts`, `fetchRecentAccess`, and `fetchRecentBookmarks`. The results are merged in the browser: file names are decrypted against `masterKey`, recent-access rows are filtered to files that still exist, and bookmark blobs are decrypted and joined to file names. All three lists are ready before the first render.

### State Transitions

```
Login → LandingView (no file selected)
  ↓ click recently opened entry        ↓ click recent bookmark entry   ↓ dropdown
  jumpTo={partNum, lineIndex:null}      jumpTo={partNum, lineIndex}      no jumpTo
  (skips BookmarkChooser)               (skips BookmarkChooser)
        └──────────────────────────────────────┬───────────────────────────┘
                                               ↓
                               DataScreen loads parts + file bookmarks
                                 ├─ jumpTo supplied → ReaderView (scroll if lineIndex ≠ null)
                                 ├─ file has bookmarks → BookmarkChooser
                                 │       ↓ click entry or use part controls
                                 └─ no bookmarks → ReaderView
                                         ↓ Home button
                                       LandingView (lists refreshed)
```

Pressing Home calls `resetForTxt(null)` (clears all file state) and increments `refreshLanding`, which triggers the landing `useEffect` to re-fetch `fetchRecentAccess` and `fetchRecentBookmarks` so the lists reflect the just-closed session. No automatic bookmark is created on Home — bookmarks are only added by explicit user action (line-bar click or `b` key).

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
- If `--upload-db` is run and the Turso `txt` table already has rows, the command aborts immediately with an error to prevent duplicate data.
