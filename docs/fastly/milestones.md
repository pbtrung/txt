# Implementation milestones

This is the build order for the design in this directory: five milestones,
each independently deployable to a staging environment and independently
testable, each unlocking the next. [deployment_migration.md](deployment_migration.md)
owns the actual cutover procedure once all five are done; this document owns
getting there with confidence.

## How to use this document

- A milestone is not "done" until its **exit criteria** pass in staging, not
  merely in local/unit tests. The local Compute development server
  (`fastly compute serve`) does not reproduce cross-point-of-presence KV Store
  propagation delay or real Firebase certificate rotation, so every milestone
  that touches KV Store or Firebase gets at least one staging run before its
  exit criteria are considered met.
- Every test suite fakes only the network boundary — Firebase, KV Store, R2 —
  never the cryptography itself. Canonical blob Encrypt/Decrypt, the
  possession-proof signature, and the share-grant cipher run for real, with
  real keys, in every test that touches them, exactly as the existing Python
  test suite already does for the deployed system's crypto.
- Every cross-runtime primitive (canonical blob, JWT claim rules, possession
  proof, share grant) gets one pinned fixture file checked into the repo and
  consumed by browser, Fastly Compute, and CLI test suites alike, so the
  three runtimes cannot silently disagree about a wire format.
- Each of [architecture.md](architecture.md)'s twelve mandatory invariants
  must be traceable to at least one automated test by the end of Milestone 5.
  Tag those tests (e.g. a comment or test-name convention referencing
  `invariant-7`) so a reviewer can check the mapping without re-deriving it.
- Milestones 4 and 5's sharing work do not depend on each other and may run
  in parallel once Milestone 3 is done; everything else is sequential.

## Milestone 1 — Cryptographic and KV Store primitives

No user-facing behavior yet. This milestone produces the shared libraries
every later route is built on. Note the split: the canonical blob format
(Ascon-Keccak AEAD, HKDF-SHA3-512) is implemented only in the browser and
CLI, since Fastly never holds `vault_master_key` and never decrypts a vault
entry; Fastly's own cryptographic surface is the narrower, different set of
primitives in [deployment_migration.md](deployment_migration.md#rust-toolchain-and-cryptographic-crates).

**Builds:**

- Browser/CLI: the canonical structured-payload Encrypt/Decrypt procedure
  from [docs/crypto.md](../crypto.md), and the vault entry envelope
  wrap/unwrap from [cryptography.md](cryptography.md) built on top of it, as
  one shared module reused everywhere an entry is built or opened — never
  reimplemented per call site.
- Fastly Compute: the Rust service skeleton on `wasm32-wasip1`, with the
  WASI-compatible crate selected and pinned for each primitive —
  JWT verification, P-521 signature verification, SHA-256/512, HMAC, HKDF,
  XChaCha20-Poly1305, and SigV4 — each wired up but not yet exercised by a
  real route, and the `cargo audit`/`cargo deny` allowlist entry for the
  `rsa` crate's open advisory recorded and justified.
- Fastly Compute: a KV Store access wrapper exposing exactly four operations
  to route code: point read, create-only write, conditional write
  (`if_generation_match`), and conditional delete — plus the bounded
  prefix-list operation used only by the vault scan. No route-level code
  touches the raw KV Store binding directly.
- A Fastly Compute service skeleton: the four KV Store resource links, a
  Config Store, a Secret Store, health endpoints returning static
  not-ready responses, and a CI pipeline that builds and runs the local
  Compute development server on every change.
- An in-memory KV Store fake implementing the same four operations with
  correct generation-marker and TTL semantics, for fast unit tests without a
  real Fastly service.

**Test plan:**

- Cross-runtime test vectors for the canonical blob format: known
  plaintext/IKM/salt in, known ciphertext out, and the reverse, run against
  every runtime that implements Encrypt/Decrypt (browser and CLI only).
- Envelope binding-failure vectors: tampered ciphertext, wrong
  `container_role`, wrong `owner_pk`, wrong `vault_id`, `item_id` that
  doesn't match the outer key, `record.book_id` that doesn't match
  `item_id` — one test per field, asserting rejection, not merely "does not
  crash."
- Property tests generating random opaque identifiers and asserting the
  256-bit entropy floor and canonical base64url encoding round-trip exactly,
  including the one documented exception (XChaCha20's 24-byte nonce).
- Confirm every selected Rust crate actually builds for `wasm32-wasip1` and
  runs correctly under the local Compute development server — a plain
  `cargo test` on the host target is not sufficient evidence, since a
  crate's WASI behavior (especially anything touching `getrandom`) can
  differ from its native-target behavior.
- Deploy two RS256 benchmark builds to staging, one with `jwt-simple` 0.13's
  `wasi-crypto` feature and one forced to its pure-Rust fallback. Record valid
  and invalid verification latency and CPU time. The feature remains enabled
  in production even if Fastly currently falls back transparently.
- KV Store fake conformance tests: create-only write against an existing key
  fails; conditional write against a stale generation fails; a TTL'd entry
  is treated as absent after expiry; list respects prefix and pagination
  limit. Run the identical conformance suite against a real staging KV
  Store and diff the results — any divergence blocks the milestone.
- Fuzz the canonical blob decoder with truncated, bit-flipped, and
  oversized inputs; every case must fail closed, never partially decode.

**Exit criteria:** the canonical-blob cross-runtime vectors agree between
the browser and CLI; every selected Fastly-side crate builds and runs
correctly for `wasm32-wasip1`; the KV Store fake's conformance suite passes
identically against the fake and a real staging store; the Compute skeleton
deploys to staging and answers `/health/live`; and valid/invalid RS256
verification fits the measured Fastly request CPU budget. If the host silently
uses the pure-Rust fallback and misses that budget, this milestone is blocked;
the published WASI-Crypto benchmark is not evidence of Fastly acceleration.

## Milestone 2 — Owner bootstrap, Firebase auth, possession proof

Still no vault data. This milestone makes `/v1/keys` work end to end and
gives every later route its authorization primitives.

**Builds:**

- Firebase ID-token verification: Google X.509 signing-certificate fetch/cache
  honoring upstream `Cache-Control`, `kid` selection, signature verification,
  claim checks, and clock-skew allowance.
- The `owner_control` KV Store and the `owner` entry shape; `POST /v1/keys`.
- The possession-proof canonical message construction, ECDSA-P521-SHA512
  verification, and the nonce anti-replay create-only write in
  `rate_limit_control`.
- The free-tier durable limiter (create-only admission slots, randomized
  bounded probing, TTL, and full-ring negative cache) and the
  subject-independent pre-verification flood control. Do not depend on
  Fastly Edge Rate Limiting.
- The Class A budget monitor and fail-closed `MUTATIONS_DISABLED` gate, tested
  against the allowance on Fastly's current pricing page rather than a legacy
  trial limit.
- The administrative bootstrap path used only by `--init-owner`: this is
  the one place that needs broader-than-route access to KV Store, since no
  owner exists yet for a Firebase-authenticated route to gate on. Build and
  document it as a distinct, narrowly-held credential from day one, not as
  a shortcut to retrofit later.

**Test plan:**

- JWT verification vectors: valid token, expired, wrong `aud`, wrong `iss`,
  unknown `kid` (must trigger exactly one refetch, not an unbounded retry
  loop), tampered signature, malformed compact serialization, oversized
  token. Assert the exact rejection reason internally but the shared,
  non-distinguishing error externally.
- Possession-proof vectors: correct proof accepted once; identical proof
  replayed inside its validity window rejected; method, normalized path, or
  any body field changed after signing rejected; noncanonical targets and
  query strings rejected; client-supplied `owner_pk`/`vault_id`/`db_prefix`
  fields rejected as unknown even when signed.
- Concurrency test: fire more than N simultaneous requests against the same
  slot ring and assert exactly N create-only claims succeed, no key is
  rewritten, and all later calls receive 429. Run this against staging KV,
  not only the fake, because atomic create-only admission is the property the
  limiter depends on under eventual read propagation.
- Ordering test: forge a request with a plausible-looking but unverified
  Firebase claim and confirm the owner-subject-keyed limiter is never
  consulted before signature verification completes.
- Negative test: confirm no response, log line, or error body from any
  route in this milestone ever contains a KV Store name, key, or the
  possession-proof private key.

**Exit criteria:** a browser-equivalent test client can complete
`/v1/keys` against staging using real Firebase test credentials; the replay
and rate-limit concurrency tests pass against staging KV Store, not just
the fake; a fuzz run of 10,000 malformed `/v1/keys` requests produces zero
500s and zero rejections that leak which check failed.

## Milestone 3 — Vault books, catalog snapshot, ingest

The library becomes real: books can be created, edited, deleted, and loaded
as a searchable list. Reading state and sharing are still out of scope.

**Builds:**

- `vault` key `{book_id}` (the ID already starts with `book_`) CRUD only through
  `POST /v1/vault/commit`, including owner-EPUB and catalog direct R2 HEAD
  checks before any KV write, idempotent book/head postconditions, and
  create-new-first content replacement.
- The hybrid `catalog-head` (encrypted random object key plus plaintext
  integrity metadata), immutable random-path R2 snapshots,
  `PUT /v1/vault/head` repair path, and fixed vault scan
  (`GET /v1/vault/books?cursor=...`).
- `POST /v1/r2-url` for exact owner-EPUB and catalog GET/conditional-PUT,
  with signed method, key, expiry, content type, Content-MD5, SHA-256 metadata,
  and create/ETag preconditions. No runtime response exposes credentials,
  list/delete permission, multipart authority, or a reusable prefix grant.
- The browser's snapshot loader, local search index builder, and conflict
  replay (up to three attempts).
- CLI `--ingest`, calling the same Fastly routes as the browser — the CLI
  never touches KV Store directly, only the Fastly HTTP API with a
  Firebase-authenticated, possession-proof-signed client.

**Test plan:**

- Ordered-commit fault injection at every boundary: before/after immutable R2
  create, each direct HEAD, book write, and head write. Retry the identical
  semantic request and confirm exact postconditions prevent double apply; a
  failed KV commit leaves only unreferenced immutable upload objects.
- Conflict-replay test: two simulated clients race a commit against the
  same book; the loser must reload, reapply its original semantic mutation
  (not a byte-level overwrite), and succeed within the three-attempt cap; a
  fourth forced conflict must surface as a recoverable "unsaved" state, not
  a crash or silent data loss.
- Content-replacement test: simulate a crash between create-new and
  delete-old; assert the library contains old only, both, or new only — never
  neither — and never transfers old CFIs/bookmarks to the new ID.
- Repair test: corrupt/delete the current pointed-to snapshot, confirm repair
  creates a fresh immutable random generation, encrypts that key in the head,
  and exactly projects live book entries without selecting an orphan.
- Client/CLI validation fuzzing on every decrypted catalog field and
  content/share locator. Fastly fuzzing covers only outer ID/kind/schema/size
  and must demonstrate that it never claims to inspect ciphertext fields.
- Scale test: ingest 10,000 synthetic books into staging and measure actual
  snapshot size, Class A/B operation counts, and load latency against the
  estimates in [README.md](README.md#capacity-target) and
  [catalog.md](catalog.md)'s scale guardrails — this is the test that turns
  those numbers from an estimate into a verified fact.
- Security: reject a raw KV key or mismatched outer item ID before storage
  access; after decryption, client/CLI tests reject a client-chosen `owner_pk`
  or wrong `container_role`. Confirm no content-locator-only bypass route
  exists.
- R2 authorization tests: mutate each presigned URL's method/key/query or any
  required header and require signature failure; reuse an immutable upload URL
  and require precondition failure; race two catalog commits and retain only
  the winner's pointer while the losing random object is an orphan; reject bad
  Content-MD5; and confirm responses/logs expose no signing secret, session
  credential, list/delete URL, or provider error body.

**Exit criteria:** the 10,000-book scale test's measured numbers are within
the documented estimates (or the estimates are corrected before moving on);
fault-injection and conflict-replay tests pass in staging; a full ingest →
load → search → edit → delete cycle passes as one CI integration test.

## Milestone 4 — Reading state, bookmarks, reading index

The highest-frequency path in the whole system, and the one most sensitive
to getting the write-frequency accounting right.

**Builds:**

- `PUT`/`GET` and `DELETE /v1/vault/reading/{book_id}` plus
  `PUT`/`GET /v1/vault/reading-index`. Every reading PUT point-reads its book
  first; only existing-entry conditional replacement is proof/durable-limiter
  exempt. First create, delete, and all index writes require proof.
- The client-side qualification/debounce state machine (six-second
  qualification, two-second debounce, 15-second maximum write interval,
  final flush on hide/switch/close) and the logic that writes authoritative
  reading state first, then independently writes the index when needed.
- Reading-index rebuild and orphaned-reading-entry cleanup in the
  administration CLI.

**Test plan:**

- Timing tests for every documented threshold: a session under six seconds
  never writes; a qualifying session writes exactly once at the boundary;
  relocations are debounced and capped at one write per 15 seconds; a hide/
  switch/close event flushes even mid-debounce.
- The write-accounting test this milestone exists to get right: instrument
  a simulated multi-hour reading session and assert the *count* of KV
  writes matches the documented model exactly — one write per debounce for
  `reading_{book_id}`, and a `reading-index` write **only** on the
  qualifying edge or a bookmark change, never on a CFI-only debounce. This
  is the empirical check behind the Class A savings claimed in
  [README.md](README.md#capacity-target) and must be a permanent regression
  test, not a one-time measurement.
- Bookmark tests: cap enforcement (21st bookmark evicts the lowest
  `sequence`), uniqueness on `(book_id, cfi)`, preview normalization and the
  100-byte cap, and that `page_number` is never treated as identity.
- Conflict tests: concurrent devices racing a reading-state write, and
  separately racing a reading-index write, each resolved by fetch-reapply-
  retry independent of the other. An index failure must not replay an
  already-successful reading-state write.
- Repair tests: delete the reading index directly in staging, rebuild it
  from the vault scan, and confirm every book's bookmarks and
  `last_accessed` match its authoritative `reading_{book_id}` entry; delete
  a book without its reading entry being cleaned up first, and confirm the
  cleanup step finds and removes the resulting orphan.
- Security/self-containment tests: a proofless conditional replacement
  succeeds only for an existing reading entry whose book exists. Proofless
  first create, absent book, and every index write fail. A multi-instance
  flood demonstrates the existing-entry best-effort limiter's documented
  weakness without touching other routes or creating arbitrary keys.
- Soak test: multiple simulated devices reading concurrently for a
  simulated multi-day period, watching for any drift between the
  reading-index and the per-book reading entries it was derived from.

**Exit criteria:** the write-accounting regression test is in CI and green;
soak test shows zero index/entry drift; repair tests pass against a
deliberately corrupted staging index.

## Milestone 5 — Sharing, administration, and cutover rehearsal

Feature-complete. This milestone also stands up everything
[deployment_migration.md](deployment_migration.md) assumes already exists
before cutover begins.

**Builds:**

- `POST`/`DELETE /v1/shares`, `POST /v1/shared-url`, the two-step
  path-reservation-then-share create in `share_control`, and the plaintext
  `book_id` plus ETag/length/digest on the share entry. Extend `/v1/r2-url`
  with exact create-only `share-put`; public GET pins the registered ETag.
- The administration CLI's read-only reconciliation report and explicit
  repair mode for every row of [sharing.md](sharing.md)'s recovery table.
- The scheduled administrative export job (KV Store's only backup
  mechanism), its independent `EXPORT_KEY`, and a restore path targeting a
  clean set of KV Stores.
- `--clean-bucket` and the KV-side orphan cleaners, run as one coordinated
  two-pass sweep.
- The full pre-cutover checklist and cutover migration steps from
  [deployment_migration.md](deployment_migration.md), executed once against
  a staging copy of production-shaped data.

**Test plan:**

- The full sharing crash-recovery matrix from
  [sharing.md](sharing.md)'s "Tests required before cutover": every saga
  boundary (owner-side creation, upload, registration, activation; deletion
  at each step) crossed with every failure mode (R2 404, generation
  conflict, browser crash) — not a sample of cells, all of them.
- Reconciliation coverage: construct a fixture for every row of the
  recovery table, including the path-reservation-orphan case introduced by
  the two-step (non-transactional) create, and assert the CLI's report and
  repair action match the documented action exactly.
- Registration fault injection: lose the response after reservation creation
  and separately after share creation; an exact retry must resume the matching
  reservation or return the existing active registration without another
  write, while any tuple mismatch remains a conflict.
- Grant/capability tests: a grant for one share/path cannot authorize
  another; a `deleting` share cannot exchange for a URL; public rate
  limiting holds under concurrent requests distributed across simulated
  points of presence, and rotating IPs still share the one global durable
  ring. Any ETag/length/SHA-256 mismatch among fragment, registry, and R2
  blocks download before AEAD plaintext is released.
- Backup/restore drill: export, wipe a scratch account's KV Stores, restore,
  and diff every entry plus the catalog head and pointed-to immutable snapshot
  against the pre-wipe state. This drill must succeed before the milestone
  closes, not merely be scheduled.
- Full dry-run migration against a staging copy of real production-shaped
  data (per deployment_migration.md's pre-cutover step 4 and cutover step
  6), diffing every book, bookmark, position, catalog field, share tuple,
  and owner binding between source and target.
- Run the complete [deployment_migration.md](deployment_migration.md)
  release-gate checklist as one automated suite and require it fully green.

**Exit criteria:** the release-gate checklist passes in full against
staging; the backup/restore drill succeeds; the dry-run migration reports
zero unexplained diffs. Only after this milestone closes does the actual
cutover in [deployment_migration.md](deployment_migration.md) begin.
