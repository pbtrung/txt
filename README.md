# txt

A personal document-storage system: an encrypted, per-user SQLite (SQLCipher) database, paged remotely into Cloudflare R2 a page at a time, with [InstantDB](https://instantdb.com) holding only identity ([Firebase Auth](https://firebase.google.com/docs/auth)) and opaque, client-encrypted page pointers — never plaintext content or unwrapped keys. This repo is the TypeScript admin CLI (`txt.ts`) for provisioning and maintaining that system.

See [`docs/data_model.md`](docs/data_model.md) for the full design (entities, key hierarchy, commit/read protocols, garbage collection) and [`docs/crypto.md`](docs/crypto.md) for the encryption format.

## Main features

- **`--init-admin`** — provisions the admin account end to end: signs into Firebase, resolves an InstantDB identity for it, generates its key hierarchy, builds its initial encrypted per-user SQLite database, and uploads it page-by-page to R2.
- **`--clean-bucket`** — sweeps an R2 bucket for objects no longer referenced by a (legacy, pre-InstantDB) account snapshot, with a dry-run mode and a confirmation prompt before deleting anything.
- **`--migrate`** — samples documents from a legacy account's database and imports them into an already-provisioned InstantDB account's own SQLCipher database, through the same page-by-page R2 transport `--init-admin` uses.
- **End-to-end encryption throughout**: page content is SQLCipher-encrypted; R2 object addresses and the pointers to them are separately wrapped (Ascon-Keccak AEAD + HKDF-SHA3-512) so neither InstantDB nor R2 ever see plaintext content, real object addresses, or unwrapped keys.

## Install

Requires a Node.js version with native TypeScript support (verified against v26.5.0).

```
npm install
```

## Usage

```
node txt.ts --init-admin <creds.json> [-v|--verbose]

node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]

node txt.ts --migrate --from <in.db> --from-creds <from_creds.json> --to-creds <to_creds.json> \
  [-v|--verbose] [--dry-run] [-y|--yes]
```

`-v`/`--verbose` enables debug logging; `--dry-run` reports what would happen without writing anything; `-y`/`--yes` skips the confirmation prompt for a live (non-dry-run) run.

### Credentials

`--init-admin` and `--migrate --to-creds` take a live-account credentials file:

```json
{
  "instant_app_id": "",
  "instant_client_name": "",
  "instant_admin_token": "",
  "firebase_email": "",
  "firebase_password": "",
  "firebase_api_key": "",
  "display_name": "",
  "r2_config": {
    "endpoint": "",
    "region": "",
    "bucket": "",
    "read_only_access_key_id": "",
    "read_only_secret_access_key": "",
    "read_write_access_key_id": "",
    "read_write_secret_access_key": ""
  },
  "user_root_key": ""
}
```

`--clean-bucket` and `--migrate --from-creds` take a legacy-account credentials file instead (identifies one account in a local sqlite snapshot):

```json
{
  "username": "",
  "username_lookup_key": "",
  "password": "",
  "r2_config": { "...": "same shape as above" },
  "user_root_key": ""
}
```

`user_root_key`/`username_lookup_key` are base64. Never commit a filled-in credentials file — `.gitignore` already blocks all `*.json` except `package.json`/`package-lock.json` for exactly this reason.

## License

MIT — see [LICENSE](LICENSE).
