# Deployment, migration, and operations

This migration replaces two persistence mechanisms at once. Use a scheduled
owner-write maintenance window and a reversible cutover. Do not attempt
unversioned dual writes between a whole SQLCipher database object and encrypted
Cosmos rows.

## Provision Cosmos DB

Before applying infrastructure, recheck Azure's current free-tier and service
limits. The intended account configuration is:

- Azure Cosmos DB for NoSQL;
- free tier enabled when the account is created;
- one write region near the Northflank service and owner;
- provisioned throughput, not serverless;
- 1,000 RU/s manual throughput on the database, shared by all containers;
- Session consistency;
- periodic backup enabled and explicitly configured/recorded;
- local/key authentication enabled because native resource tokens depend on it;
- TLS only and the exact Cloudflare Pages production origin in Cosmos CORS; and
- public data-plane connectivity because the owner browser connects directly.

Direct browser access means an account firewall cannot allow only Northflank's
egress addresses. Authorization rests on TLS plus a short, partition-scoped
resource token. If that public endpoint is unacceptable, stop and route owner
data through Northflank instead; do not quietly expose control containers or
embed the account key.

Create the database and these four containers exactly as specified in
[data_model.md](data_model.md):

1. `owner_control`, partition `/owner_pk`, no default TTL;
2. `share_control`, partition `/registry_pk`, no default TTL;
3. `rate_limit_control`, partition `/bucket_pk`, default TTL enabled; and
4. `vault`, partition `/owner_pk`, no default TTL.

Apply the minimal indexing policies before importing data; policy
transformations after import consume RUs. Do not configure a Cosmos unique-key
policy for mutable share mappings—the same-partition reservation documents and
transactional batches provide the required uniqueness.

Create one Cosmos native user, `owner-browser`, under the database. Create only
one permission beneath it:

```text
id:                    owner-vault-all
permission mode:       All
resource:              vault container self-link
resourcePartitionKey: [OWNER_PK]
```

Do not create permissions for `owner_control`, `share_control`, or
`rate_limit_control`. From Northflank, request permission tokens with a
900-second expiry. Verify with an integration test that the resulting token can
point-read/write the owner vault partition and receives 401/403 for a different
partition and every control container. Permission-definition fields, including
partition scoping, are documented in Azure's
[JavaScript SDK reference](https://learn.microsoft.com/en-us/javascript/api/@azure/cosmos/permissiondefinition?view=azure-node-latest).

## Northflank target deployment

Keep the existing always-on 0.2 shared-vCPU/512 MiB service, domain, Firebase
validation, anonymous share routes, R2 integration, and secret management as
the initial target. Change its runtime as follows:

- remove the rqlite binary/process, Raft/HTTP ports, loopback supervisor,
  readiness dependency, and operator proxy;
- remove the persistent volume and rqlite native backup job after rollback
  retention expires;
- add Cosmos HTTPS client support with bounded connection, request, and retry
  timeouts;
- implement the server-only Cosmos stores, permission-token broker, and
  version-3 proof verifier from [auth_api.md](auth_api.md);
- preserve grant/ticket/rate secrets and share URL behavior;
- keep preliminary in-worker throttling, with Cosmos as the durable authority;
  and
- run at least one always-on instance. The service is stateless and may scale
  horizontally once durable limiter and replay tests pass.

Configure the new Cosmos secrets listed in [auth_api.md](auth_api.md). Mount no
unlock file and no owner root/master/content/share key on Northflank.

Readiness performs only server-credential point reads. It validates supported
schema markers and confirms all configured containers have the expected
partition-key path. A deployment with an absent/mismatched owner item remains
unready; do not auto-initialize owner keys at web-service startup.

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
The credential payload supplies `vault_id`, `owner_pk`, and `db_prefix`; there
is no `db_path`.

Replace the operator/rqlite and whole-database store with:

- the authenticated `/v1/keys` bootstrap client;
- local owner-key unwrap and version-3 binding/proof;
- an in-memory short Cosmos/R2 session from `/v1/data-token`;
- a Cosmos vault record store with `_etag` semantic replay;
- the R2 snapshot loader/publisher from [catalog.md](catalog.md); and
- the existing immutable EPUB and sharing stores adapted to the new binding.

Never persist the Cosmos/R2 session response. Configure the Cosmos SDK/client
to target the one expected endpoint/database/container/partition and reject a
server response that substitutes any of them. Keep credentials out of service
worker caches and error reports.

The browser still provides all current reader behavior: EPUB rendering, mobile
layout and font defaults, visible-time qualification, throttled/final progress,
bookmark validation/cap, local full-text search, share management, and
anonymous read-only sharing.

## R2 and static UI configuration

Keep the R2 bucket private. Its CORS policy allows only the exact `UI_ORIGIN`
for owner/shared GET and owner PUT operations. Preserve `Range`,
`Cache-Control`, conditional-write, and browser SigV4 request headers; expose
`ETag`, `Content-Length`, `Content-Range`, and `Accept-Ranges`. Wildcard origins
remain forbidden. Encrypted EPUB and snapshot responses use
`Content-Type: application/octet-stream`; shared responses and credentialed
snapshot reads use `Cache-Control: private, no-store`.

Keep the static UI on Cloudflare Pages with its current CSP and EPUB script
restrictions. Add the Cosmos endpoint to `connect-src` only; never relax frame,
script, object, or origin restrictions to make the SDK work. The Pages origin
must match both Northflank, R2, and Cosmos CORS configuration exactly.

## CLI target

The administration CLI uses the Cosmos account credential only in an explicit
admin environment. It must not print that credential or plaintext owner data.
After migration:

- `--init-owner` creates the versioned server-only owner item, empty encrypted
  snapshot/head, browser user/partition permission, and new unlock file;
- `--ingest` uploads the immutable encrypted EPUB, creates one VLE book record,
  and publishes the snapshot with the same conditional protocol as the UI;
- `--edit-epub` and `--replace-images` point-read/decrypt the book record, keep
  immutable replacement semantics, and conditionally publish affected state;
- `--clean-bucket` derives live objects from vault/control state plus snapshot
  retention and performs a two-pass, safety-aged cleanup;
- `--update-cosmos` replaces `--update-rql` and applies explicit idempotent
  control/data schema migrations; and
- legacy `--update-db` exists only in the rollback/migration build, never in the
  final operational path.

CLI bulk ingest batches up to 99 book operations plus one `catalog-head`
operation only when total Cosmos transactional-batch size remains safely below
the platform limit. Otherwise it publishes books individually. It uploads one
final snapshot after the bulk set and uses a maintenance lock so the UI cannot
write a head concurrently.

## Pre-cutover preparation

1. Pin exact browser, CLI, Northflank, SQLCipher-WASM, VLE, schema, compression,
   ticket, proof, and grant versions in the release manifest.
2. Provision and verify Cosmos in staging, including measured RU consumption,
   CORS, resource-token scope/expiry, 429 backoff, and control denial.
3. Deploy Northflank in migration-compatible mode. It can read legacy rqlite
   only for the migration/rollback route; no browser gets a Cosmos token until
   `migration:sqlcipher-to-cosmos:v1` is complete.
4. Run a dry migration from production-format backups into staging. Compare
   every book, bookmark, reading position, catalog field, share tuple/state,
   owner binding, and R2 reference.
5. Test old anonymous share URLs against the new gateway. Preserve the existing
   `SHARE_GRANT_KEY`, share ID/path SHA-256 definitions, exact shared R2 paths,
   and grant decoding so already distributed links keep working.
6. Rehearse rollback and restore from both Cosmos periodic backup and the
   independent encrypted export.

## Cutover migration

### 1. Freeze writes and capture sources

- Put the owner UI/CLI into maintenance mode before its next mutation.
- Keep anonymous share reads available against the old registry until the
  registry cutover step.
- Wait for in-flight owner writes to finish.
- Capture a native rqlite backup and its schema/migration versions.
- Download the exact SQLCipher `db_path` object and record its R2 ETag, length,
  and ciphertext hash.
- Inventory owner EPUB/share paths and retain the old Northflank volume and
  `db_path` read-only for rollback.

If either source changes after capture, abort and restart the maintenance
window. Do not merge an unknown later whole-database write.

### 2. Transform owner control

The offline migrator reads the legacy owner control row and unlock file. It
preserves the UMK, KEM, P-521, user handle, display name, `db_prefix`, all
wrapping algorithms, and server ticket/share secrets. It generates a new
opaque `vault_id` and `owner_pk`, renames `db_master_key` to
`vault_master_key` without changing bytes, removes `db_path`, and re-encrypts
the version-2 credential payload.

Compute the new `vault_binding_hash` from `vault_id`, `owner_pk`, and
`db_prefix`. Write the target owner item with create-only semantics, but leave
the migration marker incomplete so Northflank cannot issue target tokens.

### 3. Transform SQLCipher rows

Open the captured SQLCipher database locally with its existing key. Validate
the schema and every constraint before transformation. For each `txt` row:

- preserve catalog, created/last-accessed/last-CFI values, 128-byte content key,
  content prefix, and content path;
- attach its ordered `txt_bookmarks`, preserving uniqueness, optional page
  number, preview bytes, created time, and 20-item cap;
- attach its ordered `txt_shares`, preserving raw IDs, keys, paths, state, and
  created time; and
- encode/encrypt one target aggregate with row-specific VLE context.

New installations use random book IDs. For migration, derive stable opaque IDs
as the first 128 bits of:

```text
HMAC-SHA-256(
  HKDF-SHA3-512(vault_master_key, info="txt:legacy-book-id:v1"),
  U64BE(legacy_txt_id)
)
```

Prefix the base64url result with `book_`, reject any collision, and include the
legacy-to-target map only in the encrypted migration report. This keeps retry
idempotency without exposing sequential SQL IDs.

Create target book items with `If-None-Match: *`. On a retry, decrypt and
byte-for-byte compare an existing target semantic payload before accepting it;
never overwrite unexplained target data.

### 4. Build the initial snapshot

Build the sorted JSON projection from all transformed rows, compress/encrypt it
with generation 1, upload it to a new immutable catalog path, then create
`catalog-head` with `If-None-Match: *`. Verify hash, length, count, decrypt,
schema, and a local full-text search over known catalog fixtures.

### 5. Transform server control state

- Import every current rqlite share row, preserving SHA-256 share/path hashes,
  state, and timestamps. Add a path-reservation item for each row and fail the
  migration on any collision or mismatch.
- Import all unexpired rate-limit windows with their existing counts and
  boundaries so cutover cannot reset an abuse budget. Expired windows may be
  omitted.
- Create target schema markers and an incomplete migration report containing
  source hashes/ETags, item counts, target generation, and opaque error details.

Switch anonymous share requests to the Cosmos registry only after imported
active/deleting counts and a sample of existing grants validate.

### 6. Validate and commit cutover

The migrator must report equality for:

- owner UID and all wrapped/public key byte lengths and hashes;
- one target book per legacy `txt` row;
- every catalog field and timestamp/null value;
- every content key/prefix/path and referenced owner EPUB object;
- every bookmark CFI/page/preview/time and per-book count;
- every share ID/key/prefix/path/state/time and shared R2 object;
- server share ID/path hashes and states;
- initial snapshot count/hash and projection equality; and
- decrypt/authentication of every VLE record with its expected context.

Run feature-parity smoke tests, mark the migration complete with an `_etag`
condition, deploy the version-3 browser and Northflank routes together, then
release maintenance mode. Watch the first real `/v1/keys`, proof, resource-token
scope, snapshot load, search, reader progress, bookmark mutation, share copy,
anonymous read, and share deletion.

## Rollback

Rollback is allowed only while the legacy rqlite volume/database and SQLCipher
`db_path` remain an intact, mutually consistent snapshot.

- Before any target owner write, rollback may switch the gateway/UI directly
  to the captured legacy release.
- After target writes begin, an automatic rollback would discard Cosmos-only
  changes. Freeze writes and run the explicit reverse migrator or obtain owner
  approval for the identified loss; never silently point the old UI at the
  stale `db_path`.
- Existing immutable owner/share EPUB paths are shared across releases, so do
  not clean either target or legacy orphans during the rollback window.
- Keep old credentials/routes disabled but recoverable for a defined retention
  period, default 30 days. After a verified restore drill and owner acceptance,
  delete the old volume and `db_path` through a recoverable retention process
  and remove all rqlite secrets.

## Backup and restore

Cosmos periodic backup is necessary but not sufficient. Record the configured
interval/retention and restoration process; Azure documents the behavior and
limitations in [periodic backup and restore](https://learn.microsoft.com/en-us/azure/cosmos-db/periodic-backup-restore-introduction).

Run a scheduled Northflank job that:

1. reads all four containers through the server account credential at a
   recorded consistency boundary;
2. exports canonical item JSON including IDs, partition values, `_etag`-useful
   diagnostics, and schema versions (but no active permission/resource token);
3. Brotli-compresses and VLE-encrypts the export with a dedicated 256-byte
   `COSMOS_EXPORT_KEY` held in Northflank secret storage and offline escrow;
4. uploads it immutably under the configured administrative export prefix; and
5. writes/verifies a signed manifest with counts, hashes, source timestamp, and
   software/schema versions.

The export key is independent from owner keys, Cosmos account keys, and all API
HMAC keys. Apply R2 lifecycle retention only after successful restore drills.
Vault row ciphertext and snapshot objects remain end-to-end encrypted even
inside the outer administrative export.

A restore goes to a new database/account first, validates all container/record
invariants and snapshot references, recreates the native browser permission,
then switches Northflank configuration. Never restore control containers into
`vault` or grant the browser permission before validation completes.

## Monitoring and alerts

Collect redacted metrics by endpoint/container, not owner content:

- request count, latency, status, Cosmos RU charge, 429 rate, retry count, and
  conditional conflict count;
- resource-token mint failures and expiry, never the token value;
- R2 snapshot bytes, load/build latency, publication failures, orphan count,
  and cleanup candidates;
- rate-limit decisions, proof replays, share state transitions, and public URL
  exchanges using nonreversible metric labels;
- backup/export age, item/object counts, restore-test date, and migration schema
  version; and
- Cosmos storage and owner logical-partition size.

Alert on any attempted client/control access, repeated binding/proof failures,
unexpected account-key use, snapshot head pointing to a missing/hash-mismatched
object, persistent 429s, backup age beyond objective, or control/data schema
mismatch.

## Key and secret rotation

- Rotate Cosmos primary/secondary account keys without exposing either to the
  browser. Update Northflank/admin clients and verify before regenerating the
  other key.
- Re-read/mint resource tokens after account-key rotation; wait out their
  maximum lifetime before treating the old key path as retired.
- Rotate R2 broker credentials using its overlap procedure; already minted
  15-minute sessions expire naturally.
- Rotating `R2_TICKET_SECRET` invalidates owner tickets and requires Firebase
  bootstrap again.
- Rotating `RATE_LIMIT_KEY` makes old subject buckets unreachable; perform an
  explicit bounded migration or conservative reset during maintenance.
- Rotating `SHARE_GRANT_KEY` would invalidate distributed links. Support a
  versioned read keyring and issue new grants with the current key until all
  intended legacy grants expire or are revoked.
- Rotating `vault_master_key` requires authenticated re-encryption of every book
  row and retained snapshot under a maintenance transaction plan; never do it
  as an incidental schema migration.

## Release gate

Do not remove rqlite or the legacy `db_path` until all checks pass:

- unit test vectors for VLE row/snapshot contexts and version-3 proof;
- ciphertext tamper, row splice, wrong partition/ID/kind/version, wrong owner,
  and snapshot-object relocation all fail authentication;
- client resource token cannot access control containers or another partition
  and expires at the configured time;
- every owner/session rate limit is atomic under concurrent Northflank workers;
- initial snapshot is one R2 GET on cache miss and local search matches current
  results;
- book ingest/edit/delete, visible-time progress, last-CFI throttle/final flush,
  bookmarks, and conflict replay match current semantics;
- share creation/copy/read/delete and crash recovery pass the matrix in
  [sharing.md](sharing.md), including existing production-format links;
- a failed R2 upload never advances the head, a failed Cosmos batch leaves only
  an orphan, and repair rebuilds from authenticated rows;
- CLI migration is idempotent and its second run makes no semantic changes;
- backup/export restore succeeds into a clean account; and
- staging RU/storage/latency measurements fit the free-tier budget with alert
  margin.
