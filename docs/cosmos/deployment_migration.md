# Deployment, migration, and operations

This migration replaces two persistence mechanisms and the API runtime at once.
Use a scheduled owner-write maintenance window and a reversible cutover. Do not
attempt unversioned dual writes between a whole SQLCipher database object and
encrypted Cosmos rows.

## Provision Cosmos DB

Before applying infrastructure, recheck Azure's current free-tier and service
limits. The intended account configuration is:

- Azure Cosmos DB for NoSQL;
- free tier enabled when the account is created;
- one write region chosen for measured latency from the owner's usual Fastly
  POPs;
- provisioned throughput, not serverless;
- 1,000 RU/s manual throughput on the database, shared by all containers;
- Session consistency;
- periodic backup enabled and explicitly configured/recorded;
- local/key authentication enabled for Fastly's signed REST requests;
- TLS only; and
- no browser origin in Cosmos CORS, because browsers never call Cosmos.

The Cosmos data-plane endpoint must be reachable from Fastly's configured
backend. If firewall allowlisting is used, maintain the complete supported
Fastly origin-egress ranges as infrastructure data and test them before every
cutover; do not guess POP addresses. TLS and Cosmos request signatures remain
mandatory even with a firewall.

Create the database and four containers from [data_model.md](data_model.md):

1. `owner_control`, partition `/owner_pk`, no default TTL;
2. `share_control`, partition `/registry_pk`, no default TTL;
3. `rate_limit_control`, partition `/bucket_pk`, default TTL enabled; and
4. `vault`, partition `/owner_pk`, no default TTL.

Apply minimal indexing policies before import; later policy transformations
consume RUs. Do not configure a unique-key policy for mutable share mappings:
same-partition reservation documents and transactional batches provide the
required uniqueness.

Do not create a Cosmos native browser user or permission. Verify in staging
that no UI response or asset contains an account key, resource token, Cosmos
endpoint, resource link, or Azure access token.

## Fastly Compute target deployment

Create a JavaScript or Rust Fastly Compute service implementing
[auth_api.md](auth_api.md). Configure:

- the exact public API domain with TLS;
- a static Cosmos backend whose address, `Host` override, SNI hostname, and
  certificate hostname are the exact Cosmos account hostname;
- a static Firebase certificate backend and R2 control/data backends as needed;
- a linked Config Store for nonsecret IDs, origins, route limits, API versions,
  and backend names, with desired values tracked in deployment configuration;
- a linked Secret Store for the Cosmos account key, R2 credentials, share-grant
  key, and rate-limit key;
- no cache lookup/storage for `/v1/*` and health responses; and
- redacted structured logging that never records request/response bodies or
  credential-bearing headers.

Remove the rqlite process, OpenResty Lua API, operator proxy, Northflank service,
persistent volume, and native rqlite backup job only after rollback retention.
Fastly is request-driven and stateless; durable rate limits and share state live
in Cosmos, not Compute memory.

Pin the Fastly SDK/runtime and compatible JWT implementation. Test Firebase key
rotation/unknown-`kid` behavior, Cosmos HMAC signing, backend TLS identity,
conditional writes, transactional-batch serialization, response size limits,
and secret-read failures in both the local Compute server and a staging Fastly
service. The local server is not a perfect simulation of production edge
routing, so production-like staging is a release requirement.

Readiness performs only fixed server-credential point reads. It validates
supported schema markers and expected partition-key paths. An absent or
mismatched owner item remains unready; web startup never initializes owner keys.

## Browser target deployment

The unlock file becomes five fields:

```json
{
  "api_url": "https://api.example.com",
  "firebase_email": "owner@example.com",
  "firebase_password": "owner password",
  "firebase_api_key": "Firebase web API key",
  "user_root_key": "base64 owner root key"
}
```

Remove `rqlite_admin_username`, `rqlite_admin_password`, and `rqlite_db_url`.
The encrypted credential payload supplies `vault_id`, `owner_pk`, and
`db_prefix`; there is no `db_path`.

Replace the operator/rqlite and whole-database store with:

- Firebase sign-in and ID-token refresh;
- authenticated `/v1/keys` bootstrap and local owner-key unwrap/binding checks;
- a Fastly vault client that uses application routes and opaque `_etag`
  conflict replay, never a Cosmos SDK;
- an in-memory R2 session from `/v1/r2-token`;
- the R2 snapshot loader/publisher from [catalog.md](catalog.md); and
- existing immutable EPUB and sharing stores adapted to the new binding.

Send the current Firebase ID token on each owner route. On a 401, refresh it and
retry at most one idempotent request. Keep Firebase tokens, R2 credentials,
ciphertext API bodies, and signed URLs out of service-worker caches and error
reports. There is no Cosmos client, credential, endpoint, or CORS configuration
in browser code.

The browser retains current reader behavior: EPUB rendering, mobile layout and
font defaults, visible-time qualification, throttled/final progress, bookmark
validation/cap, local full-text search, share management, and anonymous
read-only sharing.

## R2 and static UI configuration

Keep the R2 bucket private. Its CORS policy allows only exact `UI_ORIGIN` owner
and shared operations required by the browser. Preserve `Range`,
`Cache-Control`, conditional-write, and SigV4 request headers; expose `ETag`,
`Content-Length`, `Content-Range`, and `Accept-Ranges`. Wildcard origins remain
forbidden. Encrypted EPUB and snapshot responses use
`Content-Type: application/octet-stream`; credentialed reads use
`Cache-Control: private, no-store`.

Keep the static UI on Cloudflare Pages with its existing CSP and EPUB script
restrictions. Add only the Fastly API origin and R2 endpoint to `connect-src`.
Do not add the Cosmos endpoint. `UI_ORIGIN` must match Fastly API CORS and R2
CORS exactly.

## CLI target

Normal owner CLI commands sign in to Firebase and use the same Fastly routes as
the browser. They do not receive or store a Cosmos account key:

- `--init-owner` remains an explicit offline administration operation that
  creates the owner item and empty encrypted snapshot/head, then writes the new
  unlock file;
- `--ingest` uploads the immutable encrypted EPUB, constructs one VLE book
  record, and publishes through `/v1/vault/commit`;
- `--edit-epub` and `--replace-images` read/decrypt through Fastly, preserve
  immutable replacement semantics, and conditionally publish affected state;
- `--clean-bucket` derives live objects from fixed Fastly scans plus snapshot
  retention and performs a two-pass, safety-aged cleanup;
- `--update-cosmos` is an offline admin command for explicit idempotent schema
  migrations; and
- legacy `--update-rql` and `--update-db` exist only in rollback/migration
  builds, never the final operational path.

Bulk ingest still commits one book plus the head per API call. Do not expose a
bulk operation that lets a caller submit arbitrary Cosmos batches. The CLI may
upload one new snapshot for each committed book or use an explicit future
maintenance API whose fixed schema and atomicity are separately reviewed.

Only initialization, schema migration, backup/export, restore, and disaster
recovery use an account credential in an isolated admin environment. Never put
that credential in an owner credentials file or print it.

## Pre-cutover preparation

1. Pin exact browser, CLI, Fastly SDK/runtime, JWT library, SQLCipher-WASM, VLE,
   schema, compression, Cosmos API, and grant versions in the release manifest.
2. Provision and verify staging Cosmos, including RU use, account-key rotation,
   HMAC signing, transactional batches, 429 propagation, and route containment.
3. Deploy the Fastly target on a staging domain. Confirm Firebase token claim
   validation, unknown-`kid` refresh, exact CORS, cache bypass, secret lookup,
   and rejection of client `x-ms-*`/backend-selection input.
4. Run a dry migration from production-format backups into staging. Compare
   every book, bookmark, position, catalog field, share tuple/state, owner
   binding, and R2 reference.
5. Test existing anonymous share URLs against Fastly. Preserve
   `SHARE_GRANT_KEY`, share ID/path hashing, exact R2 paths, and grant decoding
   so distributed links continue to work.
6. Rehearse rollback and restore from Cosmos periodic backup and the independent
   encrypted export.

## Cutover migration

### 1. Freeze writes and capture sources

- Put the owner UI/CLI into maintenance mode before its next mutation.
- Keep anonymous reads on the old registry until registry cutover.
- Wait for in-flight owner writes to finish.
- Capture a native rqlite backup and schema/migration versions.
- Download the exact SQLCipher `db_path` object and record its R2 ETag, length,
  and ciphertext hash.
- Inventory owner EPUB/share paths and retain the old Northflank volume and
  `db_path` read-only for rollback.

If either source changes after capture, abort and restart. Do not merge an
unknown later whole-database write.

### 2. Transform owner control

The offline migrator reads the legacy owner record and unlock file. It preserves
the UMK, KEM, user handle, display name, `db_prefix`, wrapping algorithms,
share-grant key, and rate-limit key. Preserve legacy P-521/ticket material only
inside rollback backups; target protocol version 3 does not use it.

Generate new opaque `vault_id` and `owner_pk`, rename `db_master_key` to
`vault_master_key` without changing bytes, remove `db_path`, and re-encrypt the
version-2 credential payload. Compute `vault_binding_hash` from `vault_id`,
`owner_pk`, and `db_prefix`. Create the target owner item, but leave the
migration marker incomplete so Fastly target routes remain unavailable.

### 3. Transform SQLCipher rows

Open the captured SQLCipher database locally with its current key. Validate the
schema and constraints. For each `txt` row:

- preserve catalog, creation/last-access/last-CFI values, content key, prefix,
  and path;
- attach ordered bookmarks with uniqueness, optional page number, preview,
  creation time, and the 20-item cap;
- attach ordered shares with IDs, keys, paths, states, and creation time; and
- encode/encrypt one aggregate with its row-specific VLE context.

New installations use random book IDs. Migration derives retry-stable opaque
IDs as the first 128 bits of:

```text
HMAC-SHA-256(
  HKDF-SHA3-512(vault_master_key, info="txt:legacy-book-id:v1"),
  U64BE(legacy_txt_id)
)
```

Prefix base64url with `book_`, reject collisions, and place the legacy-to-target
map only in the encrypted report. Create items with `If-None-Match: *`. On retry,
decrypt and compare an existing semantic payload before accepting it; never
overwrite unexplained target data.

### 4. Build the initial snapshot

Build the sorted projection, compress/encrypt generation 1, upload it to a new
immutable catalog path, then create `catalog-head` with create-only semantics.
Verify hash, length, count, decryption, schema, and local search fixtures.

### 5. Transform server control state

- Import every rqlite share row, preserving hashes, state, and timestamps. Add
  one path reservation per row and fail on any collision/mismatch.
- Import unexpired rate-limit windows with counts/boundaries so cutover cannot
  reset abuse budgets. Expired windows may be omitted.
- Create target schema markers and an incomplete encrypted migration report with
  source hashes/ETags, item counts, generation, and opaque errors.

Switch anonymous share traffic only after imported active/deleting counts and a
sample of existing grants validate.

### 6. Validate and commit cutover

The migrator must report equality for:

- owner UID and all retained wrapped/public key byte lengths and hashes;
- one target book per legacy `txt` row;
- every catalog field and timestamp/null value;
- every content key/prefix/path and referenced owner EPUB;
- every bookmark CFI/page/preview/time and per-book count;
- every share ID/key/prefix/path/state/time and shared R2 object;
- server share hashes and states;
- initial snapshot count/hash and projection equality; and
- authentication of every VLE record with its exact context.

Run feature-parity smoke tests, conditionally mark migration complete, activate
the version-3 Fastly service and browser together, then release maintenance.
Watch the first real `/v1/keys`, vault head/book reads, snapshot load, search,
mutation commit, R2 token, share copy/read/delete, and token refresh.

## Rollback

Rollback is allowed only while legacy rqlite and SQLCipher `db_path` remain an
intact, mutually consistent snapshot.

- Before any target owner write, switch DNS/UI to the captured legacy release.
- After target writes begin, automatic rollback would discard Cosmos-only
  changes. Freeze writes and run the explicit reverse migrator or obtain owner
  approval for identified loss; never silently use stale `db_path`.
- Existing immutable owner/share EPUB paths are shared across releases, so do
  not clean target or legacy orphans during the rollback window.
- Retain old service configuration and volume offline for a defined period,
  default 30 days. After a restore drill and owner acceptance, delete the old
  volume and `db_path` through the approved recoverable retention process and
  remove all rqlite/Northflank secrets.

## Backup and restore

Cosmos periodic backup is necessary but not sufficient. Record interval,
retention, and restore procedure; see Azure's
[periodic backup documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/periodic-backup-restore-introduction).

Fastly Compute has no scheduler and is not the backup runtime. Use an isolated,
scheduled administration job that:

1. reads all four containers with the admin account credential at a recorded
   consistency boundary;
2. exports canonical item JSON including IDs, partitions, diagnostic `_etag`
   values, and schema versions;
3. Brotli-compresses and VLE-encrypts with an independent 256-byte
   `COSMOS_EXPORT_KEY` held in that job's secret manager and offline escrow;
4. uploads immutably under the administrative export prefix; and
5. writes/verifies a signed manifest with counts, hashes, timestamp, and
   software/schema versions.

The export key is independent from owner keys, Cosmos keys, and API HMAC keys.
Apply retention only after restore drills. A restore targets a new
database/account first, validates containers, records, and snapshot references,
then updates the Fastly Config/Secret Store links. Never restore control items
into `vault` or expose Cosmos credentials to a browser.

## Monitoring and alerts

Collect redacted metrics by Fastly route and configured container:

- request count, latency, status, Cosmos RU, 429/retry/conflict counts;
- Firebase verification and unknown-`kid` refresh failures, never token values;
- Cosmos signing/backend/TLS failures, never signatures or account keys;
- R2 snapshot bytes, load/build latency, publication failures, orphan count,
  and cleanup candidates;
- rate-limit decisions, share transitions, and anonymous URL exchanges with
  nonreversible labels;
- backup/export age, item/object counts, restore-test date, migration schema;
  and
- Cosmos storage and logical-partition size.

Alert on attempted generic/client-selected Cosmos access, repeated owner/binding
failures, unexpected account-key use, snapshot pointer/object mismatch,
persistent 429s, stale backups, or control/data schema mismatch.

## Key and secret rotation

- Rotate Cosmos primary/secondary keys by adding the inactive key to Fastly
  Secret Store, activating/testing a Compute version that uses it, then
  regenerating the old key. Never expose either key to a browser.
- Secret Store updates can affect the active service; use named/versioned secret
  entries and an explicit deploy/smoke-test sequence rather than overwriting the
  only working value without rollback.
- Rotate R2 broker credentials using overlap; minted 15-minute sessions expire.
- Rotating `RATE_LIMIT_KEY` makes old subject buckets unreachable; perform a
  bounded migration or conservative reset during maintenance.
- Rotating `SHARE_GRANT_KEY` invalidates distributed links unless a versioned
  read keyring remains. Issue new grants with the current key while retaining
  intended legacy validation keys.
- Rotating `vault_master_key` requires authenticated re-encryption of every book
  and retained snapshot under maintenance; never treat it as incidental schema
  migration.

## Release gate

Do not remove rqlite, Northflank, or legacy `db_path` until all checks pass:

- VLE row/snapshot, Firebase claim/JWKS, Cosmos HMAC-signature, and share-grant
  test vectors;
- ciphertext tamper, row splice, wrong partition/ID/kind/version, wrong owner,
  and snapshot relocation fail authentication;
- no browser bundle/response contains Cosmos credentials or endpoint details;
- every vault/control route fixes its container, partition, resource link,
  method, and query; injected `x-ms-*` and backend-selection inputs are rejected;
- every owner/session rate limit is atomic across Fastly POPs and instances;
- private API responses bypass cache and carry the required no-store policy;
- initial snapshot is one R2 GET on cache miss and local search matches current
  results;
- ingest/edit/delete, reader progress, bookmarks, and conflict replay match
  current semantics;
- sharing and crash recovery pass [sharing.md](sharing.md), including current
  production-format links;
- failed R2 upload never advances the head, failed Cosmos batch leaves only an
  orphan, and repair rebuilds from authenticated rows through the fixed scan;
- CLI migration is idempotent and a second run changes no semantics;
- backup/export restore succeeds into a clean account; and
- staging RU/storage/latency and Fastly limits fit the operating budget.
