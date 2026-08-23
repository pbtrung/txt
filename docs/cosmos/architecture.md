# Architecture and trust model

## Topology

```text
owner browser -- Firebase ID token --> Fastly Compute API --> Cosmos DB
     |                                      |                owner_control
     |                                      |                vault
     |                                      |                share_control
     |                                      |                rate_limit_control
     |                                      |
     |                                      +-- scoped R2 credential broker
     +-- short R2 prefix credentials -----------------------> R2 owner objects
                                     (EPUBs, catalog snapshot, reading state/index — all conditional writes, no Fastly step)

share browser -- share capability --> Fastly Compute API --> share_control
     |                                      |
     |                                      +-- exact-object R2 signing
     +-- 60-second URL -------------------------------------> R2 shared object
```

The static UI may remain on Cloudflare Pages. All API traffic terminates at a
stateless Fastly Compute service. Every authenticated owner route verifies a
Firebase ID token and then performs a fixed Cosmos operation through a
configured TLS backend. Cosmos DB stores control and encrypted data records;
R2 stores large immutable encrypted objects.

There is no direct browser-to-Cosmos path. Do not ship a Cosmos SDK, account
key, native resource token, Azure token, database/container selector, or generic
Cosmos proxy to the browser.

## Security principals

### Owner browser

The owner browser authenticates with Firebase and holds the local root key. It
unwraps keys and encrypts/decrypts records locally. It sends the current
Firebase ID token as `Authorization: Bearer ...` on every owner API request.
Firebase token refresh follows the Firebase client SDK; Fastly does not create
an application session or refresh token.

The browser may receive a 15-minute R2 credential restricted to the owner's
`db_prefix`. It remains in memory and is never persisted in the unlock file,
IndexedDB, logs, URLs, or service workers. The browser never receives a Cosmos
credential. `_etag` values are opaque concurrency tokens and are safe to return.

### Fastly Compute API

Fastly Compute is the only runtime Cosmos principal. It:

- validates Firebase token signature and claims and requires the exact
  configured owner UID;
- reads the owner bootstrap record and enforces route-specific authorization;
- verifies the per-request P-521 possession-proof signature (using the
  owner's already-public signing key) on every route that mutates durable
  state or mints R2 credentials, rejecting a replayed or missing proof before
  any Cosmos or R2 work;
- signs Cosmos REST requests with the account key from Fastly Secret Store;
- fixes the target database, container, partition key, item ID rules, and
  operation for each API route;
- validates request shape, sizes, conditional-write tokens, and Cosmos response
  shape before returning an allowlisted response;
- maintains share and durable rate-limit records; and
- mints narrowly scoped R2 credentials and exact-object URLs.

The Cosmos account key is a high-impact secret. Store it only in Fastly Secret
Store and the offline administration environment, rotate it with the Cosmos
primary/secondary-key procedure, and never place it in a build-time environment
variable, Config Store, log, response, or client bundle. Fastly Secret Store is
intended for secrets available to Compute during request processing; build-time
environment variables are embedded in the Wasm binary. See Fastly's
[Secret Store guide](https://www.fastly.com/documentation/guides/compute/edge-data-storage/working-with-secret-stores/)
and [environment-variable warning](https://www.fastly.com/documentation/reference/compute/ecp-env/).

Cosmos local/key authentication remains enabled for this design. Every REST
request is independently signed inside Fastly. If account-key use at the edge
becomes unacceptable, replace it with a supported Azure Entra workload
identity/RBAC design; never forward a Firebase token to Cosmos as if it were an
Azure access token.

### Anonymous share browser

A share browser has only the URL capability and encrypted share-key material.
It never receives a Firebase owner token, Cosmos credential, owner R2
credential, or control record. Fastly validates the capability and returns a
60-second exact-object R2 GET URL. Reading location remains local.

## Cosmos database and containers

Use one database with provisioned throughput at database level so all
containers share the free-tier RU budget.

| Container            | Partition key  | Runtime access                          | Purpose                                                                                               |
| -------------------- | -------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `owner_control`      | `/owner_pk`    | Fixed Fastly owner-bootstrap route only | Singleton owner identity, wrapped bootstrap keys, encrypted credentials, schema and migration markers |
| `share_control`      | `/registry_pk` | Fixed Fastly share routes only          | Public share registry and object-path reservations                                                    |
| `rate_limit_control` | `/bucket_pk`   | Fastly limiter/replay code only         | Durable rate-limit windows with TTL                                                                   |
| `vault`              | `/owner_pk`    | Fixed Fastly vault routes only          | End-to-end encrypted book/catalog item pairs and one catalog-head pointer (reading state lives in R2, not here) |

The account key technically grants broader Cosmos access than any one route.
Application authorization therefore lives in explicit route code: the API must
not accept a client-supplied Cosmos URL, resource link, container name,
partition value, query text, stored-procedure name, or authorization header.
Each route constructs the resource link from trusted configuration and injects
the one configured `OWNER_PK`.

Use a static Fastly backend for the exact Cosmos hostname with TLS, SNI,
certificate hostname, and `Host` override all set consistently. Fastly's
[backend guidance](https://www.fastly.com/documentation/guides/integrations/non-fastly-services/developer-guide-backends/)
describes those settings.

## Sources of truth

- `owner_control` is authoritative for owner UID, wrapped key material
  (including the P-521 signing keypair used for the possession proof),
  encrypted credential payload, stable vault binding, and control schema.
- Each encrypted `vault` book item is authoritative for one book's content
  locator/key and owner-side share state. Its paired `vault` catalog item
  (`catalog_` + the book's opaque suffix) is authoritative for that book's
  catalog metadata, independently of the book item.
- Each R2 reading-state object (`{db_prefix}/reading/{book_id}.blob`) is
  authoritative for that one book's reading position and bookmarks. It is a
  plain conditionally-written R2 object, not a Cosmos item, and Fastly never
  sees its plaintext or mediates its writes beyond minting the R2 credential.
- The `vault` `catalog-head` item is authoritative for the current immutable R2
  library snapshot.
- The library snapshot and the R2 reading index are both derived, rebuildable
  acceleration objects. Neither is ever the sole copy of book, catalog, or
  reading state; the reading index in particular has no Cosmos pointer and no
  generation, and is rebuilt directly from the per-book reading-state objects.
- `share_control` is authoritative for whether an anonymous capability is
  usable and which exact R2 object it may read.
- R2 encrypted EPUB and share objects are immutable content. The owner book row
  or share registry determines whether each object is referenced.

Cosmos item IDs, partition values, kinds, versions, object paths, lengths,
hashes, and timestamps may be plaintext metadata. User catalog text, reading
state, bookmark previews, content keys, share keys, and owner credentials remain
in authenticated ciphertext. Fastly sees ciphertext and routing metadata but
never their plaintext.

## Owner session sequence

1. The UI reads the local unlock file and signs in to Firebase.
2. It calls `POST /v1/keys` with the Firebase ID token.
3. Fastly validates the token and exact owner UID, applies the durable owner
   rate limit, point-reads `owner_control`, and returns only the wrapped or
   encrypted bootstrap fields.
4. The browser checks all returned owner identities, unwraps the user master
   key and credentials locally, and validates `vault_id`, `owner_pk`, and
   `db_prefix` against the authenticated bootstrap response.
5. It calls the Fastly vault routes with a current Firebase ID token, adding
   the per-request P-521 possession proof on every route that mutates state or
   mints R2 credentials. Fastly derives `OWNER_PK` from configuration, never
   from client authority, and performs the corresponding point read, bounded
   scan, or transactional batch in Cosmos.
6. The browser loads `catalog-head`, downloads/decrypts the current R2
   snapshot, downloads/decrypts the R2 reading index, and builds the in-memory
   search index and recency ordering.
7. Opening a book fetches its paired `book`/`catalog` items through the Fastly
   vault route and its reading-state object directly from R2 with the
   temporary prefix credential. Mutating `book`/`catalog`/`catalog-head` uses
   the Fastly vault route with the previous opaque `_etag` and, where
   required, the possession proof; Fastly translates the `_etag` to a Cosmos
   conditional request and returns conflicts without hiding them. Mutating
   reading state uses a direct R2 conditional write against the same
   temporary credential, with no Fastly or Cosmos step at all.

No step allows the browser to select or directly query a control container.

## Anonymous share sequence

1. The recipient opens the fragment-bearing share URL. Secret capability
   material remains in the fragment and is not sent as a referrer.
2. The UI submits the share capability and encrypted grant to
   `POST /v1/shared-url` at Fastly.
3. Fastly hashes and validates the identifier against `share_control`, checks
   the grant's exact path and active state, and applies the durable public rate
   limit from `rate_limit_control`.
4. Fastly returns a 60-second R2 GET URL for exactly that shared object.
5. The browser downloads and decrypts the independent shared copy. Recipient
   progress and bookmarks remain local.

## Mandatory invariants

1. Fastly Compute is the only runtime principal that can call Cosmos.
2. Every owner route validates a current Firebase ID token and exact owner UID
   before any Cosmos or R2 operation.
3. No browser receives a Cosmos account key, resource token, Azure token, or
   generic database/query interface.
4. Fastly injects the database, container, owner partition, and allowed
   operation from trusted configuration; client input cannot widen them.
5. Cosmos and Fastly never receive plaintext owner keys or user content
   metadata.
6. Every decrypted record's authenticated inner envelope must match its outer
   container role, partition, item ID, kind, and versions — including a
   catalog item's `record.book_id` correlating back to its paired book item's
   ID, and a reading-state object's `book_id` matching the R2 key it was
   fetched from. The canonical blob itself has no caller-supplied storage
   context.
7. The catalog head advances only after Fastly has independently verified —
   by a direct R2 existence/length/hash check, not client-supplied metadata
   alone — that its immutable R2 object was fully uploaded and matches.
8. Anonymous shares use independent encryption and server-side active registry
   state; owner credentials cannot be derived from a share.
9. Semantic mutations replay after an `_etag` (or, for reading state, R2
   `ETag`) conflict and stop after three automatic attempts before surfacing
   an unsaved state.
10. Book deletion is rejected while any owner-side share record exists. This
    is enforced client-side only — the `shares` array lives inside ciphertext
    Fastly cannot inspect — so a client holding a valid bearer token and
    possession proof could still violate it; the offline reconciliation
    report in [sharing.md](sharing.md) is the server-side detection and
    recovery path for that case, not a preventive control.
11. Every route that mutates durable owner state or mints R2 credentials
    requires the per-request P-521 possession proof in
    [cryptography.md](cryptography.md), not merely a valid Firebase token, so
    that a stolen bearer token alone cannot delete books, revoke shares,
    corrupt the catalog head, or obtain R2 access.
12. Logs and metrics contain no Firebase tokens, Cosmos signatures/account
    keys, R2 credentials, grants, possession-proof signatures, root/master/
    content/share keys, catalog plaintext, bookmark previews, or signed URLs.

## Explicit non-goals

- Multi-user accounts, invitations, and role management are not added.
- Cosmos server-side full-text search over owner metadata is not added.
- Encrypted virtual tables are not hosted inside Cosmos.
- Cosmos credentials are not delegated to owner or share browsers.
- Fastly is not a transparent or generic Cosmos REST proxy.
- R2 long-lived API keys are not embedded in the browser.
- The design does not depend on CORS, hidden identifiers, cache policy, or
  encrypted item fields as the sole authorization mechanism.
