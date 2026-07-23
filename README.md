# txt

A fully client-side-encrypted text vault. [Turso](https://turso.tech) (libSQL/SQLite-compatible cloud) holds all structured data — accounts, wrapped keys, R2 object paths, sharing grants, bookmarks, and read-position — but only ever sees ciphertext, or values that are already public. Document content itself lives in Cloudflare R2 object storage, not Turso; Turso only holds the (wrapped) R2 path. All encryption, decryption, and key (un)wrapping happens client-side, via `txt.py`, never in the database.

See [CLAUDE.md](CLAUDE.md) for the full architecture, and [docs/](docs) for the schema, key hierarchy, crypto primitives, and credential model.

## Requirements

- Python 3.14+
- [leancrypto](https://leancrypto.org) (AEAD, HKDF, HMAC, PBKDF2, and the ML-KEM-1024 + X448 KEM), installed as a shared library findable by `ctypes.util.find_library` (e.g. on Arch/CachyOS: `yay -S leancrypto`, then `ldconfig`)
- A Turso database
- A Cloudflare R2 bucket, with a read-only and a read-write API key pair

## Install

```sh
pip install click libsql brotli boto3
```

(There's no `requirements.txt`/`pyproject.toml` yet — these are the only third-party packages `txt.py` imports.)

## Configure

Create `admin_creds.json` with the following shape:

```json
{
  "turso_database_url": "libsql://<your-db>.turso.io",
  "turso_auth_token": "<a read-write Turso token>",
  "username": "<login handle>",
  "username_lookup_key": "<32+ random bytes, base64>",
  "password": "<login password>",
  "display_name": "<display name>",
  "r2_config": {
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "read_only_access_key_id": "...",
    "read_only_secret_access_key": "...",
    "read_write_access_key_id": "...",
    "read_write_secret_access_key": "...",
    "region": "auto",
    "bucket": "..."
  },
  "user_root_key": "<256+ random bytes, base64>",
  "asset_base_url": "<public URL the UI's built assets are served from>",
  "slhdsa_256f_priv_key": "<leave empty -- `ui`'s build step fills this in the first time it runs>"
}
```

See [docs/credentials.md](docs/credentials.md) for what each field means and why the admin role specifically needs the read-write R2 key pair.

## Use

Initialize the schema and the admin account (safe to re-run — it fills in anything missing rather than erroring):

```sh
python3 txt.py --init --admin-creds admin_creds.json
```

Ingest every `.txt` file (matched case-insensitively) from a directory into the vault — already-ingested filenames are skipped, and a `<name>.epub.txt` file with a sibling `<name>.opf` (a Calibre metadata sidecar, also matched case-insensitively) gets that OPF's `<metadata>` recorded alongside it:

```sh
python3 txt.py --txt-ingest txt_src/ --admin-creds admin_creds.json
```

Download every txt back out, concatenating each document's parts into a single file per document:

```sh
python3 txt.py --txt-download txt_out/ --admin-creds admin_creds.json
```

Delete every txt, its R2 parts, and all dependent rows (shares, bookmarks, read-position) — prompts for confirmation unless `-y`/`--yes` is given:

```sh
python3 txt.py --txt-delete --admin-creds admin_creds.json
```

Delete every object in the R2 bucket, regardless of what the DB knows about — prompts for confirmation unless `-y`/`--yes` is given:

```sh
python3 txt.py --purge-bucket --admin-creds admin_creds.json
```

Delete every R2 object that isn't referenced by any of this account's txt_parts — housekeeping for objects orphaned by e.g. a crash mid-ingest — prompts for confirmation unless `-y`/`--yes` is given:

```sh
python3 txt.py --txt-clean-bucket --admin-creds admin_creds.json
```

`--txt-ingest`/`--txt-download`/`--txt-delete`/`--purge-bucket`/`--txt-clean-bucket` all operate on parts/objects concurrently, capped at `R2_NUM_THREADS` (see `txt/constants.py`) parallel R2 requests, and R2 reads/writes/deletes retry with exponential backoff (2s/4s/8s, up to 3 retries) before giving up. Add `-v`/`--verbose` to any command for debug-level logging. Run `python3 txt.py --help` for the full option list.

## Test

```sh
pip install pytest pytest-cov
pytest --cov=txt --cov-report=term-missing
```

Unit tests live in `tests/`; `tests/test_crypto.py` covers `txt/crypto.py`'s blob format, AEAD, KDF, and KEM primitives against the real `leancrypto` bindings (no mocking).

## Web UI

`ui/` is a client-side-encrypted web reader (React + TypeScript + Vite) for the same
vault: Unlock, Library, and Reader screens per [docs/ui.md](docs/ui.md)'s design. All
crypto and R2/Turso access happens in the browser, mirroring `txt/crypto.py`/`txt/owner.py`
in TypeScript (`ui/src/crypto/`, `ui/src/data/`) — the same leancrypto AEAD/HKDF/KEM
primitives (via the prebuilt `ui/leancrypto/leancrypto.js`/`.wasm`), the same blob format,
the same schema. It reads a config file shaped like `user_cred_template.json` but without
`r2_config` — that's fetched from Turso's `r2_config` table and decrypted with the
account's `umk` instead, same as `key_store.priv_key`.

```sh
cd ui
npm install
npm run dev      # http://localhost:5173
npm test
npm run build -- --admin-creds ../creds/admin_creds.json    # -> ui/dist + creds/local_index.html
```

### Verbose logging

On by default. Load the app with `?verbose=0` in the URL to turn it off for that page
load (`ui/src/log.ts`; toggle mid-session with `setVerbose()` instead of reloading if you
don't want to lose an in-progress session — it isn't persisted across reloads, same as
`VaultContext`'s own session state). It logs `unlock()`'s steps
(`ui/src/state/VaultContext.tsx` — parsing the config, resolving the user id, checking
the password, unwrapping `umk`, loading metadata/access/bookmarks) and every
`db.execute()` call, from any screen, logs its SQL/args and either its row count or its
error (`ui/src/data/db.ts`).

### Locally-verified boot (`local_index.html`)

`npm run build -- --admin-creds <path>` also writes `creds/local_index.html` (never
`ui/dist/` — it's never uploaded to the CDN). Open that file directly (e.g. via
`file://`) instead of the deployed URL, and it cryptographically verifies every
built asset before ever rendering the Unlock screen — a spinner and a 5-line
progress list (`Fetching manifest` / `Verifying signature` / `Fetching assets` /
`Verifying asset hashes` / `Loading application`) track it.

This exists to fix a real gap in an earlier design this project tried: a verifier
that shipped as part of the same CDN-served bundle it was checking could simply be
tampered away by whatever compromised that CDN. `local_index.html` never touches
the CDN at all *except* to fetch and verify — it embeds its own public key and its
own copy of the verification logic (including a self-contained, inlined build of
[`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum)'s
`slh_dsa_sha2_256f` — no CDN/npm fetch at verify-time), generated once at build time
and then kept only on your machine, in `creds/` (gitignored, matching
`admin_creds.json`).

At build time (`ui/scripts/build-integrity.mjs`):

- an SLH-DSA-SHA2-256f keypair is loaded from `admin_creds.json`'s
  `slhdsa_256f_priv_key` if present, or generated once (and written back there) if
  it's still empty — a rebuild never silently invalidates `local_index.html` copies
  already in use, since the key doesn't change unless you clear that field yourself;
- every file under `ui/dist/` is SHA-512'd into `dist/manifest.json`, signed with
  that key into `dist/manifest.sig`;
- `ui/dist/index.html`'s own `<script>`/`<link rel=stylesheet>` tags get
  `integrity="sha512-..."` (SRI, computed with Node's built-in `crypto`, no external
  package) added — this hardens the *separate* case of someone visiting the CDN URL
  directly, bypassing `local_index.html` entirely, against a MITM/cache swapping
  those two files while leaving `index.html` unchanged;
- `ui/dist/_headers` (Cloudflare Pages' response-header config file, also understood
  by Netlify and Cloudflare's Workers Static Assets) sets two things for every file
  under `ui/dist/`:
  - a real `Content-Security-Policy` header for the direct-CDN-visit case, mirroring
    `index.html`'s own `<meta>` CSP except `connect-src`, narrowed from that meta
    tag's deliberately-open `*` down to `'self'` plus the Turso/R2 host patterns the
    app actually talks to. A header and a `<meta>` CSP both apply at once and combine
    by intersection, so this tightens the effective policy without having to touch
    the per-account-agnostic meta tag itself;
  - `Access-Control-Allow-Origin: null`, so `local_index.html` (opened via `file://`,
    sending `Origin: null`) can actually read the response bodies of its cross-origin
    fetches to `manifest.json`/`manifest.sig`/every other asset — without it, those
    fetches resolve but the browser blocks reading the body (`... has been blocked by
    CORS policy: No 'Access-Control-Allow-Origin' header is present`).

  `_headers` is a deploy-time config file, never itself a fetchable path, so it's
  excluded from `manifest.json`/`local_index.html`'s own checks. This only takes
  effect if whatever serves `asset_base_url` actually reads a `_headers` file
  (Cloudflare Pages and Workers Static Assets do; a bucket served directly, with no
  such layer in front of it, does not — see the CORS section below for that case).

At open time, `local_index.html`:

1. fetches `{asset_base_url}/manifest.json` and `manifest.sig`, and verifies the
   signature over `manifest.json`'s exact bytes with the embedded public key —
   nothing is trusted before this passes;
2. fetches every file the now-trusted manifest lists and SHA-512s each one (native
   `crypto.subtle`, no external package) against its recorded digest;
3. once everything verifies, mounts the app directly from those already-verified
   bytes (an inlined `<style>`/`<script type="module">`) — it never re-fetches
   `index.html`/the entry JS/CSS a second time, since doing so would reopen the
   exact gap this exists to close.

**Known limitation**: only the entry JS/CSS get this full treatment. Fonts,
`leancrypto.wasm`/`brotli_wasm`, and the one dynamically-imported JS chunk are
still hashed once during step 2 above, but the *running app* fetches them again
live later (via CSS `url()`, a dynamically created `<script src="/leancrypto.js">`,
and a dynamic `import()`) without re-checking that later fetch against the
manifest — a narrower version of today's total absence of any check, not an
airtight guarantee.

**Router**: `history.pushState()`/`replaceState()` (which `BrowserRouter` needs for
every navigation) throws a `SecurityError` in a document with an opaque/null origin
— exactly `local_index.html`'s situation, since the real app's own bundle runs
unmodified inside it. `ui/src/appRouter.ts`'s `pickRouterComponent()` switches to
`MemoryRouter` (navigation kept entirely in JS, no `window.history` calls at all)
whenever `location.protocol === "file:"`. Accepted tradeoff: the address bar won't
reflect in-app navigation, and back/forward won't move between screens, when run
this way.

**Requires**: opening `local_index.html` via `file://` sends `Origin: null` on its
cross-origin fetches to `asset_base_url`. `dist/_headers` (above) covers this
automatically when `asset_base_url` is served by Cloudflare Pages or Workers Static
Assets. If it instead points directly at an R2 bucket's public URL with nothing in
front of it, add `"null"` to that bucket's `AllowedOrigins` instead (see the CORS
section right below) — either way, without one of these, the fetches resolve but
fail to read the response body.

### R2 bucket CORS policy (required)

Cloudflare R2 buckets ship with **no CORS policy at all** by default, which silently
blocks every part fetch: a signed GET carries an `Authorization`/`x-amz-date`/
`x-amz-content-sha256` header set, making it a "non-simple" cross-origin request, so the
browser sends a CORS preflight (`OPTIONS`) before it — and with no policy, that preflight
has nothing to grant it, failing with a `TypeError: Failed to fetch` that looks identical
to a plain network error (the browser deliberately doesn't distinguish the two). This only
affects the browser UI, not `txt.py` (boto3 runs server-side, unaffected by CORS).

Set a policy on the bucket (Cloudflare dashboard → R2 → your bucket → Settings → CORS
Policy, or `aws s3api put-bucket-cors --endpoint-url <r2 endpoint> ...`) allowing GET from
wherever the UI is served:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

Add every origin the UI is actually served from (e.g. a deployed origin, not just
`localhost`) as another entry in `AllowedOrigins`. `AllowedHeaders: ["*"]` is the safe
default — a narrower list has to include every header the SigV4 signature adds, or the
preflight still fails the same way.

If you're using `local_index.html`: a `file://` page's `Origin` is `null`, but R2 may
not accept the literal string `"null"` as an `AllowedOrigins` entry. `"AllowedOrigins":
["*"]` is the practical fix — these GETs carry no cookies/credentials, so a wildcard
origin is safe here.

## License

[MIT](LICENSE)
