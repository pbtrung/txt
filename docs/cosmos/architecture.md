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
| `vault`              | `/owner_pk`    | Fixed Fastly vault routes only          | End-to-end encrypted book aggregates and one catalog-head pointer                                     |

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

- `owner_control` is authoritative for owner UID, wrapped key material,
  encrypted credential payload, stable vault binding, and control schema.
- Each encrypted `vault` book item is authoritative for one book's catalog,
  content locator/key, reading state, bookmarks, and owner-side share state.
- The `vault` `catalog-head` item is authoritative for the current immutable R2
  library snapshot.
- The library snapshot is a derived, rebuildable acceleration object. It is
  never the sole copy of book state.
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
5. It calls the Fastly vault routes with a current Firebase ID token. Fastly
   derives `OWNER_PK` from configuration, never from client authority, and
   performs the corresponding point read, bounded scan, or transactional batch
   in Cosmos.
6. The browser loads `catalog-head`, downloads/decrypts the current R2 snapshot,
   and builds the in-memory search index.
7. Opening or mutating a book uses its Fastly vault route. The browser supplies
   the previous opaque `_etag`; Fastly translates it to a Cosmos conditional
   request and returns conflicts without hiding them.

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
   container role, partition, item ID, kind, and versions. The canonical blob
   itself has no caller-supplied storage context.
7. The catalog head advances only after its immutable R2 object is fully
   uploaded and hashable.
8. Anonymous shares use independent encryption and server-side active registry
   state; owner credentials cannot be derived from a share.
9. Semantic mutations replay after an `_etag` conflict and stop after three
   automatic attempts before surfacing an unsaved state.
10. Book deletion is rejected while any owner-side share record exists.
11. Logs and metrics contain no Firebase tokens, Cosmos signatures/account
    keys, R2 credentials, grants, root/master/content/share keys, catalog
    plaintext, bookmark previews, or signed URLs.

## Explicit non-goals

- Multi-user accounts, invitations, and role management are not added.
- Cosmos server-side full-text search over owner metadata is not added.
- Encrypted virtual tables are not hosted inside Cosmos.
- Cosmos credentials are not delegated to owner or share browsers.
- Fastly is not a transparent or generic Cosmos REST proxy.
- R2 long-lived API keys are not embedded in the browser.
- The design does not depend on CORS, hidden identifiers, cache policy, or
  encrypted item fields as the sole authorization mechanism.
