# Architecture and trust model

## Topology

```text
                           server credentials only
                    +--------------------------------+
                    |                                v
owner browser --> Northflank API ----------------> Cosmos control plane
     |          Firebase auth + proof              owner_control
     |          token and R2 broker                share_control
     |                                             rate_limit_control
     |
     +-- short Cosmos resource token -----------> Cosmos vault
     |                                             owner partition only
     |
     +-- short R2 prefix credentials ------------> R2 owner objects

share browser --> Northflank share API ----------> share_control
     |                  |
     |                  +-- exact-object R2 signing
     +-- 60-second URL --------------------------> R2 shared object
```

The static UI remains on Cloudflare Pages. Northflank remains an OpenResty API
service but becomes stateless: it does not run rqlite and needs no persistent
volume. Cosmos DB stores both control and encrypted data records, while R2
stores large immutable encrypted objects.

## Security principals

### Owner browser

The owner browser authenticates with Firebase and holds the local root key. It
unwraps keys and encrypts/decrypts records locally. After proof of key
possession, it receives:

- a Cosmos native resource token with `All` permission on exactly one logical
  partition in `vault`; and
- an R2 temporary credential limited to the owner's `db_prefix`.

Both credentials expire after 15 minutes by default, remain in memory, and are
never persisted in the unlock file, IndexedDB, logs, URLs, or service workers.
The `All` Cosmos permission permits reads and writes only inside the scoped
partition; it confers no access to the account, database metadata, other
partitions, or control containers.

### Northflank API

Northflank is the only control-plane principal. It holds the Cosmos account
key in a managed secret, validates Firebase tokens, reads the owner bootstrap
record, verifies owner proof, maintains share/rate-limit records, and creates
short-lived client resource tokens. It also retains the current ticket,
share-grant, rate-limit, Firebase, and R2 secrets.

Using native Cosmos resource tokens requires local/key-based Cosmos
authentication to remain enabled. Therefore the account key is a high-impact
secret: keep it only at Northflank and the offline administration environment,
use primary/secondary-key rotation, and alert on unexpected control-plane
access. If disabling local authentication becomes mandatory, replace direct
browser Cosmos access with a Northflank data proxy or a different delegated
authorization service; Northflank cannot manufacture an Azure Entra token for
a browser user merely from Firebase authentication.

### Anonymous share browser

A share browser has only the URL capability and encrypted share key material.
It never receives a Firebase owner token, Cosmos resource token, owner R2
credential, or control record. Northflank validates the capability and returns
a 60-second exact-object R2 GET URL. Reading location remains local to the
recipient.

## Cosmos database and containers

Use one database, provisioned at the database level so all containers share the
free-tier RU budget.

| Container | Partition key | Access | Purpose |
| --- | --- | --- | --- |
| `owner_control` | `/owner_pk` | Northflank/admin only | Singleton owner identity, wrapped bootstrap keys, encrypted credentials, schema and migration markers |
| `share_control` | `/registry_pk` | Northflank/admin only | Public share registry and object-path reservations |
| `rate_limit_control` | `/bucket_pk` | Northflank/admin only | Durable rate-limit windows with TTL |
| `vault` | `/owner_pk` | Northflank/admin and scoped owner resource token | End-to-end encrypted book aggregates and one catalog-head pointer |

Create no Cosmos permission whose resource link targets a control container.
The client-facing Cosmos native user has only one permission definition:
`All` on `vault` with the owner's partition-key value. Northflank refreshes that
permission and returns its token only after the checks in
[auth_api.md](auth_api.md).

The database and containers are not discoverable through the browser token.
Their names are not secrets, but the UI should receive only the endpoint,
database ID, vault container ID, owner partition value, expiry, and token it
needs.

## Sources of truth

- `owner_control` is authoritative for the owner UID, wrapped key material,
  encrypted credential payload, stable vault binding, and control schema.
- Each encrypted `vault` book item is authoritative for one book's catalog,
  content locator/key, reading state, bookmarks, and owner-side share state.
- The `vault` `catalog-head` item is authoritative for which immutable R2
  library snapshot is current.
- The library snapshot is a derived, rebuildable acceleration object. It is
  never the sole copy of book state.
- `share_control` is authoritative for whether an anonymous capability is
  currently usable and which exact R2 object it may read.
- R2 encrypted EPUB and share objects are immutable content. The owner book row
  or share registry determines whether each object is referenced.

Cosmos item IDs, partition values, kinds, versions, object paths, lengths,
hashes, and timestamps may be plaintext metadata. User catalog text, reading
state, bookmark previews, content keys, share keys, and owner credentials must
remain in authenticated ciphertext.

## Owner session sequence

1. The UI reads the local unlock file and signs in to Firebase.
2. It calls `POST /v1/keys` with the Firebase ID token.
3. Northflank verifies the token's `sub` equals the configured owner UID,
   point-reads `owner_control`, applies the owner rate limit, and returns the
   wrapped/encrypted bootstrap fields plus a 24-hour owner ticket. It does not
   return a control-container token.
4. The browser checks all returned owner identities, unwraps the user master
   key and credential payload locally, and obtains `vault_id`, `owner_pk`, and
   `db_prefix`.
5. It makes a fresh P-521 proof bound to the ticket and stable vault binding,
   then calls `POST /v1/data-token`.
6. Northflank validates the ticket, proof, owner-control binding, and rate
   limit. It returns a 15-minute Cosmos token scoped only to the owner partition
   in `vault` and a 15-minute R2 credential scoped to `db_prefix`.
7. The browser point-reads `catalog-head`, downloads/decrypts the current
   snapshot if it is not cached, and builds the in-memory search index.
8. Opening or mutating a book point-reads its encrypted book aggregate. The
   browser uses `_etag` conditions for changes and refreshes short credentials
   through Northflank before expiry.

No step allows the browser to query `owner_control`, `share_control`, or
`rate_limit_control` directly.

## Anonymous share sequence

1. The recipient opens the fragment-bearing share URL. Secret capability
   material remains in the fragment and is not sent as a referrer.
2. The UI submits the share capability and current encrypted grant to
   `POST /v1/shared-url`.
3. Northflank hashes and validates the identifier against `share_control`,
   checks the grant's exact path and active state, and applies the public
   IP-based rate limit from `rate_limit_control`.
4. Northflank returns a 60-second R2 GET URL for exactly that shared object.
5. The browser downloads and decrypts the independent shared copy. Recipient
   progress and bookmarks remain local.

## Mandatory invariants

1. All control containers are server-only, including bootstrap reads.
2. A Firebase ID token alone never yields a writable Cosmos data token; fresh
   proof using the locally unwrapped signing key is required.
3. A client Cosmos token is restricted to one `vault` partition and 15 minutes.
4. Cosmos and Northflank never receive plaintext owner keys or user content
   metadata.
5. Every encrypted record is bound to its container, partition, item ID, kind,
   and schema version so ciphertext cannot be moved between rows.
6. The catalog head is advanced only after its immutable R2 object is fully
   uploaded and hashable.
7. Anonymous shares use independent content encryption and server-side active
   registry state; owner credentials cannot be derived from a share.
8. All semantic mutations are replayable after an `_etag` conflict and are
   bounded to three automatic attempts before surfacing an unsaved state.
9. Book deletion is rejected while any owner-side share record exists.
10. Logs and metrics contain no Firebase tokens, resource tokens, tickets,
    proofs, grants, root/master/content/share keys, catalog plaintext, bookmark
    previews, or signed URLs.

## Explicit non-goals

- Multi-user accounts, invitations, and role management are not added.
- Cosmos server-side full-text search over owner metadata is not added.
- Encrypted virtual tables are not hosted inside Cosmos. They remain available
  only if a temporary/local SQLCipher database is needed.
- Cosmos resource tokens are not issued to share recipients.
- R2 long-lived API keys are not embedded in the browser.
- The design does not depend on CORS, hidden identifiers, or encrypted item
  fields as the sole authorization mechanism.
