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
  in KV Store. Fastly continues to broker narrowly scoped R2 access.
- Store the library catalog as an immutable, Brotli-compressed, encrypted
  snapshot in R2. KV Store holds only its authenticated pointer. The snapshot
  provides one fast initial load and local full-text search; encrypted KV
  Store book entries are authoritative.
- Reading position and bookmarks are their own KV Store entry, separate from
  a book's identity/catalog entry, updated through a dedicated Fastly route.
  R2 holds only immutable content — EPUBs, library snapshots, shared copies,
  and exports; every piece of mutable owner state lives in KV Store.
- Keep the current one-owner model. Anonymous share recipients remain read-only
  capability holders and never access KV Store.

The owner request path is deliberately simple:

```text
Firebase Authentication -> Fastly Compute -> Fastly KV Store (native binding)
```

## Trust boundary

Fastly Compute validates Firebase ID tokens and holds R2 credential-minting
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
| Fast complete library load                     | One encrypted R2 library snapshot referenced by `catalog-head`, plus one small reading-index KV entry for recency/bookmark badges |
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
free (`DeleteKey`). A free/unpackaged account is limited to 250,000 Class A
and 5,000,000 Class B operations per month; a Compute Advantage or Ultimate
package raises that to 20,000,000 Class A and 1,000,000,000 Class B
operations per month, alongside a much larger storage allowance. Confirm the
current entitlement and per-key/per-store limits immediately before
provisioning against Fastly's own
[edge data storage product page](https://docs.fastly.com/products/edge-data-storage)
and [compute resource limits page](https://docs.fastly.com/products/compute-resource-limits).
Class A writes are the tight budget in every account tier, so this design
treats every avoidable `SetKey` call as a cost, not merely a latency concern.

Every design decision in this directory that could plausibly touch KV Store on
a hot path is evaluated against that Class A budget, not merely against
correctness:

- a book's identity and catalog metadata share one KV entry, so ingest and
  delete each cost one vault write instead of two;
- reading position and bookmarks live in their own small KV entry plus a
  shared reading-index entry, separate from a book's identity/catalog entry,
  so a relocation never rewrites content/catalog/share data. The reading
  index is updated only twice per reading session (once when it qualifies,
  once on close, if a bookmark changed) — never on the 15-second CFI-only
  debounce that dominates a session's writes, per
  [data_model.md](data_model.md)'s `reading-index` entry — so a debounced
  relocation costs exactly one Class A write, not two. Even so, a single
  owner's realistic worst case is on the order of tens of thousands of Class
  A operations per month — well inside the unpackaged free tier's 250,000,
  and negligible against a packaged account's 20,000,000. Track it anyway
  (see the metrics list in [catalog.md](catalog.md)) rather than assuming the
  estimate holds;
- neither the possession proof nor the durable per-owner admission slot —
  each itself a KV write — applies to an existing reading-state replacement.
  This is not a general reads-are-cheaper exemption: it holds specifically
  because a
  corrupted or flooded reading-state/reading-index entry cannot delete a
  book, revoke a share, corrupt `catalog-head`, or mint an R2 credential —
  its blast radius is self-contained and repairable — so it gets the same
  best-effort, in-instance flood control as read routes instead of a durable
  counter write on top of its own write(s) per update;
- the free-tier durable limiter never rewrites a shared counter. Each accepted
  protected request claims one create-only `slot_...` key in
  `rate_limit_control`, avoiding Fastly's one-write-per-second-per-item limit.
  `owner-vault-read`, by far the highest-volume read route, uses a
  best-effort in-instance counter instead of a durable KV write per call — see
  [auth_api.md](auth_api.md) for the admission algorithm and its bounded-probe
  tradeoff; and
- the fixed vault scan used for repair remains deliberately far more
  rate-limited than point reads, since it is the one route whose cost scales
  with library size rather than being O(1).

A sustained approach toward the Class A monthly ceiling, KV Store size
approaching its storage allowance, or an unexpected volume of `SetKey` calls
from a route that should be read-only is an explicit signal to revisit
capacity or route design rather than to weaken authorization or encryption.
