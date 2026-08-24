# Deployment, migration, and operations

This migration replaces two persistence mechanisms and the API runtime at once.
Use a scheduled owner-write maintenance window and a reversible cutover. Do not
attempt unversioned dual writes between a whole SQLCipher database object and
encrypted KV Store entries.

## Provision KV Store

Before applying infrastructure, recheck Fastly's current free-tier KV Store
limits and entitlements against
[the edge data storage product page](https://docs.fastly.com/products/edge-data-storage)
and [the compute resource limits page](https://docs.fastly.com/products/compute-resource-limits).
Create four KV Stores matching [data_model.md](data_model.md):

1. `owner_control`;
2. `share_control`;
3. `rate_limit_control`; and
4. `vault`.

Confirm the free-tier account includes at least four KV Stores and enough
combined storage and Class A/B headroom for the capacity target in
[README.md](README.md#capacity-target) before creating them. If it does not,
stop and revise the deployment; do not merge trust roles or assume a paid
upgrade. Link all four to
the Compute service as resources; a Compute service reads and writes a linked
KV Store through its native binding, with no separate network endpoint,
region choice, or firewall allowlist to configure.

Do not create a browser-facing KV Store credential or expose a store's name
to client code. Verify in staging that no UI response or asset contains a KV
Store name or an enumerated key.

## Fastly Compute target deployment

Create a Rust Fastly Compute service implementing [auth_api.md](auth_api.md).
Configure:

- the exact public API domain with TLS;
- the four KV Store resource links described above;
- a static Firebase certificate backend and R2 control/data backends as needed;
- a linked Config Store for nonsecret IDs, origins, route limits, API versions,
  and backend names, with desired values tracked in deployment configuration;
- a linked Secret Store for R2 signing credentials, the share-grant key, and the
  rate-limit subject-hashing key — there is no KV Store account key to store,
  since KV Store
  access needs no secret;
- no cache lookup/storage for `/v1/*` and health responses; and
- redacted structured logging that never records request/response bodies or
  credential-bearing headers.

Remove the rqlite process, OpenResty Lua API, operator proxy, Northflank
service, persistent volume, and native rqlite backup job only after rollback
retention. Fastly is request-driven and stateless; durable admission slots and
share state live in KV Store, not Compute memory.

### Rust toolchain and cryptographic crates

Target `wasm32-wasip1` — the toolchain Fastly's Compute Rust SDK (the
`fastly` crate) requires as of Fastly CLI 11 and later; the older
`wasm32-wasi` target is deprecated. Pin the exact Rust toolchain, the `fastly`
crate version, and every crate below in the release manifest alongside the
other pinned versions this directory already requires.

Use only WASI-compatible Rust crates for cryptography — nothing that links a C
or assembly library (`ring`, OpenSSL, BoringSSL, `aws-lc-rs`), since those
either fail to cross-compile for `wasm32-wasip1` at all or require a
WASI-aware C toolchain this design has no other reason to carry. Host
WASI-Crypto acceleration is allowed because the crate has a functional pure-Rust
fallback. Fastly itself never holds `vault_master_key` and never decrypts
book, reading, reading-index, or catalog ciphertext, so it never needs
Ascon-Keccak AEAD, HKDF-SHA3-512, or the
ML-KEM-1024+X448 composite KEM — those run only in the browser and CLI, using
their own existing implementations, unaffected by this section. Fastly's own
cryptographic surface is narrower:

| Operation                                                    | Crate                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Firebase RS256 JWT verification                               | `jwt-simple = { version = "0.13", features = ["wasi-crypto"] }`; RS256 is RSA/SHA-256 and is unrelated to the P-521 proof key |
| Possession-proof ECDSA P-521 signature verification            | `p521` (RustCrypto) with its `ecdsa` feature, called directly — not through a JWT library, since the proof is a raw signature over a canonical byte string, not a JWT |
| `vault_binding_hash` recomputation (SHA-512)                   | `sha2` (RustCrypto)                                            |
| `share_id_hash`/`object_path_hash` computation (SHA-256)       | `sha2` (RustCrypto)                                            |
| Rate-limit subject hashing (HMAC-SHA-256 with `RATE_LIMIT_KEY`) | `hmac` + `sha2` (RustCrypto)                                    |
| Share-grant per-grant key derivation (HKDF-SHA-256)             | `hkdf` + `sha2` (RustCrypto)                                    |
| Share-grant encrypt/decrypt (XChaCha20-Poly1305)                | `chacha20poly1305`, `XChaCha20Poly1305` type (RustCrypto)       |
| Signing Fastly's own R2 API calls and exact-object presigned URLs | `aws-sigv4` — prefer this over a hand-rolled signer; the existing OpenResty gateway's own hand-rolled Lua SigV4 module has no test coverage and previously shipped a live canonical-request bug, a mistake not worth repeating here |

Fastly generates randomness for each admission-slot probe start and for the
fresh 32-byte salt and 24-byte nonce in each newly minted share grant
([cryptography.md](cryptography.md)); `getrandom` supports `wasm32-wasip1`
natively via the WASI `random_get` import, with no extra configuration.
Firebase and possession-proof verification themselves need no RNG.

Keep `wasi-crypto` enabled in every target build. The library documents that
it offloads RSA operations when the runtime exposes WASI-Crypto and otherwise
transparently falls back to its in-module implementation. Its published
WasmEdge RSA-2048 medians are context, not a Fastly latency promise:

| Operation | Pure Rust | WASI-Crypto | Published speedup |
| --------- | --------- | ----------- | ----------------- |
| Key generation | ~45–140 s | ~80 ms | ~1000x |
| Signing | ~2.2 s | ~21 ms | ~100x |
| Verification | ~240 ms | ~1.6 ms | ~150x |

This service only verifies Firebase signatures; it does not generate RSA keys
or sign with RSA. Benchmark valid and invalid RS256 verification in a deployed
Fastly staging service and set the request CPU budget from those results. A
successful build proves compatibility, not that the production host actually
provided the acceleration interface. See the upstream
[`jwt-simple` WASI-Crypto documentation](https://github.com/jedisct1/rust-jwt-simple#faster-and-safer-crypto-on-wasi-with-wasi-crypto).

Two caveats to track, not reasons to avoid these crates: the `rsa` crate used
by `jwt-simple`'s RS256 fallback carries an open,
unpatched RustSec advisory (Marvin Attack, RUSTSEC-2023-0071) — it is a
private-key timing leak during signing/decryption, and Fastly only ever
verifies with the public key, so the vulnerable code path is not exercised
here, but `cargo audit`/`cargo deny` will still flag it, so add an explicit,
documented allowlist entry rather than let it surface as a surprise CI
failure; and the RustCrypto AEAD/elliptic-curve crates (`ascon-aead` if the
browser/CLI side ever needs a Rust implementation, `p521`) are, as of this
writing, not independently security-audited — acceptable for a personal,
single-owner deployment, but worth revisiting if that ever changes.

Test Firebase key rotation/unknown-`kid` behavior, KV Store conditional-write
and create-only behavior under concurrent requests, response size limits, and
secret-read failures in both the local Compute server and a staging Fastly
service. The local server is not a perfect simulation of production edge
routing and does not reproduce cross-point-of-presence KV Store propagation
delay, so production-like staging is a release requirement — see the
write-time consistency assumption in [architecture.md](architecture.md).

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
- exact-method/object presigned URLs from `/v1/r2-url`, used only for EPUB,
  catalog-snapshot, and share-object GET/conditional-PUT operations;
- the R2 snapshot loader/publisher and the KV-backed reading-state/reading-
  index client from [catalog.md](catalog.md); and
- existing immutable EPUB and sharing stores adapted to the new binding.

Send the current Firebase ID token on each owner route. On a 401, refresh it and
retry at most one idempotent request. Keep Firebase tokens, ciphertext API
bodies, and presigned URLs out of service-worker caches and error
reports. There is no KV Store client, credential, endpoint, or CORS
configuration in browser code.

The browser retains current reader behavior: EPUB rendering, mobile layout and
font defaults, visible-time qualification, throttled/final progress, bookmark
validation/cap, local full-text search, share management, and anonymous
read-only sharing.

## R2 and static UI configuration

Keep the R2 bucket private. Its CORS policy allows only exact `UI_ORIGIN` GET
and PUT operations required by the browser; it does not allow browser DELETE.
Preserve `Range`, `Cache-Control`, `Content-MD5`, conditional-write, and SigV4
request headers; expose `ETag`,
`Content-Length`, `Content-Range`, `Accept-Ranges`, and
`x-amz-meta-txt-sha256`. Explicitly allow `Content-Type`, `Cache-Control`,
`Content-MD5`, `If-Match`, `If-None-Match`, and the signed checksum-metadata
header. Wildcard origins remain
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
  canonical authenticated-blob book entry with returned ETag/length/SHA-256,
  and publishes the book/head write through `/v1/vault/commit`; reading state
  remains absent until first open;
- `--edit-epub` and `--replace-images` read/decrypt through Fastly, preserve
  immutable replacement semantics, and conditionally publish affected state;
- `--clean-bucket` is an explicit isolated-administration command: it derives
  live objects from fixed scans plus protected export retention and performs
  two-pass, safety-aged R2 and orphan-reading cleanup; runtime Fastly never
  returns its list/delete authority;
- `--update-kv` is an offline admin command for explicit idempotent schema
  migrations; and
- legacy `--update-rql` and `--update-db` exist only in rollback/migration
  builds, never the final operational path.

Bulk ingest still commits one book plus the head per API call. Do not expose a
bulk operation that lets a caller submit arbitrary KV Store writes. The CLI
may upload one new snapshot for each committed book or use an explicit future
maintenance API whose fixed schema and atomicity are separately reviewed.

Only initialization, schema migration, cleanup, backup/export, restore, and
disaster recovery run in an isolated admin environment with broader access.
Never put that access in an owner credentials file or print it.

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

- a merged `{book_id}` entry: content key, prefix, path, catalog fields,
  and ordered shares with IDs, keys, paths, states, and creation time; and
- a `reading_{book_id}` entry: creation/last-access/last-CFI values and ordered
  bookmarks with uniqueness, optional page number, preview, creation time, and
  the 20-item cap.

Wrap each with its authenticated application identity fields and Encrypt it
using the canonical structured-payload blob from
[docs/crypto.md](../crypto.md), with the corresponding envelope from
[cryptography.md](cryptography.md). Build the initial reading index (§4) from
every migrated reading-state entry in the same pass. Each row's existing
owner EPUB and share object paths under `db_prefix` carry over unchanged; the
migrator only adds new KV Store entries and creates one random catalog object;
it never rewrites or relocates existing EPUB/share R2 objects.

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
choose a fresh random `{db_prefix}/catalog/{random}` key, include it in the
snapshot envelope, and upload with `If-None-Match: *` plus required integrity
metadata. Direct-HEAD it, encrypt that same key in the
`catalog-head-pointer` envelope, then create schema-v2 `catalog-head` with the
exact ETag/length/digest/logical generation and ciphertext. Verify both
decryptions, random inner-key equality, head bindings, projection, and search.

Separately, build and write the initial reading index from every migrated
reading-state entry with a create-only write. Verify only its own decryption,
schema, and that every `book_id` it references exists in the snapshot just
published.

### 5. Transform server control state

- Import every rqlite share row, preserving hashes, state, and timestamps, and
  set each target share entry's plaintext `book_id` from the target `book_id`
  its source row belongs to. Create one path reservation per row before its
  share entry, and fail on any collision/mismatch.
- Convert each unexpired legacy rate-limit window into that many occupied
  create-only admission slots with the original boundary, capped at the new
  ring size, so cutover cannot reset abuse budgets. Do not import a mutable
  counter entry. Expired windows may be omitted.
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
  entry, including R2 ETag/length/ciphertext SHA-256 populated by verified
  reads during migration;
- every bookmark CFI/page/preview/time and per-book count, and every
  last-access/last-CFI value, in the migrated reading entry and the published
  reading index;
- every share ID/key/prefix/path/state/time and shared R2 object, including its
  ETag/length/ciphertext SHA-256, in the `book` entry;
- server share hashes, states, `book_id` back-references, and object integrity
  metadata;
- initial snapshot and reading-index count/hash and projection equality; and
- authentication of every canonical blob and client-side agreement between
  each encrypted inner envelope and its outer entry's key and kind.

Run feature-parity smoke tests, conditionally mark migration complete, activate
the target Fastly service and browser together, then release maintenance.
Watch the first real `/v1/keys`, vault head/book/reading reads, snapshot load,
search, mutation commit, R2 URL issuance, share copy/read/delete, and token refresh.

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
a new set of KV Stores first, validates entries plus the catalog head and its
pointed-to immutable snapshot, then updates the Fastly Config/Secret Store
links and KV Store resource bindings.
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
- R2 snapshot bytes, load/build latency, create/commit failures, orphan
  generation count, head/object mismatches/repairs, and cleanup candidates;
- rate-limit decisions (durable and best-effort), share transitions, and
  anonymous URL exchanges with nonreversible labels;
- backup/export age, entry/object counts, restore-test date, migration schema;
  and
- KV Store storage size against its allowance, per store.

Alert on attempted generic/client-selected store or key access, repeated
owner/binding failures, an unexpected volume of `SetKey` calls from a route
that should be read-only, snapshot head/object mismatch, sustained
throttling, stale backups, or control/data schema mismatch.

## Key and secret rotation

- There is no KV Store account key or signing secret to rotate — KV Store
  access needs no secret at all.
- Rotate R2 signing credentials using overlap; already issued URLs expire in
  at most five minutes.
- Rotating `RATE_LIMIT_KEY` makes old subject slot rings unreachable; perform a
  bounded migration or conservative reset during maintenance.
- Rotating `SHARE_GRANT_KEY` invalidates distributed links unless a versioned
  read keyring remains. Issue new grants with the current key while retaining
  intended legacy validation keys.
- Rotating `vault_master_key` requires authenticated re-encryption of every
  book, reading, reading-index, catalog-head pointer, and current snapshot
  object under maintenance; never
  treat it as incidental schema migration.

## Release gate

Do not remove rqlite, Northflank, or legacy `db_path` until all checks pass:

- canonical blob and record/snapshot/reading-index envelope, Firebase
  claim/signing-certificate, possession-proof, and share-grant test vectors,
  all generating
  identifiers/nonces with at least 256 bits of entropy;
- ciphertext tamper fails AEAD authentication; entry splice, wrong key/kind/
  version, wrong owner, mismatched reading-state `book_id`, and snapshot
  relocation fail strict inner-envelope validation;
- no browser bundle/response contains a KV Store binding, name, or key;
- no browser response contains an R2 access key/secret/session token, list or
  DELETE authority, or a reusable prefix grant; presigned owner URLs bind one
  method, exact object, short expiry, and required conditional/integrity
  headers;
- every vault/control route fixes its store, key, method, and allowed
  operation; a client-supplied store/key selection is rejected; every route
  whose abuse is not self-contained rejects a missing, expired, wrong-request,
  or replayed possession proof even with a valid Firebase token;
- every durable admission limit caps successful create-only slot claims across
  Fastly POPs and instances without rewriting any slot, and the owner-subject
  ring is selected only from a verified Firebase subject, never an unverified
  claim; the two best-effort, in-instance limits are documented as approximate
  in the deployed configuration, not silently assumed durable;
- private API responses bypass cache and carry the required no-store policy;
- initial load is one R2 GET for the snapshot and one KV Store read for the
  reading index on cache miss, and local search and recency ordering match
  current results;
- ingest/edit/delete, reader progress, bookmarks, and conflict replay match
  current semantics, including that a reading-position update touches neither
  a book's merged entry nor `catalog-head`;
- content replacement is verified as the documented two-commit
  create-new-then-delete-old sequence; a simulated crash leaves old only,
  both, or new only, never neither, and does not transfer reading state;
- sharing and crash recovery pass [sharing.md](sharing.md), including current
  production-format links;
- failed R2 upload never advances the head; a `/v1/vault/commit` whose owner
  EPUB or catalog direct HEAD does not exactly match ETag/length/digest is
  rejected before any KV write; exact postconditions make book-write/head-write
  retries idempotent;
  an upload without a KV commit leaves an unreferenced immutable object;
  repair creates a fresh random generation from authenticated entries and
  encrypts its key in the head; and the reading index repairs independently;
- CLI migration is idempotent and a second run changes no semantics;
- backup/export restore succeeds into a clean set of KV Stores; and
- staging Class A/B operation counts, storage, latency, and Fastly limits fit
  the operating budget, with the highest-volume routes' actual measured KV
  Store write rate matching the estimate in
  [README.md](README.md#capacity-target).
