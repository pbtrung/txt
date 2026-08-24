# Fastly KV Store target architecture

This directory specifies the target architecture for replacing both rqlite and
the owner SQLCipher `db_path` object. It is an implementation contract. The
existing documents in `docs/` describe the currently deployed system until the
migration in [deployment_migration.md](deployment_migration.md) is complete.

## Decisions

- Use one request path for all owner data: the browser signs in with Firebase,
  sends its Firebase ID token to Fastly Compute, and Fastly Compute reads and
  writes Fastly KV Store directly through the platform's native KV Store
  binding — not through a signed HTTP call to an external database.
- Build the Fastly Compute service in Rust, targeting `wasm32-wasip1`, using
  WASI-compatible cryptographic crates — no crate that links a C or assembly
  library (`ring`, OpenSSL, BoringSSL, `aws-lc-rs`). See
  [deployment_migration.md](deployment_migration.md#rust-toolchain-and-cryptographic-crates)
  for the exact crate per primitive and the caveats that go with each.
- Make Fastly Compute the only runtime principal that touches KV Store.
  Browsers and anonymous share recipients never receive a KV Store handle and
  never call it directly; there is no such thing as a browser-facing KV Store
  credential to withhold, because the binding exists only inside the Compute
  service's own execution environment.
- Remove Northflank, OpenResty, rqlite, its persistent volume, the operator
  proxy, and rqlite backups after the rollback window.
- Store control-plane state and independently encrypted owner records in four
  Fastly KV Stores, one per role (`owner_control`, `vault`, `share_control`,
  `rate_limit_control`). Fastly fixes the store and key for every route
  instead of accepting a client-supplied store name or key.
- Use only underscore-delimited KV keys (`book_...`, `reading_...`,
  `slot_...`). Fastly allows `:` in a key but forbids it in a prefix query,
  so colon-delimited keys cannot support the fixed repair scans in this
  contract.
- Give each book exactly **one** KV entry holding both its identity (content
  locator and shares) and its catalog metadata. A KV Store has no cross-key
  transaction, so an ingest or delete that would otherwise need two writes to
  stay consistent is one write instead — see
  [Capacity target](#capacity-target).
- Keep immutable encrypted EPUB and share objects in R2. Do not put EPUB bytes
  in KV Store. Fastly returns only short-lived presigned URLs for one exact
  operation/object — never an R2 credential or prefix-wide authority.
- Store each Brotli-compressed encrypted catalog generation at a fresh random
  immutable R2 key. KV Store encrypts the current object key inside
  `catalog-head` and exposes only ETag/length/digest/generation metadata;
  encrypted KV Store book entries remain authoritative and rebuild it.
- Reading position and bookmarks are their own KV Store entry, separate from
  a book's identity/catalog entry, updated through a dedicated Fastly route.
  R2 EPUBs, shared copies, catalog generations, and exports are immutable;
  authoritative mutable owner state lives in KV Store.
- Keep the current one-owner model. Anonymous share recipients remain read-only
  capability holders and never access KV Store.

The owner request path is deliberately simple:

```text
Firebase Authentication -> Fastly Compute -> Fastly KV Store (native binding)
```

## Trust boundary

Fastly Compute validates Firebase ID tokens and holds R2 request-signing
credentials and application control secrets in a linked Fastly Secret Store.
KV Store access itself needs no secret at all: a Compute service reads and
writes a KV Store it is linked to through the platform's resource-link
mechanism, the same way it reads a Config Store, with no network-visible
endpoint, account key, or signature to steal. The browser holds the root key
and performs all user-data encryption and decryption locally. Neither the
browser nor service worker may receive or persist a KV Store binding, a raw
KV key, or an enumeration of KV Store contents.

The phrase _control store_ in these documents includes `owner_control`,
`share_control`, and `rate_limit_control`. All four stores, including `vault`,
are reachable at runtime only through route-specific Fastly code. CORS is not
an authorization boundary, and there is no browser-facing KV Store endpoint to
apply CORS to in the first place.

## Documents

- [architecture.md](architecture.md) defines services, trust zones, KV Stores,
  invariants, and request flows.
- [data_model.md](data_model.md) defines KV Store entry schemas and keys,
  encrypted book/catalog and reading-state records, and R2 paths.
- [cryptography.md](cryptography.md) applies the canonical primitives and blob
  format from [docs/crypto.md](../crypto.md) to records, snapshots, exports,
  and the per-request possession proof.
- [auth_api.md](auth_api.md) defines the Fastly Compute API, authorization,
  KV Store access, rate limiting, and failures.
- [catalog.md](catalog.md) defines the encrypted R2 library snapshot, fast
  initial load, full-text search, publication, concurrency, and repair.
- [sharing.md](sharing.md) preserves owner share creation, copy-link,
  revocation, and anonymous reading behavior.
- [deployment_migration.md](deployment_migration.md) defines provisioning,
  deployment, migration, CLI changes, rollback, operations, and verification.
- [milestones.md](milestones.md) defines the build order and test plan for
  implementing everything above, before cutover begins.

## Feature-parity requirement

| Current behavior                               | Target implementation                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Exactly one Firebase-authenticated owner       | Fastly validates the Firebase token and exact owner UID before every owner route                              |
| Root-key-only local decryption                 | Wrapped key hierarchy remains; plaintext root, master, content, and share keys never reach Fastly or KV Store  |
| A stolen session alone cannot mutate/mint      | A per-request P-521 possession proof, not just a Firebase token, gates every route whose abuse is not self-contained |
| Fast complete library load                     | One encrypted random-path R2 snapshot selected by the encrypted `catalog-head` pointer, plus one reading-index KV entry |
| Local full-text search                         | Search index is built in the browser from the decrypted snapshot; Fastly and KV Store never receive search text |
| Immutable encrypted EPUB objects               | Unchanged R2 layout under the owner prefix                                                                    |
| Reading-position qualification and throttling  | Preserved in the browser; qualified state is saved to a per-book KV Store reading-state entry through a dedicated Fastly route |
| Bookmarks, previews, ordering, and 20-item cap | Preserved atomically inside each per-book KV Store reading-state entry                                        |
| Share create/copy/delete state machine         | Preserved with encrypted owner state (in the merged `vault` entry) plus a server-only KV Store registry        |
| Anonymous, read-only shared reading            | Fastly validates the grant and returns a short exact-object R2 URL                                            |
| Optimistic concurrent mutation replay          | KV Store generation markers gate every conditional write                                                       |
| Owner CLI ingestion and maintenance            | CLI uses the same Firebase-authenticated Fastly API and snapshot protocol                                     |
| Cleanup and recovery                           | Reference-aware R2 cleanup, scheduled KV Store export, snapshot and reading-index repair, and independent exports |

## Capacity target

Fastly meters KV Store operations in three classes: **Class A** (`SetKey`,
plus one-time `CreateStore`/`UpdateStore` calls), **Class B** (`GetKey`), and
free (`DeleteKey`). As checked in August 2026, Fastly's published free tier
includes 1 GB of KV storage, 100,000 Class A operations, and 1,000,000 Class B
operations per month. It also lists 10 million Compute requests, 100 million
Compute vCPU milliseconds, and 10 Secret Store entries. This design assumes
only those free allowances and no paid edge rate limiter. Recheck the current
[Fastly pricing page](https://www.fastly.com/pricing) and
[compute resource limits](https://docs.fastly.com/products/compute-resource-limits)
immediately before provisioning. Class A writes are the tight budget, so this
design treats every avoidable `SetKey` call as a cost, not merely a latency
concern.

Every design decision in this directory that could plausibly touch KV Store on
a hot path is evaluated against that Class A budget, not merely against
correctness:

- a book's identity and catalog metadata share one KV entry, so ingest and
  delete each cost one vault write instead of two;
- reading position and bookmarks live in their own small KV entry plus a
  shared reading-index entry, separate from a book's identity/catalog entry,
  so a relocation never rewrites content/catalog/share data. The reading
  index is updated when the session first qualifies and whenever a bookmark
  changes — never on the 15-second CFI-only
  debounce that dominates a session's writes, per
  [data_model.md](data_model.md)'s `reading-index` entry — so a debounced
  relocation costs exactly one Class A write, not two. A heavily used reader
  can still consume tens of thousands of Class A operations per month, a
  material fraction of the 100,000-operation allowance. Measure it rather than
  assuming it fits (see the metrics list in [catalog.md](catalog.md));
- neither the possession proof nor a durable per-owner admission slot — each
  itself a KV write — applies to a conditional replacement of an existing
  reading-state entry. Fastly first confirms the book exists, and the blast
  radius is that book's rebuildable reading state. First creation and every
  library-wide reading-index write require proof and durable admission;
- each exact owner R2 URL costs one replay-nonce create and one admission-slot
  create. Its 60/hour cap and measured URL volume belong in the Class A budget;
  bulk migration uses the isolated administration path, not higher runtime
  limits or reusable credentials;
- the free-tier durable limiter never rewrites a shared counter. Each accepted
  protected request claims one create-only `slot_...` key in
  `rate_limit_control`, avoiding Fastly's one-write-per-second-per-item limit.
  `owner-vault-read`, by far the highest-volume read route, uses a
  best-effort in-instance counter instead of a durable KV write per call — see
  [auth_api.md](auth_api.md) for the admission algorithm and its bounded-probe
  tradeoff;
- anonymous share exchange uses a 20/hour durable ring keyed by the validated
  `share_id_hash` — never by requester IP or one shared deployment-wide
  counter — after an in-instance IP prefilter and capability validation.
  Keying by the share itself, rather than IP, still stops a rotating-IP
  attacker from creating a new ring per source, because minting a new
  `share_id` at all requires the authenticated, proof-gated, already-rate-
  limited `owner-share-write` route, not an anonymous request; unlike a single
  global ring, exhausting one share's ring cannot deny redemption of any other
  active share. Its total monthly cost therefore scales with the count of
  concurrently active shares rather than one fixed number — track it in the
  metrics list in [catalog.md](catalog.md);
- the fixed vault scan used for repair remains deliberately far more
  rate-limited than point reads, since it is the one route whose cost scales
  with library size rather than being O(1).

The route limits are short-window abuse controls, not proof that their combined
monthly maxima fit the free tier. Operate against an internal cutoff of 80,000
Class A operations per month, leaving 20% headroom for delayed telemetry,
repair, and provisioning. A scheduled budget monitor sets the deployment
read-only before that cutoff; routes that would create a nonce, slot, or
application entry fail closed until the next billing window. Approaching that
cutoff, the KV storage allowance, or an unexpected write volume is a signal to
reduce activity or revise the design, never to incur a paid feature silently
or weaken security.
