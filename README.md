# txt_vault

Ingest `.txt` files into a [Turso](https://turso.tech) cloud libSQL database. Each file is split at paragraph boundaries into ~200 KB parts, compressed with Brotli, and encrypted with Ascon-Keccak before storage. All cryptography is provided by [leancrypto](https://github.com/smuellerDD/leancrypto), loaded as a system shared library.

`txt_vault.py` is the entry point; all logic lives in the `txt_vault/` package.

See [design.md](design.md) for the full architecture, encryption scheme, and database schema.

---

## Install

**Requirements:** Python 3.11+, leancrypto installed as a system library

```bash
pip install brotli libsql click
```

Install leancrypto via your package manager or build from source, then run `ldconfig` so the shared library is discoverable.

---

## Setup

1. **Create a Turso database** and note the database URL and auth token from the Turso dashboard.

2. **Create `creds.json`** with your Turso credentials (keep this file secret):

   ```json
   {
     "turso_database_url": "libsql://your-db.turso.io",
     "turso_auth_token": "your-token-here",
     "master_key": ""
   }
   ```

   Alternatively, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as environment variables (they take precedence over the file).

3. **Generate a master key** and write it into `creds.json`:

   ```bash
   python3 txt_vault.py --gen-master-key creds.json
   ```

4. **Create the bookmarks table** (one-time setup, after the main schema exists):

   ```bash
   python3 txt_vault.py --create-bookmarks --creds creds.json
   ```

---

## Usage

### Ingest a folder of `.txt` files

```bash
python3 txt_vault.py --src ./documents --creds creds.json
```

All `.txt` files (case-insensitive: `.txt`, `.TXT`, etc.) under `./documents` are split, compressed, encrypted, and stored in the Turso database. Files whose name already exists in the database are **skipped**. The `part_count` table is updated automatically after each file is committed.

To overwrite existing entries:

```bash
python3 txt_vault.py --src ./documents --force --creds creds.json
```

### Upload a local SQLite database

```bash
python3 txt_vault.py --upload-db sh.db --creds creds.json -v
```

Copies all rows from a local SQLite database to Turso. The Turso `txt` table must be empty before uploading — the command aborts if any rows already exist to prevent duplicates. If the local database has a `bookmarks` table that Turso is missing, it is created automatically. Tables are uploaded in order (`txt`, `txt_parts`, `part_count`, `txt_access`, `bookmarks`) and committed every 10 rows. Pass `-v` to see per-table progress.

### Rebuild part counts

```bash
python3 txt_vault.py --part-count --creds creds.json
```

Queries `txt_parts` and upserts the total part count for every `txt_id` into the `part_count` table. Does not decrypt anything — only the Turso credentials from `--creds` are needed.

### Create the bookmarks table

```bash
python3 txt_vault.py --create-bookmarks --creds creds.json
```

Creates the `bookmarks` table, index, and the per-file limit trigger. Safe to run once after initial schema setup — uses `CREATE … IF NOT EXISTS` so it is idempotent. Pass `-v` to print per-step progress.

### Recreate the bookmarks table

```bash
python3 txt_vault.py --recreate-bookmarks --creds creds.json
```

Drops the existing `bookmarks` table (cascading the index and trigger), then recreates it from scratch. Use this when the bookmark schema changes. **All existing bookmarks are lost.** Pass `-v` to print per-step progress.

### Generate a new master key

```bash
python3 txt_vault.py --gen-master-key creds.json
```

Adds or updates only the `master_key` field in `creds.json`. If the field already exists, you are asked to confirm before overwriting. Other fields (`turso_database_url`, `turso_auth_token`) are never modified. Exits immediately — does not touch the database.

---

## Options

| Flag | Description |
|------|-------------|
| `--src <path>` | Folder containing `.txt` files to ingest; skips files already in the database |
| `--force` | With `--src`: overwrite existing entries instead of skipping |
| `--creds <path>` | Credentials file with Turso URL/token and master key (default: `creds.json`) |
| `--part-count` | Rebuild `part_count` table from existing `txt_parts` rows and exit |
| `--create-bookmarks` | Create bookmarks table, index, and trigger and exit; progress shown with `-v` |
| `--recreate-bookmarks` | Drop and recreate bookmarks table (all bookmarks lost) and exit; progress shown with `-v` |
| `--upload-db <file>` | Upload all rows from a local SQLite db to Turso; Turso `txt` must be empty |
| `--gen-master-key <path>` | Add/update `master_key` in the credentials file and exit |
| `--read-part <id>` | Decrypt and write a single part by its `txt_parts.id` |
| `--out <path>` | Output file path for `--read-part` |
| `--verbose`, `-v` | Enable debug logging (per-part progress, DB URL, schema setup, upload progress) |

---

## UI

A browser-based reader built with React + Bootstrap. Upload `creds.json` to connect, then browse and read encrypted files directly in the browser — all decryption happens client-side.

**Requirements:** Node.js 18+

```bash
cd ui
npm install
```

### Development server

```bash
npm run dev
```

### Production build

```bash
npm run build
```

Output goes to `ui/dist/`. Serve it with any static file server.

### Recently accessed

Before selecting a file, the content area shows the 7 most recently accessed files. Each entry displays the file name and the last-read part number; clicking it opens that file and resumes at the saved part.

### Bookmarks

The reader supports per-line bookmarks, stored encrypted in the database. A DB trigger enforces a rolling window of 12 per file: when a 13th bookmark is added the oldest one (by insertion order) is automatically evicted.

- **Add / remove:** click the thin bar to the left of any line to toggle a bookmark. The bar turns blue when the line is bookmarked.
- **Bookmark panel:** click the **Bookmarks** button in the top bar to open a dropdown listing all bookmarks for the current file. Click any entry to jump to it; click **×** to delete it.
- **Chooser on open:** when a file is selected and it already has bookmarks, the content area shows a sorted bookmark list instead of auto-loading part 1. Click an entry to jump directly to that position, or use the part controls to start from the beginning. Bookmarks can also be deleted from this view.
- **Encryption:** each bookmark is stored as a brotli-compressed, AEAD-encrypted JSON blob `{"part_num":…,"line":…,"txt_preview":…}` using the same key-derivation and cipher as `txt_parts`. The database never sees plaintext positions or previews.

---

## Security notes

- The master key is a 128-byte random secret — the single root of all encryption. Store `creds.json` outside version control (add it to `.gitignore`).
- Each part uses a unique 64-byte random salt. HKDF-SHA3-512 derives a 64-byte key and 64-byte IV from that salt; the salt is also passed as AAD so any tampering with it fails authentication.
- Filenames are encrypted independently with their own random salt; a co-derived HMAC-SHA3-256 key enables lookup without exposing the plaintext name.
- Bookmark blobs use the same encrypt-then-MAC scheme with a fresh random salt per bookmark; the `txt_id` foreign key is the only plaintext metadata stored.
- Brotli compression is applied *before* encryption to avoid compression-oracle attacks.
