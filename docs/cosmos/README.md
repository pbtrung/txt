# Cosmos DB target architecture

This directory specifies the target architecture for replacing both rqlite and
the owner SQLCipher `db_path` object. It is an implementation contract. The
existing documents in `docs/` describe the currently deployed system until the
migration in [deployment_migration.md](deployment_migration.md) is complete.

## Decisions

- Use one request path for all owner data: the browser signs in with Firebase,
  sends its Firebase ID token to Fastly Compute, and Fastly Compute calls Azure
  Cosmos DB for NoSQL.
- Make Fastly Compute the only public API and the only runtime Cosmos principal.
  Browsers and anonymous share recipients never receive Cosmos credentials and
  never call the Cosmos endpoint directly.
- Remove Northflank, OpenResty, rqlite, its persistent volume, the operator
  proxy, and rqlite backups after the rollback window.
- Store control-plane state and independently encrypted owner book records in
  Cosmos. Fastly fixes the database, container, partition, and allowed operation
  for every route instead of accepting arbitrary Cosmos requests from clients.
- Keep immutable encrypted EPUB and share objects in R2. Do not put EPUB bytes
  in Cosmos DB. Fastly continues to broker narrowly scoped R2 access.
- Replace the monolithic SQLCipher database object with an immutable,
  Brotli-compressed, encrypted library snapshot in R2. Cosmos stores only its
  authenticated pointer. The snapshot provides one fast initial load and local
  full-text search; encrypted Cosmos book records are authoritative.
- Keep the current one-owner model. Anonymous share recipients remain read-only
  capability holders and never access Cosmos.

The owner request path is deliberately simple:

```text
Firebase Authentication -> Fastly Compute -> Azure Cosmos DB
```

## Trust boundary

Fastly Compute validates Firebase ID tokens and holds the Cosmos account key,
R2 credential-minting credentials, and application control secrets in a linked
Fastly Secret Store. The browser holds the root key and performs all user-data
encryption and decryption locally. Neither the browser nor service worker may
receive or persist a Cosmos account key, resource token, Azure credential, or
arbitrary Cosmos resource link.

The phrase _control container_ in these documents includes `owner_control`,
`share_control`, and `rate_limit_control`. All four containers, including
`vault`, are reachable at runtime only through route-specific Fastly code.
CORS is not an authorization boundary and Cosmos CORS is not enabled for the
browser origin.

## Documents

- [architecture.md](architecture.md) defines services, trust zones, containers,
  invariants, and request flows.
- [data_model.md](data_model.md) defines Cosmos item schemas, partition keys,
  indexes, encrypted book records, and R2 paths.
- [cryptography.md](cryptography.md) defines key handling, value-level
  encryption contexts, Firebase-token validation, and snapshot encryption.
- [auth_api.md](auth_api.md) defines the Fastly Compute API, authorization,
  Cosmos request signing, rate limiting, and failures.
- [catalog.md](catalog.md) defines the encrypted R2 library snapshot, fast
  initial load, full-text search, publication, concurrency, and repair.
- [sharing.md](sharing.md) preserves owner share creation, copy-link,
  revocation, and anonymous reading behavior.
- [deployment_migration.md](deployment_migration.md) defines provisioning,
  deployment, migration, CLI changes, rollback, operations, and verification.

## Feature-parity requirement

| Current behavior                               | Target implementation                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Exactly one Firebase-authenticated owner       | Fastly validates the Firebase token and exact owner UID before every owner route                              |
| Root-key-only local decryption                 | Wrapped key hierarchy remains; plaintext root, master, content, and share keys never reach Fastly or Cosmos   |
| Fast complete library load                     | One encrypted R2 library snapshot referenced by the Cosmos `catalog-head` item                                |
| Local full-text search                         | Search index is built in the browser from the decrypted snapshot; Fastly and Cosmos never receive search text |
| Immutable encrypted EPUB objects               | Unchanged R2 layout under the owner prefix                                                                    |
| Reading-position qualification and throttling  | Preserved in the browser; qualified state is saved in the encrypted book record through Fastly                |
| Bookmarks, previews, ordering, and 20-item cap | Preserved atomically inside each encrypted book aggregate                                                     |
| Share create/copy/delete state machine         | Preserved with encrypted owner state plus a server-only Cosmos registry                                       |
| Anonymous, read-only shared reading            | Fastly validates the grant and returns a short exact-object R2 URL                                            |
| Optimistic concurrent mutation replay          | Cosmos `_etag` is carried through the Fastly API and replaces the SQLCipher object ETag                       |
| Owner CLI ingestion and maintenance            | CLI uses the same Firebase-authenticated Fastly API and snapshot protocol                                     |
| Cleanup and recovery                           | Reference-aware R2 cleanup, Cosmos backup, snapshot repair, and independent exports                           |

## Capacity target

Use one Cosmos DB for NoSQL account with free tier enabled at account creation,
one region, and provisioned throughput shared at the database level. Allocate
the free-tier 1,000 RU/s across all four containers and stay within the
free-tier storage allowance. Do not choose Cosmos serverless capacity mode:
free tier applies to provisioned throughput. Confirm capacity and limits
immediately before provisioning against the official
[free-tier documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier),
[request-unit documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/request-units),
and [service limits](https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits).

This design minimizes RU use with point reads, one owner partition, excluded
ciphertext indexes, and no server-side full-text queries. A sustained 429 rate,
storage growth near the free allowance, or an owner partition approaching the
logical-partition limit is an explicit signal to revisit capacity rather than
weaken authorization or encryption.
