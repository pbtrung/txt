# txt_vault.py

Ingest `.txt` files into a [Turso](https://turso.tech) cloud libSQL database. Each file is split at paragraph boundaries into ~100 KB parts, compressed with Brotli, and encrypted with Ascon-Keccak before storage. All cryptography is provided by [leancrypto](https://github.com/smuellerDD/leancrypto), loaded as a system shared library.

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

---

## Usage

### Ingest a folder of `.txt` files

```bash
python3 txt_vault.py --src ./documents --creds creds.json
```

All `.txt` files (case-insensitive: `.txt`, `.TXT`, etc.) under `./documents` are split, compressed, encrypted, and stored in the Turso database. The `part_count` table is updated automatically after each file is committed.

### Rebuild part counts

```bash
python3 txt_vault.py --part-count --creds creds.json
```

Queries `txt_parts` and upserts the total part count for every `txt_id` into the `part_count` table. Does not decrypt anything — only the Turso credentials from `--creds` are needed.

### Generate a new master key

```bash
python3 txt_vault.py --gen-master-key creds.json
```

Adds or updates only the `master_key` field in `creds.json`. If the field already exists, you are asked to confirm before overwriting. Other fields (`turso_database_url`, `turso_auth_token`) are never modified. Exits immediately — does not touch the database.

---

## Options

| Flag | Description |
|------|-------------|
| `--src <path>` | Folder containing `.txt` files to ingest (case-insensitive match) |
| `--creds <path>` | Credentials file with Turso URL/token and master key (default: `creds.json`) |
| `--part-count` | Rebuild `part_count` table from existing `txt_parts` rows and exit |
| `--gen-master-key <path>` | Add/update `master_key` in the credentials file and exit |
| `--read-part <id>` | Decrypt and write a single part by its `txt_parts.id` |
| `--out <path>` | Output file path for `--read-part` |
| `--verbose`, `-v` | Enable debug logging (per-part progress, DB URL, schema setup) |

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

---

## Security notes

- The master key is a 128-byte random secret — the single root of all encryption. Store `creds.json` outside version control (add it to `.gitignore`).
- Each part uses a unique 64-byte random salt. HKDF-SHA3-512 derives a 64-byte key and 64-byte IV from that salt; the salt is also passed as AAD so any tampering with it fails authentication.
- Filenames are encrypted independently with their own random salt; a co-derived HMAC-SHA3-256 key enables lookup without exposing the plaintext name.
- Brotli compression is applied *before* encryption to avoid compression-oracle attacks.
