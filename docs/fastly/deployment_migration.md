# Deployment, migration, and operations

This migration replaces two persistence mechanisms and the API runtime at once.
Use a scheduled owner-write maintenance window and a reversible cutover. Do not
attempt unversioned dual writes between a whole SQLCipher database object and
encrypted KV Store entries.

## Provision KV Store

Before applying infrastructure, recheck Fastly's current KV Store limits and
package entitlements against
[the edge data storage product page](https://docs.fastly.com/products/edge-data-storage)
and [the compute resource limits page](https://docs.fastly.com/products/compute-resource-limits).
Create four KV Stores matching [data_model.md](data_model.md):

1. `owner_control`;
2. `share_control`;
3. `rate_limit_control`; and
4. `vault`.

Confirm the account's package tier includes at least four KV Stores and enough
combined storage and Class A/B operation headroom for the capacity target in
[README.md](README.md#capacity-target) before creating them. Link all four to
the Compute service as resources; a Compute service reads and writes a linked
KV Store through its native binding, with no separate network endpoint,
region choice, or firewall allowlist to configure.

Do not create a browser-facing KV Store credential or expose a store's name
to client code. Verify in staging that no UI response or asset contains a KV
Store name or an enumerated key.

## Fastly Compute target deployment

Create a JavaScript or Rust Fastly Compute service implementing
[auth_api.md](auth_api.md). Configure:

- the exact public API domain with TLS;
- the four KV Store resource links described above;
- a static Firebase certificate backend and R2 control/data backends as needed;
- a linked Config Store for nonsecret IDs, origins, route limits, API versions,
  and backend names, with desired values tracked in deployment configuration;
- a linked Secret Store for R2 credentials, the share-grant key, and the
  rate-limit key — there is no KV Store account key to store, since KV Store
  access needs no secret;
- no cache lookup/storage for `/v1/*` and health responses; and
- redacted structured logging that never records request/response bodies or
  credential-bearing headers.

Remove the rqlite process, OpenResty Lua API, operator proxy, Northflank
service, persistent volume, and native rqlite backup job only after rollback
retention. Fastly is request-driven and stateless; durable rate limits and
share state live in KV Store, not Compute memory.

Pin the Fastly SDK/runtime and compatible JWT implementation. Test Firebase key
rotation/unknown-`kid` behavior, KV Store conditional-write and create-only
behavior under concurrent requests, response size limits, and secret-read
failures in both the local Compute server and a staging Fastly service. The
local server is not a perfect simulation of production edge routing and does
not reproduce cross-point-of-presence KV Store propagation delay, so
production-like staging is a release requirement — see the write-time
consistency assumption in [architecture.md](architecture.md).

Readiness performs only fixed schema-marker reads. It validates supported
schema markers across all four KV Stores. An absent or mismatched owner entry
remains unready; web startup never initializes owner keys.

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
- a Fastly vault client that uses application routes and opaque `generation`
  conflict replay, never a KV Store SDK;
- an in-memory R2 session from `/v1/r2-token`, used only for EPUB, catalog
  snapshot, and export objects;
- the R2 snapshot loader/publisher and the KV-backed reading-state/reading-
  index client from [catalog.md](catalog.md); and
- existing immutable EPUB and sharing stores adapted to the new binding.

Send the current Firebase ID token on each owner route. On a 401, refresh it and
retry at most one idempotent request. Keep Firebase tokens, R2 credentials,
ciphertext API bodies, and signed URLs out of service-worker caches and error
reports. There is no KV Store client, credential, endpoint, or CORS
configuration in browser code.

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
`UI_ORIGIN` must match Fastly API CORS and R2 CORS exactly.

## CLI target

Normal owner CLI commands sign in to Firebase and use the same Fastly routes as
the browser. They do not receive or store any KV Store binding or credential:

- `--init-owner` remains an explicit offline administration operation that
  creates the owner entry and empty encrypted snapshot/head, then writes the
  new unlock file;
- `--ingest` uploads the immutable encrypted EPUB, constructs the merged
  canonical authenticated-blob book entry and an initially empty reading-state
  entry, and publishes the book/head write through `/v1/vault/commit`;
- `--edit-epub` and `--replace-images` read/decrypt through Fastly, preserve
  immutable replacement semantics, and conditionally publish affected state;
- `--clean-bucket` derives live objects from fixed Fastly scans plus snapshot
  retention and performs a two-pass, safety-aged cleanup of both R2 objects
  and orphaned KV Store reading entries;
- `--update-kv` is an offline admin command for explicit idempotent schema
  migrations; and
- legacy `--update-rql` and `--update-db` exist only in rollback/migration
  builds, never the final operational path.

Bulk ingest still commits one book plus the head per API call. Do not expose a
bulk operation that lets a caller submit arbitrary KV Store writes. The CLI
may upload one new snapshot for each committed book or use an explicit future
maintenance API whose fixed schema and atomicity are separately reviewed.

Only initialization, schema migration, backup/export, restore, and disaster
recovery run in an isolated admin environment with broader access. Never put
that access in an owner credentials file or print it.

## Pre-cutover preparation

1. Pin exact browser, CLI, Fastly SDK/runtime, JWT library, canonical crypto
   blob, schema, compression, possession-proof, and grant versions in the
   release manifest.
2. Provision and verify staging KV Stores, including Class A/B operation
   counts, create-only and conditional-write behavior under concurrent
   requests from different points of presence, and route containment.
3. Deploy the Fastly target on a staging domain. Confirm Firebase token claim
   validation, unknown-`kid` refresh, exact CORS, cache bypass, secret lookup,
   and rejection of any client-supplied store/key selection.
4. Run a dry migration from production-format backups into staging. Compare
   every book, bookmark, position, catalog field, share tuple/state, owner
   binding, and R2 reference.
5. Test existing anonymous share URLs against Fastly. Preserve
   `SHARE_GRANT_KEY`, share ID/path hashing, exact R2 paths, and grant decoding
   so distributed links continue to work.
6. Rehearse restore from the scheduled administrative export described below.

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

The offline migrator reads the legacy owner record and unlock file. It
preserves the UMK, KEM, P-521 signing keypair, user handle, display name,
`db_prefix`, wrapping algorithms, share-grant key, and rate-limit key. Preserve
the legacy signed-ticket protocol only inside rollback backups; this design's
protocol replaces the ticket with the per-request possession proof in
[cryptography.md](cryptography.md), reusing the same P-521 keypair and
public-key-verification model, just with a different canonical message and no
session ticket.

Generate a new opaque `vault_id` and `owner_pk`, and a fresh random 128-byte
`vault_master_key` — it replaces the legacy 256-byte `db_master_key`
entirely rather than reusing its bytes, since every row is already being
re-encrypted into the canonical blob format in the next step regardless, and
`vault_master_key` no longer needs to satisfy SQLCipher's raw-key length
rule. Rename `wrapped_umk` to `wrapped_user_master_key` without changing its
bytes, remove `db_path`, and re-encrypt the credential payload. Keep
`sign_public_key`/`wrapped_sign_private_key` under the same field names —
only their protocol usage changes, not their storage shape.
Compute `vault_binding_hash` from `vault_id`, `owner_pk`, and `db_prefix`.
Create the target `owner` entry, but leave the migration marker incomplete so
Fastly target routes remain unavailable.

### 3. Transform SQLCipher rows

Open the captured SQLCipher database locally with its current key. Validate the
schema and constraints. For each `txt` row, produce two target objects:

- a merged `book:{book_id}` entry: content key, prefix, path, catalog fields,
  and ordered shares with IDs, keys, paths, states, and creation time; and
- a `reading:{book_id}` entry: creation/last-access/last-CFI values and ordered
  bookmarks with uniqueness, optional page number, preview, creation time, and
  the 20-item cap.

Wrap each with its authenticated application identity fields and Encrypt it
using the canonical structured-payload blob from
[docs/crypto.md](../crypto.md), with the corresponding envelope from
[cryptography.md](cryptography.md). Build the initial reading index (§4) from
every migrated reading-state entry in the same pass.

New installations use random book IDs. Migration derives retry-stable opaque
IDs from the full 256-bit output of:

```text
HMAC-SHA-256(
  HKDF-SHA3-512(vault_master_key, info="txt:legacy-book-id:v1"),
  U64BE(legacy_txt_id)
)
```

Prefix base64url with `book_`, reject collisions, and place the legacy-to-
target map only in the encrypted report. Create entries with a create-only
write. On retry, decrypt and compare an existing semantic payload before
accepting it; never overwrite unexplained target data.

### 4. Build the initial snapshot and reading index

Build the sorted projection (catalog fields and shares from each book entry),
compress/encrypt generation 1, upload it to a new immutable random catalog
path, wrap that path with the catalog-head pointer envelope, then create
`catalog-head` with a create-only write. Verify decryption, schema, book
count against the projection's own `books` array, and local search fixtures.

Separately, build and write the initial reading index from every migrated
reading-state entry with a create-only write. Verify only its own decryption,
schema, and that every `book_id` it references exists in the snapshot just
published.

### 5. Transform server control state

- Import every rqlite share row, preserving hashes, state, and timestamps, and
  set each target share entry's plaintext `book_id` from the target `book_id`
  its source row belongs to. Create one path reservation per row before its
  share entry, and fail on any collision/mismatch.
- Import unexpired rate-limit windows with counts/boundaries so cutover cannot
  reset abuse budgets. Expired windows may be omitted.
- Create target schema markers and an incomplete encrypted migration report
  with source hashes/ETags, entry counts, generation, and opaque errors.

Switch anonymous share traffic only after imported active/deleting counts and a
sample of existing grants validate.

### 6. Validate and commit cutover

The migrator must report equality for:

- owner UID and all retained wrapped/public key byte lengths and hashes,
  including the P-521 signing keypair now used for the possession proof
  instead of the removed ticket;
- one target `book` entry and one paired `reading` entry per legacy `txt` row;
- every catalog field and timestamp/null value, in the `book` entry and the
  published snapshot;
- every content key/prefix/path and referenced owner EPUB, in the `book`
  entry;
- every bookmark CFI/page/preview/time and per-book count, and every
  last-access/last-CFI value, in the migrated reading entry and the published
  reading index;
- every share ID/key/prefix/path/state/time and shared R2 object, in the
  `book` entry;
- server share hashes, states, and `book_id` back-references;
- initial snapshot and reading-index count/hash and projection equality; and
- authentication of every canonical blob and agreement between each inner
  envelope and its outer entry's key and kind.

Run feature-parity smoke tests, conditionally mark migration complete, activate
the target Fastly service and browser together, then release maintenance.
Watch the first real `/v1/keys`, vault head/book/reading reads, snapshot load,
search, mutation commit, R2 token, share copy/read/delete, and token refresh.

## Rollback

Rollback is allowed only while legacy rqlite and SQLCipher `db_path` remain an
intact, mutually consistent snapshot.

- Before any target owner write, switch DNS/UI to the captured legacy release.
- After target writes begin, automatic rollback would discard KV-Store-only
  changes. Freeze writes and run the explicit reverse migrator or obtain owner
  approval for identified loss; never silently use stale `db_path`.
- Existing immutable owner/share EPUB paths are shared across releases, so do
  not clean target or legacy orphans during the rollback window.
- Retain old service configuration and volume offline for a defined period,
  default 30 days. After a restore drill and owner acceptance, delete the old
  volume and `db_path` through the approved recoverable retention process and
  remove all rqlite/Northflank secrets.

## Backup and restore

Fastly KV Store has no built-in periodic backup/restore feature. The
scheduled administrative export described here is this design's only backup
mechanism, not a supplement to a platform-provided one. Use an isolated,
scheduled administration job that:

1. lists and reads all four KV Stores with broader administrative access at a
   recorded point in time;
2. exports canonical entry JSON including keys, diagnostic `generation`
   values, and schema versions;
3. Encrypts the structured export with the canonical blob procedure and an
   independent 256-byte `EXPORT_KEY` held in that job's secret manager and
   offline escrow;
4. uploads immutably under the administrative export prefix; and
5. writes/verifies a signed manifest with counts, hashes, timestamp, and
   software/schema versions.

The export key is independent from owner keys and API HMAC keys. Run this job
on a schedule tight enough that a restore's data loss window is acceptable —
record the interval and retention explicitly, since there is no other backup
to fall back on. Apply retention only after restore drills. A restore targets
a new set of KV Stores first, validates entries and snapshot references, then
updates the Fastly Config/Secret Store links and KV Store resource bindings.
Never restore control entries into `vault` or expose a KV Store binding to a
browser.

## Monitoring and alerts

Collect redacted metrics by Fastly route and KV Store:

- request count, latency, status, and conflict counts;
- KV Store Class A and Class B operation counts by route, checked against the
  budget in [README.md](README.md#capacity-target);
- Firebase verification and unknown-`kid` refresh failures, never token
  values;
- KV Store binding/backend failures, never credentials;
- R2 snapshot bytes, load/build latency, publication failures, orphan count,
  and cleanup candidates;
- rate-limit decisions (durable and best-effort), share transitions, and
  anonymous URL exchanges with nonreversible labels;
- backup/export age, entry/object counts, restore-test date, migration schema;
  and
- KV Store storage size against its allowance, per store.

Alert on attempted generic/client-selected store or key access, repeated
owner/binding failures, an unexpected volume of `SetKey` calls from a route
that should be read-only, snapshot pointer/object mismatch, sustained
throttling, stale backups, or control/data schema mismatch.

## Key and secret rotation

- There is no KV Store account key or signing secret to rotate — KV Store
  access needs no secret at all.
- Rotate R2 broker credentials using overlap; minted 15-minute sessions
  expire.
- Rotating `RATE_LIMIT_KEY` makes old subject buckets unreachable; perform a
  bounded migration or conservative reset during maintenance.
- Rotating `SHARE_GRANT_KEY` invalidates distributed links unless a versioned
  read keyring remains. Issue new grants with the current key while retaining
  intended legacy validation keys.
- Rotating `vault_master_key` requires authenticated re-encryption of every
  book, reading, and retained snapshot entry/object under maintenance; never
  treat it as incidental schema migration.

## Release gate

Do not remove rqlite, Northflank, or legacy `db_path` until all checks pass:

- canonical blob and record/snapshot/reading-index envelope, Firebase
  claim/JWKS, possession-proof, and share-grant test vectors, all generating
  identifiers/nonces with at least 256 bits of entropy;
- ciphertext tamper fails AEAD authentication; entry splice, wrong key/kind/
  version, wrong owner, mismatched reading-state `book_id`, and snapshot
  relocation fail strict inner-envelope validation;
- no browser bundle/response contains a KV Store binding, name, or key;
- every vault/control route fixes its store, key, method, and allowed
  operation; a client-supplied store/key selection is rejected; every route
  whose abuse is not self-contained rejects a missing, expired, wrong-route,
  or replayed possession proof even with a valid Firebase token;
- every durable rate limit is atomic across Fastly POPs and instances, and the
  owner-subject-keyed limiter only ever consumes on a verified Firebase
  subject, never an unverified claim; the two best-effort, in-instance limits
  are documented as approximate in the deployed configuration, not silently
  assumed durable;
- private API responses bypass cache and carry the required no-store policy;
- initial load is one R2 GET for the snapshot and one KV Store read for the
  reading index on cache miss, and local search and recency ordering match
  current results;
- ingest/edit/delete, reader progress, bookmarks, and conflict replay match
  current semantics, including that a reading-position update touches neither
  a book's merged entry nor `catalog-head`;
- content replacement is verified as the documented two-commit
  delete-then-create sequence, and a simulated crash between the two commits
  leaves the library in a reviewed, non-corrupting state;
- sharing and crash recovery pass [sharing.md](sharing.md), including current
  production-format links;
- failed R2 upload never advances the head; a `/v1/vault/commit` whose head
  object fails Fastly's R2 existence check is rejected before any KV Store
  write; a book-write-then-head-write failure after a successful
  upload leaves only an orphan; and repair rebuilds the snapshot and,
  independently, the reading index from authenticated entries through the
  fixed scan;
- CLI migration is idempotent and a second run changes no semantics;
- backup/export restore succeeds into a clean set of KV Stores; and
- staging Class A/B operation counts, storage, latency, and Fastly limits fit
  the operating budget, with the highest-volume routes' actual measured KV
  Store write rate matching the estimate in
  [README.md](README.md#capacity-target).
