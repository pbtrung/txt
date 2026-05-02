# txt_vault.py

Ingest `.txt` files into a [Turso](https://turso.tech) cloud libSQL database. Each file is split at paragraph boundaries into ~100 KB parts, compressed with Brotli, and encrypted with XChaCha20-Poly1305 before storage.

See [design.md](design.md) for the full architecture, encryption scheme, and database schema.

---

## Install

**Requirements:** Python 3.11+

```bash
pip install pynacl cryptography brotli libsql-experimental click
```

---

## Setup

1. **Create a Turso database** and note the database URL and auth token from the Turso dashboard.

2. **Export credentials** in your shell:

   ```bash
   export TURSO_DATABASE_URL="libsql://your-db.turso.io"
   export TURSO_AUTH_TOKEN="your-token-here"
   ```

3. **Generate a master key** (keep this file secret — losing it means losing access to all stored data):

   ```bash
   python3 txt_vault.py --gen-master-key master_key.json
   ```

---

## Usage

### Ingest a folder of `.txt` files

```bash
python3 txt_vault.py --src ./documents --master-key master_key.json
```

All `*.txt` files under `./documents` are split, compressed, encrypted, and stored in the Turso database.

### Generate a new master key

```bash
python3 txt_vault.py --gen-master-key master_key.json
```

Writes a fresh 32-byte random key to `master_key.json`. Exits immediately — does not touch the database.

---

## Options

| Flag | Description |
|------|-------------|
| `--src <path>` | Folder containing `.txt` files to ingest |
| `--master-key <path>` | Master key file (default: `master_key.json`) |
| `--gen-master-key <path>` | Generate a new master key file and exit |

---

## Security notes

- The master key is the single root secret. Store `master_key.json` outside version control.
- Each part uses a unique per-part key and nonce derived via HKDF-SHA3-256 over a fresh random salt; see [design.md § Encryption Design](design.md#encryption-design).
- Brotli compression is applied *before* encryption to avoid compression-oracle attacks.
