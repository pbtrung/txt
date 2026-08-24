# Architecture and trust model

## Topology

```text
owner browser -- Firebase ID token --> Fastly Compute API --> Fastly KV Store
     |                                      |                 owner_control
     |                                      |                 vault
     |                                      |                 share_control
     |                                      |                 rate_limit_control
     |                                      |
     |                                      +-- scoped R2 authorization broker
     +-- exact/bounded R2 access --------------------------> R2 owner objects
                     (immutable EPUBs and random immutable catalog generations)

share browser -- share capability --> Fastly Compute API --> share_control
     |                                      |
     |                                      +-- exact-object R2 signing
     +-- 60-second URL -------------------------------------> R2 shared object
```

The static UI may remain on Cloudflare Pages. All API traffic terminates at a
stateless Fastly Compute service. Every authenticated owner route verifies a
Firebase ID token and then performs a fixed operation against one linked KV
Store through the platform's native KV Store binding. KV Store holds every
piece of control and authoritative encrypted mutable owner state. R2 holds
large immutable encrypted EPUB/share/export objects and derived encrypted
catalog generations at random keys.

There is no browser-facing KV Store endpoint, credential, or query interface.
Do not ship a KV Store handle, store name, or generic lookup proxy to the
browser.

## Security principals

### Owner browser

The owner browser authenticates with Firebase and holds the local root key. It
unwraps keys and encrypts/decrypts records locally. It sends the current
Firebase ID token as `Authorization: Bearer ...` on every owner API request.
Firebase token refresh follows the Firebase client SDK; Fastly does not create
an application session or refresh token.

The browser may receive only short-lived presigned URLs for one exact R2
method/object. It never receives R2 API credentials, prefix-wide, list, or
delete authority. Presigned URLs are bearer capabilities and remain only in
memory; they never enter the unlock file, IndexedDB, logs, history, analytics,
or service workers. The browser never receives a KV Store binding. A KV Store
`generation` value is an opaque concurrency token and is safe to return.

### Fastly Compute API

Fastly Compute is the only runtime component that reads or writes KV Store. It:

- validates Firebase token signature and claims and requires the exact
  configured owner UID;
- reads the owner bootstrap entry and enforces route-specific authorization;
- verifies the per-request P-521 possession-proof signature (using the
  owner's already-public signing key) on every route whose abuse is not
  self-contained — the exact list is in [auth_api.md](auth_api.md) — rejecting
  a replayed or missing proof before state-changing vault/share or R2 work;
- reads and writes KV Store directly through its linked resource binding —
  no request signing, account key, or external endpoint is involved;
- fixes the target KV Store, key, and operation for each API route;
- validates request shape, sizes, conditional-write generations, and KV Store
  response shape before returning an allowlisted response;
- maintains share entries, create-only rate-admission slots, and replay
  nonces; and
- presigns exact-object R2 GET/conditional-PUT URLs and performs server-side
  share deletion; it never returns R2 credentials or runtime list/delete URLs.

A KV Store binding is a Compute service resource link, configured at deploy
time and resolved by the platform for the lifetime of a request — there is no
secret value to store, rotate, or leak, and no backend/TLS configuration the
way an external database would need. Fastly's
[KV Store guide](https://docs.fastly.com/products/edge-data-storage) and
[compute resource limits page](https://docs.fastly.com/products/compute-resource-limits)
describe the binding model and its limits.

KV Store is eventually consistent for reads: a `GetKey` issued shortly after a
`SetKey` is not guaranteed to observe it, particularly from a different point
of presence. Every conditional write in this design is instead anchored to
the entry's true current generation at the moment the write is evaluated, so
two competing writers cannot both succeed against the same prior generation —
one observes a mismatch and retries. Confirm this write-time guarantee against
Fastly's current KV Store documentation in staging before cutover; it is the
one property every conditional-write protocol in this directory depends on.

### Anonymous share browser

A share browser has only the URL capability and encrypted share-key material.
It never receives a Firebase owner token, KV Store binding, owner R2
credential, or control entry. Fastly validates the capability and returns a
60-second exact-object R2 GET URL. Reading location remains local.

## KV Stores

| Store                | Runtime access                          | Purpose                                                                                               |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `owner_control`      | Fixed Fastly owner-bootstrap route only | Singleton owner identity, wrapped bootstrap keys, encrypted credentials, schema and migration markers |
| `share_control`      | Fixed Fastly share routes only          | Public share registry and object-path reservations                                                    |
| `rate_limit_control` | Fastly limiter/replay code only         | Create-only admission slots and possession-proof replay nonces, both with a native entry TTL          |
| `vault`              | Fixed Fastly vault routes only          | End-to-end encrypted book/reading entries plus the hybrid encrypted-pointer catalog head                    |

A KV Store binding technically grants a Compute service access to every key in
that store. Application authorization therefore lives in explicit route code:
no route accepts a client-supplied store name, key, or lookup expression.
Each route constructs its key from trusted configuration and request
parameters that have already been validated against the authenticated owner.

## Sources of truth

- `owner_control`'s `owner` entry is authoritative for owner UID, wrapped key
  material (including the P-521 signing keypair used for the possession
  proof), encrypted credential payload, stable vault binding, and control
  schema.
- Each `vault` key `{book_id}` (already prefixed `book_`) is authoritative for that book's content
  locator, owner-side share state, and catalog metadata together.
- Each `vault` key `reading_{book_id}` is authoritative for that one book's
  reading position and bookmarks. Existing-entry replacement is deliberately
  exempt from the possession proof and durable rate limiting; first creation
  is not — see [auth_api.md](auth_api.md).
- The `vault` key `catalog-head` encrypts the current random R2 key and pins
  that object's ETag, length, ciphertext digest, and logical generation.
- The library snapshot and `vault` key `reading-index` are both derived, rebuildable
  acceleration objects/entries. Neither is ever the sole copy of book,
  catalog, or reading state; the reading index has no generation dependency
  on the snapshot and is rebuilt directly from every book's reading-state
  entry.
- `share_control` is authoritative for whether an anonymous capability is
  usable and which exact R2 object it may read.
- R2 encrypted EPUB, share, export, and catalog-generation objects are
  immutable. The current encrypted head pointer selects the live catalog.

KV Store keys, kinds, generations, object paths, lengths, hashes, and
timestamps may be plaintext metadata. User catalog text, reading state,
bookmark previews, content keys, share keys, and owner credentials remain in
authenticated ciphertext. Fastly sees ciphertext and routing metadata but
never their plaintext.

## Owner session sequence

1. The UI reads the local unlock file and signs in to Firebase.
2. It calls `POST /v1/keys` with the Firebase ID token.
3. Fastly validates the token and exact owner UID, claims a durable owner
   admission slot, reads the `owner` entry from `owner_control`, and returns only
   the wrapped or encrypted bootstrap fields.
4. The browser checks all returned owner identities, unwraps the user master
   key and credentials locally, and validates `vault_id`, `owner_pk`, and
   `db_prefix` against the authenticated bootstrap response.
5. It calls the Fastly vault routes with a current Firebase ID token, adding
   the per-request P-521 possession proof on every route that requires one.
   Fastly performs the corresponding KV Store read or write using keys it
   derives from configuration and the request, never from client-supplied
   key material.
6. The browser loads `catalog-head`, downloads/decrypts the current R2
   snapshot, reads the `reading-index` entry, and builds the in-memory search
   index and recency ordering.
7. Opening a book fetches its `book` entry through the Fastly vault route,
   decrypts it, and fetches its `reading` entry the same way for `last_cfi`
   and bookmark detail before rendering the reader. Mutating a book entry uses
   the Fastly vault route with the previous opaque `generation` and, where
   required, the possession proof. Mutating reading state uses its own
   dedicated route with the previous `generation`; its first create requires
   proof, while an existing conditional replacement uses the reading-only
   rate-limit treatment in [auth_api.md](auth_api.md). A qualifying recency or
   bookmark change updates the proof-required reading-index route afterward.

No step allows the browser to select or directly query a control store.

## Anonymous share sequence

1. The recipient opens the fragment-bearing share URL. Secret capability
   material remains in the fragment and is not sent as a referrer.
2. The UI submits the share capability and encrypted grant to
   `POST /v1/shared-url` at Fastly.
3. Fastly applies the in-instance IP prefilter, hashes and validates the
   identifier/grant against `share_control`, then claims one admission slot
   from that share's own durable ring in `rate_limit_control`.
4. Fastly returns a 60-second R2 GET URL for exactly that shared object.
5. The browser downloads and decrypts the independent shared copy. Recipient
   progress and bookmarks remain local.

## Mandatory invariants

1. Fastly Compute is the only runtime component that reads or writes KV Store.
2. Every owner route validates a current Firebase ID token and exact owner UID
   before any KV Store or R2 operation.
3. No browser receives a KV Store binding, key, or generic lookup interface.
4. Fastly derives the KV Store, key, and allowed operation from trusted
   configuration and validated request parameters; client input cannot widen
   them.
5. KV Store and Fastly never receive plaintext owner keys or user content
   metadata.
6. The browser or CLI must require every decrypted record's authenticated
   inner envelope to match its outer entry's key and kind, including a reading
   entry's `book_id`. Fastly cannot inspect these encrypted bindings. The
   canonical blob itself has no caller-supplied storage context.
7. A book create/replace and catalog-head advance occur only after direct,
   uncached R2 HEAD checks of the transient owner EPUB tuple and random catalog
   key exactly match proposed ETag/length/digest metadata. Clients must also
   decrypt both entries, require the locators to match, hash downloaded
   ciphertext, and authenticate the matching inner bindings.
8. Anonymous shares use independent encryption and server-side active registry
   state; owner credentials cannot be derived from a share.
9. Semantic mutations replay after a `generation` conflict and stop after
   three automatic attempts before surfacing an unsaved state.
10. Book deletion is rejected while any owner-side share record exists. This
    is enforced client-side only — the `shares` array lives inside ciphertext
    Fastly cannot inspect — so a client holding a valid bearer token and
    possession proof could still violate it; the offline reconciliation
    report in [sharing.md](sharing.md) is the server-side detection and
    recovery path for that case, not a preventive control.
11. Every route whose abuse is not self-contained — including book/head,
    reading-index, first reading create, reading delete, share, and R2-
    authorization writes — requires the per-request P-521 proof in
    [cryptography.md](cryptography.md). Only conditional replacement of an
    existing reading entry is exempt: Fastly first confirms the book exists,
    and damage is confined to that book's rebuildable reading state.
12. Logs and metrics contain no Firebase tokens, KV Store contents,
    R2 credentials, grants, possession-proof signatures, root/master/
    content/share keys, catalog plaintext, bookmark previews, or signed URLs.

## Explicit non-goals

- Multi-user accounts, invitations, and role management are not added.
- Server-side full-text search over owner metadata is not added.
- Encrypted virtual tables or a query language are not hosted in KV Store.
- KV Store access is not delegated to owner or share browsers.
- Fastly is not a transparent or generic KV Store proxy.
- R2 long-lived API keys are not embedded in the browser.
- The design does not depend on CORS, hidden identifiers, cache policy, or
  encrypted item fields as the sole authorization mechanism.
