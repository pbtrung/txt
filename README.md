# txt_vault.py

Ingest `.txt` files into a [Turso](https://turso.tech) cloud libSQL database. Each file is split at paragraph boundaries into ~100 KB parts, compressed with Brotli, and encrypted with XChaCha20-Poly1305 before storage.

See [design.md](design.md) for the full architecture, encryption scheme, and database schema.

---

## Install

**Requirements:** Python 3.11+

```bash
pip install pynacl cryptography brotli libsql click
```

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
python3 txt_vault.py --src ./documents --master-key creds.json
```

All `.txt` files (case-insensitive: `.txt`, `.TXT`, etc.) under `./documents` are split, compressed, encrypted, and stored in the Turso database.

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
| `--master-key <path>` | Credentials file (default: `creds.json`) |
| `--gen-master-key <path>` | Add/update `master_key` in the credentials file and exit |
| `--verbose`, `-v` | Enable debug logging (per-part progress, DB URL, schema setup) |

---

## Security notes

- The master key is the single root secret. Store `creds.json` outside version control (add it to `.gitignore`).
- Each part uses a unique per-part key and nonce derived via HKDF-SHA3-256 over a fresh random salt; see [design.md § Encryption Design](design.md#encryption-design).
- Brotli compression is applied *before* encryption to avoid compression-oracle attacks.
