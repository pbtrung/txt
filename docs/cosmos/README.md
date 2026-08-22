# Cosmos DB target architecture

This directory specifies the target architecture for replacing both rqlite and
the owner SQLCipher `db_path` object. It is an implementation contract. The
existing documents in `docs/` describe the currently deployed system until the
migration in [deployment_migration.md](deployment_migration.md) is complete.

## Decisions

- Keep Northflank. It remains the only authentication and control-plane API,
  the R2 credential broker, and the anonymous sharing gateway.
- Remove rqlite, its Northflank volume, the operator proxy, and rqlite backups.
- Store control-plane state in Azure Cosmos DB for NoSQL. Every control
  container is server-only; no browser receives a resource token for one.
- Store owner book metadata as independently encrypted records in a separate
  Cosmos data container. After Northflank authenticates the owner and verifies
  proof of key possession, it issues a short-lived Cosmos resource token scoped
  to that owner's one logical partition.
- Keep immutable encrypted EPUB and share objects in R2. Do not put EPUB bytes
  in Cosmos DB.
- Replace the monolithic SQLCipher database object with an immutable,
  Brotli-compressed, encrypted library snapshot in R2. Cosmos stores only the
  authenticated snapshot pointer. The snapshot provides one fast initial load
  and local full-text search; encrypted Cosmos book records are authoritative.
- Keep the current one-owner model. Anonymous share recipients remain
  read-only capability holders and never access Cosmos DB.

## Trust boundary

Northflank holds the Cosmos account key, Firebase verification configuration,
R2 credential-minting credentials, and server control-plane secrets. The
browser never receives any of those values. A browser may receive only:

1. wrapped or encrypted owner bootstrap material returned by Northflank;
2. a short-lived Cosmos resource token for the owner's `vault` partition;
3. short-lived R2 credentials limited to the owner's object prefix; and
4. anonymous share grants or exact-object download URLs where applicable.

The phrase *control container* in these documents always includes
`owner_control`, `share_control`, and `rate_limit_control`. They are reachable
only through Northflank's server credential. CORS is not an authorization
boundary and must not be used to expose them.

## Documents

- [architecture.md](architecture.md) defines services, trust zones, containers,
  invariants, and request flows.
- [data_model.md](data_model.md) defines Cosmos item schemas, partition keys,
  indexes, encrypted book records, and R2 paths.
- [cryptography.md](cryptography.md) defines key handling, value-level
  encryption contexts, ticket/proof bindings, and snapshot encryption.
- [auth_api.md](auth_api.md) defines Northflank endpoints, resource-token
  issuance, authorization, rate limiting, and failures.
- [catalog.md](catalog.md) defines the encrypted R2 library snapshot, fast
  initial load, full-text search, publication, concurrency, and repair.
- [sharing.md](sharing.md) preserves owner share creation, copy-link,
  revocation, and anonymous reading behavior.
- [deployment_migration.md](deployment_migration.md) defines provisioning,
  deployment, migration, CLI changes, rollback, operations, and verification.

## Feature-parity requirement

The migration is complete only when all of the following remain true:

| Current behavior | Target implementation |
| --- | --- |
| Exactly one Firebase-authenticated owner | Same check at Northflank; owner UID also binds all Cosmos control and vault records |
| Root-key-only local decryption | Wrapped key hierarchy is retained; plaintext root, master, content, and share keys never reach Northflank or Cosmos |
| Fast complete library load | One encrypted R2 library snapshot referenced by the Cosmos `catalog-head` item |
| Local full-text search | Search index is built in the browser from the decrypted snapshot; Cosmos never receives search text |
| Immutable encrypted EPUB objects | Unchanged R2 layout under the owner prefix |
| Reading-position qualification and throttling | Preserved in the browser; qualified state is saved in the encrypted book record |
| Bookmarks, previews, ordering, and 20-item cap | Preserved atomically inside each encrypted book aggregate |
| Share create/copy/delete state machine | Preserved with encrypted owner state plus server-only Cosmos registry |
| Anonymous, read-only shared reading | Unchanged Northflank grant validation and short exact-object R2 URL |
| Optimistic concurrent mutation replay | Cosmos `_etag` replaces the SQLCipher database-object ETag |
| Owner CLI ingestion and maintenance | CLI writes encrypted vault records and publishes the same snapshot protocol |
| Cleanup and recovery | Reference-aware R2 cleanup, Cosmos backup, snapshot repair, and independent exports |

## Capacity target

Use one Cosmos DB for NoSQL account with free tier enabled at account creation,
one region, and provisioned throughput shared at the database level. Allocate
the free-tier 1,000 RU/s across all four containers and stay within the
free-tier storage allowance. Do not choose the Cosmos serverless capacity mode:
free tier applies to provisioned throughput. Capacity and limits must be
confirmed immediately before provisioning against the official
[free-tier documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier),
[request-unit documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/request-units),
and [service limits](https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits).

This design minimizes RU use with point reads, one owner partition, excluded
ciphertext indexes, and no server-side full-text queries. A sustained 429 rate,
storage growth near the free allowance, or an owner partition approaching the
logical-partition limit is an explicit signal to revisit capacity rather than
weaken authorization or encryption.
