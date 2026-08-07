# txt

A personal document-storage system built on a single [InstantDB](https://instantdb.com) app (identity via [Firebase Auth](https://firebase.google.com/docs/auth)) plus Cloudflare R2 for content, encrypted end-to-end — InstantDB and R2 both only ever see ciphertext, never plaintext content, real object addresses, or unwrapped keys. This repo has three parts: the TypeScript admin CLI (`txt.ts`) for provisioning an account and importing documents, the React viewer (`ui/`) end users actually unlock/read/write through, and a Cloudflare Worker (`worker/`) that mints short-lived R2 credentials so no frontend R2 client uses a static R2 key.

`txt.ts`, `ui/`, and `worker/` all implement the same InstantDB entity design: each document is its own set of InstantDB entities (`txt`/`txtMetadata`/`txtParts`, plus a Kyber/X448 keypair per account for sharing) with per-part R2 objects — see the `docs/` files below.

See [`docs/data_model.md`](docs/data_model.md) for the entities and permission rules, [`docs/key_hierarchy.md`](docs/key_hierarchy.md) for how the encryption keys nest, [`docs/protocols.md`](docs/protocols.md) for the ingest/read/share/cleanup flows, [`docs/r2_credentials.md`](docs/r2_credentials.md) for the R2 credential broker and account provisioning, [`docs/auth.md`](docs/auth.md) for the sign-in flow, and [`docs/crypto.md`](docs/crypto.md) for the encryption format.

## Main features

- **`--init-admin`** — provisions the admin account end to end: signs into Firebase, resolves an InstantDB identity for it, generates its key hierarchy (a `keyStore` Kyber/X448 keypair and a `credStore` row holding its real R2 credentials), and writes both in one transaction. No per-user database or initial upload needed.
- **`--ingest`** — cleans, splits, and uploads every `.txt` file in a directory (skipping any filename already recorded under an owned document) as its own `txt`/`txtMetadata`/`txtParts` InstantDB entities plus per-part R2 objects, with an optional Calibre `.opf` sidecar folded into a `.epub.txt` file's metadata. Nothing is written to InstantDB for a file until every one of its parts has already uploaded — a failed file leaves no trace to resume from and is retried whole on the next run.
- **`--clean-bucket`** — sweeps an R2 bucket for objects no longer referenced by any admin-owned `txtParts` row in InstantDB (including R2 objects a crashed `--ingest` run left behind), with a dry-run mode and a confirmation prompt before deleting anything.
- **`--update-db-catalog`** — rebuilds every admin-owned `txtMetadata.catalog` projection from full encrypted metadata, overwriting older projections so newly added fields are backfilled.
- **`--update-db-prefixHash`** — backfills/repairs every admin-owned `txt.prefixHash` from its own decrypted `prefix`, the plaintext commitment the R2-credential Worker checks a caller-supplied prefix against.
- **`ui/`** — the React viewer: unlock a vault with a creds.json file, browse/read documents, bookmark, and write back read-position/bookmark updates, all client-side against InstantDB + R2 directly.
- **`worker/`** — the one server component the design needs: verifies a Firebase ID token and mints a short-lived, prefix-scoped R2 credential for it, so `ui/` never needs a static R2 key.
- **End-to-end encryption throughout**: the CLI wraps every document/part/key in the AEAD blob format (Ascon-Keccak + HKDF-SHA3-512) and uses a Kyber/X448 KEM to share a document with another account — see `docs/crypto.md`.

## Install

Requires a Node.js version with native TypeScript support (verified against v26.5.0).

```
npm install
```

## Usage

```
node txt.ts --init-admin <creds.json> [-v|--verbose]

node txt.ts --clean-bucket --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]

node txt.ts --ingest <dir> --creds <creds.json> [-v|--verbose] [--dry-run]

node txt.ts --update-db-catalog --creds <creds.json> [-v|--verbose] [--dry-run]

node txt.ts --update-db-prefixHash --creds <creds.json> [-v|--verbose] [--dry-run]
```

`-v`/`--verbose` enables debug logging; `--dry-run` reports what would happen without writing anything; `-y`/`--yes` skips the confirmation prompt for a live (non-dry-run) run.

### Credentials

`--init-admin` takes a live-account credentials file. This is also the one file `npm run deploy` needs (see "Build + deploy" below) — `slhdsa_256f_priv_key`/`asset_base_url` are ignored by `--init-admin`, carried through purely so one creds.json can serve both purposes instead of two separate files:

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
    "read_only_access_key_id": "",
    "read_only_secret_access_key": "",
    "read_write_access_key_id": "",
    "read_write_secret_access_key": "",
    "region": "",
    "bucket": ""
  },
  "slhdsa_256f_priv_key": "",
  "asset_base_url": "",
  "user_root_key": ""
}
```

`--ingest`, `--clean-bucket`, `--update-db-catalog`, and `--update-db-prefixHash` take a much smaller file instead — none of them sign into Firebase as any particular account (they enumerate through the InstantDB Admin SDK), so they only need enough to find the admin identity and unwrap its own key material:

```json
{
  "instant_app_id": "",
  "instant_admin_token": "",
  "user_root_key": ""
}
```

`user_root_key` is base64. Never commit a filled-in credentials file — `.gitignore` already blocks all `*.json` except `package.json`/`package-lock.json` for exactly this reason.

## Deploying `ui/` + `worker/`

`ui/` (the static viewer) and `worker/` (the R2-credential broker) deploy together as one Cloudflare resource: a Worker with a static-assets binding, not classic Cloudflare Pages. You'll need that Worker already created on Cloudflare (an account already run through `--init-admin` above, and an R2 bucket/Firebase project to point it at).

### One-time Cloudflare setup

On that Worker's dashboard, under **Variables and secrets**, set:

| Name                           | Type                  | Value                                                                                                                   |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `READ_WRITE_ACCESS_KEY_ID`     | Secret                | The admin's own R2 `read_write_access_key_id` (same value as the CLI's creds.json `r2_config.read_write_access_key_id`) |
| `READ_WRITE_SECRET_ACCESS_KEY` | Secret                | The matching `read_write_secret_access_key`                                                                             |
| `R2_BUCKET`                    | Variable (not secret) | The bucket containing encrypted document-part objects                                                                   |
| `R2_ENDPOINT`                  | Variable (not secret) | The account endpoint, for example `https://<account-id>.r2.cloudflarestorage.com`                                       |
| `FIREBASE_PROJECT_ID`          | Variable (not secret) | The Firebase project ID this account's users sign into                                                                  |

(These can't be set until the Worker actually has a script attached — if the dashboard says "Variables cannot be added to a Worker that only has static assets", that's exactly the state a fresh `wrangler deploy` from this repo fixes, since `worker/index.ts` is that script.)

### Build + deploy

```
WORKER_NAME=<your-worker's-name> npm run deploy -- <build-creds.json>
```

`WORKER_NAME` must match the Worker resource's actual name (`npm run deploy` refuses to run without it, rather than risk deploying to the wrong place). `build-creds.json` (defaults to `ui/build-creds.json` if omitted) only needs `asset_base_url`/`slhdsa_256f_priv_key` filled in — pass the same creds.json used for `--init-admin` above (its other fields are ignored here), or a separate, smaller file if you'd rather keep them apart. Never commit either:

```json
{
  "asset_base_url": "https://your-worker.your-subdomain.workers.dev",
  "slhdsa_256f_priv_key": ""
}
```

`asset_base_url` is the public URL this deployment serves its static assets from (your Worker's own `*.workers.dev` URL or custom domain) — baked into `creds/local_index.html`'s bundled verifier (see `ui/scripts/build-integrity.mjs`). `slhdsa_256f_priv_key` is optional: left empty (or omitted) on the first deploy, a fresh keypair is generated and written back into this same file, then reused on every later deploy so already-distributed `local_index.html` copies don't get silently invalidated.

Other useful commands:

```
npm run ui:dev           # Vite dev server against a real InstantDB app + R2 bucket
npm run ui:build         # tsc -b + vite build -> dist/, then build-integrity.mjs
npm run ui:test          # vitest
npm run worker:dev       # wrangler dev -- serves dist/ + worker/index.ts locally
npm run worker:typecheck # wrangler types + tsc -b worker/tsconfig.json
```

## License

MIT — see [LICENSE](LICENSE).
