# txt

A private, end-to-end encrypted reading vault. Documents are chunked into parts, encrypted client-side, and stored as objects in R2/S3; each user's own metadata — titles, read position, bookmarks — lives in that user's own SQLCipher-encrypted SQLite database, which is itself persisted page-by-page (not as one opaque file) in an [rqlite](https://rqlite.io) cluster.

## Main features

- **Client-side encryption throughout** — R2/S3 never sees plaintext content; rqlite never sees plaintext or an encryption key, only opaque SQLCipher page ciphertext.
- **Per-user database, not shared rows** — one SQLCipher-encrypted SQLite database per user, persisted page-by-page in rqlite's own page-store schema.
- **`ui/`** — the browser reading app end users actually use: a React/Vite frontend that opens a user's SQLCipher database lazily and read-write, page by page, directly against a live `docker/` deployment (no full-database download). See [ui/](ui/) and [docker/README.md](docker/README.md#serving-ui).
- **`txt.ts`**, the admin CLI — brings an existing vault onto this schema (`--migrate`), then maintains it day to day (`--clean-bucket`, `--collect-garbage`, `--vacuum`) and measures the lazy-remote-read tradeoff (`--test-perf`). See [docs/cli.md](docs/cli.md) for the full command reference.
- **`docker/`** — an OpenResty + rqlite container image fronting the page store with per-tenant API-key auth, forced tenant isolation, and health checks. See [docker/README.md](docker/README.md).

See [docs/data_model.md](docs/data_model.md) for both schemas (the page store and the per-user database) and the reasoning behind every design choice in them, and [docs/crypto.md](docs/crypto.md) for the blob format used wherever content needs its own encryption outside the SQLCipher file.

## Install

Requires Node.js 22.6+ (developed and tested against Node 26). One `npm install` at the repo root sets up both `txt.ts` (no build step of its own — TypeScript sources run directly via Node's native type-stripping) and `ui/` (a real Vite build, see below).

```
npm install
```

## Usage

```
node txt.ts --migrate --in-creds <file> --in <file> --out-creds <file> --out <file> [--no-delete] [--verbose]
node txt.ts --clean-bucket --creds <file> --db <file> [--dry-run] [--verbose]
node txt.ts --collect-garbage --db <file> [--dry-run] [--verbose]
node txt.ts --vacuum --creds <file> --db <file> [--verbose]
node txt.ts --update-db --creds <file> --db <file> [--verbose]
node txt.ts --test-perf --creds <file> [--verbose]
```

See [docs/cli.md](docs/cli.md) for every flag, each command's `creds.json` shape, and the `npm run typecheck`/`npm test`/`npm run format` development commands.

### `ui/`

```
npm run ui:dev      # Vite dev server
npm run ui:build    # production build -> dist/ + creds/local_index.html
npm run ui:test     # unit/component tests (real SQLCipher db, mocked network/Worker)
npm run ui:test:e2e # real headless Chromium against a real build (needs Chromium locally)
```

`ui:build` needs `ui/build-creds.json` (gitignored) — see `ui/scripts/build-integrity.mjs`'s own header comment for its shape. `dist/` deploys to Cloudflare Pages, not `docker/` (rqlite/OpenResty only) — see [docker/README.md](docker/README.md#serving-ui).
