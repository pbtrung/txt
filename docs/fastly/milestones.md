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
  pure-Rust crate selected and pinned for each of Fastly's own primitives —
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
deploys to staging and answers `/health/live`.

## Milestone 2 — Owner bootstrap, Firebase auth, possession proof

Still no vault data. This milestone makes `/v1/keys` work end to end and
gives every later route its authorization primitives.

**Builds:**

- Firebase ID-token verification: JWKS fetch/cache honoring upstream
  `Cache-Control`, `kid` selection, signature verification, claim checks,
  clock-skew allowance.
- The `owner_control` KV Store and the `owner` entry shape; `POST /v1/keys`.
- The possession-proof canonical message construction, ECDSA-P521-SHA512
  verification, and the nonce anti-replay create-only write in
  `rate_limit_control`.
- The durable rate limiter (read-modify-write loop against a window entry)
  and the subject-independent pre-verification flood control.
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
  replayed inside its validity window rejected; proof for the wrong
  `route_name` rejected; proof with a client-supplied `owner_pk`/`vault_id`/
  `db_prefix` that disagrees with Fastly's configured values rejected, even
  when the signature itself is valid over the client's forged bytes.
- Concurrency test: fire N simultaneous requests against the same rate-limit
  window and assert the accepted count never exceeds the configured limit —
  this must run against the real KV Store in staging, not only the fake,
  because it is exactly the scenario eventual consistency could break.
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

- `vault:book:{book_id}` CRUD via `POST /v1/vault/commit` and
  `PUT /v1/vault/books/{book_id}`, including the fixed write order (book,
  then R2 existence check, then head) and the two-step content-replacement
  sequence.
- `catalog-head`, the R2 snapshot publish/verify path, and the vault scan
  (`GET /v1/vault/books?cursor=...`) used for repair.
- The browser's snapshot loader, local search index builder, and conflict
  replay (up to three attempts).
- CLI `--ingest`, calling the same Fastly routes as the browser — the CLI
  never touches KV Store directly, only the Fastly HTTP API with a
  Firebase-authenticated, possession-proof-signed client.

**Test plan:**

- Ordered-commit fault injection: kill the process (or inject a forced
  failure) between the book write and the head write, and confirm the
  system self-heals on the next commit via the documented
  `record_version`-vs-projection mismatch path, with no data loss and no
  manual intervention required.
- Conflict-replay test: two simulated clients race a commit against the
  same book; the loser must reload, reapply its original semantic mutation
  (not a byte-level overwrite), and succeed within the three-attempt cap; a
  fourth forced conflict must surface as a recoverable "unsaved" state, not
  a crash or silent data loss.
- Content-replacement test: simulate a crash between the delete and the
  create half of a content-replacement sequence; assert the library ends up
  either missing the title or showing the old content — never both, never
  neither, never corrupted.
- Repair test: corrupt/delete the current snapshot object directly in a
  staging R2 bucket, trigger repair, and confirm the rebuilt snapshot is
  byte-identical in content (not necessarily bytes) to what the live book
  entries project.
- Validation fuzzing on every catalog field (name/title/authors/subjects/
  publisher) and on content/share locator grammar, confirming rejection
  before any R2 key is constructed from unvalidated input.
- Scale test: ingest 10,000 synthetic books into staging and measure actual
  snapshot size, Class A/B operation counts, and load latency against the
  estimates in [README.md](README.md#capacity-target) and
  [catalog.md](catalog.md)'s scale guardrails — this is the test that turns
  those numbers from an estimate into a verified fact.
- Security: attempt to submit a `book` operation with a client-chosen
  `owner_pk`, a `container_role` other than `vault`, or a raw KV Store key
  in place of a book ID; every case must be rejected before any KV Store or
  R2 call.

**Exit criteria:** the 10,000-book scale test's measured numbers are within
the documented estimates (or the estimates are corrected before moving on);
fault-injection and conflict-replay tests pass in staging; a full ingest →
load → search → edit → delete cycle passes as one CI integration test.

## Milestone 4 — Reading state, bookmarks, reading index

The highest-frequency path in the whole system, and the one most sensitive
to getting the write-frequency accounting right.

**Builds:**

- `PUT`/`GET /v1/vault/reading/{book_id}` and `GET /v1/vault/reading-index`,
  including the best-effort in-instance flood control that deliberately
  skips the possession proof and durable rate limiter on this route.
- The client-side qualification/debounce state machine (six-second
  qualification, two-second debounce, 15-second maximum write interval,
  final flush on hide/switch/close) and the logic that decides whether a
  given write also includes a `reading_index` update.
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
  `reading:{book_id}`, and a `reading-index` write **only** on the
  qualifying edge or a bookmark change, never on a CFI-only debounce. This
  is the empirical check behind the Class A savings claimed in
  [README.md](README.md#capacity-target) and must be a permanent regression
  test, not a one-time measurement.
- Bookmark tests: cap enforcement (21st bookmark evicts the lowest
  `sequence`), uniqueness on `(book_id, cfi)`, preview normalization and the
  100-byte cap, and that `page_number` is never treated as identity.
- Conflict tests: concurrent devices racing a reading-state write, and
  separately racing a reading-index write, each resolved by fetch-reapply-
  retry independent of the other.
- Repair tests: delete the reading index directly in staging, rebuild it
  from the vault scan, and confirm every book's bookmarks and
  `last_accessed` match its authoritative `reading:{book_id}` entry; delete
  a book without its reading entry being cleaned up first, and confirm the
  cleanup step finds and removes the resulting orphan.
- Security/self-containment tests confirming the deliberate exemptions: a
  request with no possession proof succeeds on this route and only this
  route (outside the routes already exempted for being reads); a flood of
  requests from many simulated Compute instances demonstrates the
  best-effort limiter's known weakness (documented, not silently assumed
  fixed) without being able to touch any other route's data.
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
  `book_id` back-reference on the share entry.
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
- Grant/capability tests: a grant for one share/path cannot authorize
  another; a `deleting` share cannot exchange for a URL; public rate
  limiting holds under concurrent requests distributed across simulated
  points of presence.
- Backup/restore drill: export, wipe a scratch account's KV Stores, restore,
  and diff every entry and every snapshot reference against the
  pre-wipe state. This drill must succeed before the milestone closes, not
  merely be scheduled.
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
