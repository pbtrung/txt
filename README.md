# txt

A personal document-storage system: an encrypted, per-user SQLite (SQLCipher) database, paged remotely into Cloudflare R2 a page at a time, with [InstantDB](https://instantdb.com) holding only identity ([Firebase Auth](https://firebase.google.com/docs/auth)) and opaque, client-encrypted page pointers — never plaintext content or unwrapped keys. This repo has three parts: the TypeScript admin CLI (`txt.ts`) for provisioning and maintaining an account, the React viewer (`ui/`) end users actually unlock/read/write through, and a Cloudflare Worker (`worker/`) that mints short-lived R2 credentials so no browser session — admin included — ever holds a static R2 key.

See [`docs/data_model.md`](docs/data_model.md) for the entities and permission rules, [`docs/key_hierarchy.md`](docs/key_hierarchy.md) for how the encryption keys nest, [`docs/protocols.md`](docs/protocols.md) for the ingest/read/share/garbage-collection flows, [`docs/r2_credentials.md`](docs/r2_credentials.md) for the R2 credential broker and account provisioning, [`docs/auth.md`](docs/auth.md) for the sign-in flow, and [`docs/crypto.md`](docs/crypto.md) for the encryption format.

## Main features

- **`--init-admin`** — provisions the admin account end to end: signs into Firebase, resolves an InstantDB identity for it, generates its key hierarchy, builds its initial encrypted per-user SQLite database, and uploads it page-by-page to R2.
- **`--clean-bucket`** — sweeps an R2 bucket for objects no longer referenced by a (legacy, pre-InstantDB) account snapshot, with a dry-run mode and a confirmation prompt before deleting anything.
- **`--migrate`** — imports every document from a legacy account's database into an already-provisioned InstantDB account's own SQLCipher database, through the same page-by-page R2 transport `--init-admin` uses. Fetches documents in parallel batches, commits to R2/InstantDB in small part-sized chunks (so one huge document can't blow up a single commit), and resumes an interrupted run at the exact part it left off on, not just the last fully-migrated document.
- **`--collect-garbage`** — the same two garbage-collection sweeps `--migrate` already does for its own target account (delete superseded page-store versions, sweep untracked R2 objects), run app-wide across every provisioned account instead, one account at a time.
- **`ui/`** — the React viewer: unlock a vault with a creds.json file, browse/read documents, bookmark, and write back read-position/bookmark updates, all client-side against InstantDB + R2 directly.
- **`worker/`** — the one server component the design needs: verifies a Firebase ID token and mints a short-lived, prefix-scoped R2 credential for it, so `ui/` never needs a static R2 key.
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

node txt.ts --collect-garbage --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
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

`--migrate --to-creds` doesn't actually need `r2_config` filled in — it reads that account's real R2 connection info from its own live `credStore` row instead (see `docs/data_model.md`), so only the rest of this shape matters there.

`--collect-garbage` takes a much smaller file instead — it never signs into Firebase as any particular account (it enumerates every account directly via the InstantDB Admin SDK), so it only needs enough to find the admin identity and unwrap its own key material:

```json
{
  "instant_app_id": "",
  "instant_admin_token": "",
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

## Deploying `ui/` + `worker/`

`ui/` (the static viewer) and `worker/` (the R2-credential broker) deploy together as one Cloudflare resource: a Worker with a static-assets binding, not classic Cloudflare Pages. You'll need that Worker already created on Cloudflare (an account already run through `--init-admin` above, and an R2 bucket/Firebase project to point it at).

### One-time Cloudflare setup

On that Worker's dashboard, under **Variables and secrets**, set:

| Name                           | Type                  | Value                                                                                                                   |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `READ_WRITE_ACCESS_KEY_ID`     | Secret                | The admin's own R2 `read_write_access_key_id` (same value as the CLI's creds.json `r2_config.read_write_access_key_id`) |
| `READ_WRITE_SECRET_ACCESS_KEY` | Secret                | The matching `read_write_secret_access_key`                                                                             |
| `FIREBASE_PROJECT_ID`          | Variable (not secret) | The Firebase project ID this account's users sign into                                                                  |

(These can't be set until the Worker actually has a script attached — if the dashboard says "Variables cannot be added to a Worker that only has static assets", that's exactly the state a fresh `wrangler deploy` from this repo fixes, since `worker/index.ts` is that script.)

### Build + deploy

```
WORKER_NAME=<your-worker's-name> npm run deploy -- <build-creds.json>
```

`WORKER_NAME` must match the Worker resource's actual name (`npm run deploy` refuses to run without it, rather than risk deploying to the wrong place). `build-creds.json` (defaults to `ui/build-creds.json` if omitted) is a small, separate operator config — distinct from the CLI's own creds.json above, and never committed:

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
