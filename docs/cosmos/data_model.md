# Cosmos and R2 data model

All binary fields in JSON use unpadded base64url. Persisted timestamps use
nonnegative Unix milliseconds, matching the current SQL/rqlite representation;
protocol fields explicitly named as Unix seconds remain seconds. Item IDs and
partition values use ASCII opaque identifiers and must not contain user
metadata. Clients must reject unknown required schema versions rather than
guessing.

Every random identifier, nonce, or opaque token minted anywhere in this
directory uses at least 256 bits (32 bytes) of CSPRNG output before encoding,
unless a cited external algorithm fixes a different nonce size (XChaCha20-
Poly1305's 24-byte nonce in [cryptography.md](cryptography.md) is the one
exception, and is exempt because the cipher construction — not identifier
collision resistance — fixes that size). This applies to Cosmos item ID
suffixes, `share_id`, `object-path`/`prefix` segments, possession-proof
nonces, and any future opaque token; a 128-bit floor is not sufficient.

The 32-byte content/share prefix and path fields remain binary inside encrypted
JSON. Before using one as an R2 path segment, decode it and render the same 52
lowercase base32-Crockford characters used today. API path fields carry that
rendered form; they never put raw binary or base64url directly into an object
key.

## Database layout

The examples use these configurable IDs:

```text
database:           txt
owner control:      owner_control
share control:      share_control
rate-limit control: rate_limit_control
owner data:         vault
```

Production names may differ, but container roles and access boundaries must
not be combined. Fastly routes are bound to one container role each; no route
may accept a client-selected container or generic resource link.

## `owner_control`

Partition key: `/owner_pk`. Access: the fixed Fastly bootstrap route and offline
administration only.

### Owner item

There is exactly one owner item. Fastly point-reads it using configured
`OWNER_PK` and ID `owner`.

```json
{
  "id": "owner",
  "owner_pk": "own_opaqueRandomValue",
  "kind": "owner",
  "schema_version": 1,
  "firebase_uid": "configured Firebase subject",
  "user_handle_hash": "base64url SHA-256 digest",
  "vault_id": "vault_opaqueRandomValue",
  "vault_binding_hash": "base64url SHA-512 digest",
  "wrapped_user_master_key": "base64url",
  "kem_public_key": "base64url",
  "wrapped_kem_private_key": "base64url",
  "sign_version": 1,
  "sign_algorithm": "ECDSA-P521-SHA512",
  "sign_public_key": "base64url SubjectPublicKeyInfo DER",
  "wrapped_sign_private_key": "base64url",
  "encrypted_credentials": "base64url",
  "created_at": 1787356800000,
  "updated_at": 1787356800000
}
```

`sign_public_key` and `wrapped_sign_private_key` are the same P-521
request-signing keypair described in [docs/crypto.md](../crypto.md), carried
forward unchanged from the current schema. Protocol version 3 does not use a
signed ticket, but it does use this keypair for the per-route possession proof
defined in [cryptography.md](cryptography.md) and required by
[auth_api.md](auth_api.md) on every mutating or credential-minting route.
`sign_public_key` is not secret; Fastly reads it on every proof check the same
way it reads any other owner-item field.

The encrypted credential plaintext is versioned and contains:

```json
{
  "version": 2,
  "user_handle": "base64url 32 bytes",
  "display_name": "owner display name",
  "vault_master_key": "base64url 256 bytes",
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "db_prefix": "52-character owner R2 prefix"
}
```

`vault_master_key` is the existing `db_master_key` key material under a name
that reflects its new purpose. Migration preserves its bytes. `db_path` is
removed entirely; `db_prefix` remains because it scopes owner EPUB, catalog,
reading-state, and shared R2 objects. The decrypted `vault_id`, `owner_pk`, and
`db_prefix` must match the authenticated values or hashes returned by Fastly
before the browser accepts a session.

The control item contains no plaintext `user_handle` or display name. It is
safe for Fastly to return the wrapped/encrypted fields from `/v1/keys`, but
the item itself remains server-only.

### Schema and migration items

Every container — not only `owner_control` — carries its own schema/migration
markers so `/health/ready` can validate all four independently. Each container
reserves one logical partition value, `system`, exclusively for these markers;
owner or registry data never uses that partition value. Deterministic IDs such
as `schema:owner-control` and `migration:sqlcipher-to-cosmos:v1` are shared
naming convention across containers:

```json
{
  "id": "schema:owner-control",
  "owner_pk": "system",
  "kind": "schema",
  "version": 1,
  "updated_at": 1787356800000
}
```

The equivalent items in `vault`, `share_control`, and `rate_limit_control` use
`"system"` as their own container's partition-key value (`owner_pk: "system"`
in `vault`, `registry_pk: "system"` in `share_control`,
`bucket_pk: "system"` in `rate_limit_control`) with the same `id` naming
convention. Only the deployment migrator may advance these markers. Runtime
startup fails readiness if the supported and stored versions differ in any
container.

## `vault`

Partition key: `/owner_pk`. Access: fixed Fastly vault routes and offline
administration only. No browser credential can access this container.

All owner items deliberately share one logical partition. This makes
book-and-head publication transactional and lets Fastly inject one immutable
partition value for every route. Alert well before this partition approaches
Cosmos's logical-partition storage limit. Splitting reading state and
bookmarks into the R2 objects described below (rather than into this
partition) is a deliberate mitigation: they are by far the highest-frequency
mutation in the system, and keeping them off Cosmos entirely removes them from
both the RU budget and the partition-size pressure.

### Book item

One item holds the near-immutable identity of one book: its content locator
and its owner-side share state. It deliberately excludes catalog metadata
(kept in a separate `catalog` item, below, because catalog is mutated on a
different schedule than content — ingest and metadata edits — and re-encrypting
content/share ciphertext on every catalog-only edit would be wasted work) and
reading state (kept in R2, below, because it is by far the most frequently
mutated data associated with a book, while this item is close to immutable
once ingest completes).

```json
{
  "id": "book_K7c3...",
  "owner_pk": "own_opaqueRandomValue",
  "kind": "book",
  "schema_version": 2,
  "record_version": 5,
  "ciphertext": "base64url canonical authenticated blob",
  "updated_at": 1787356800000
}
```

`id` is a randomly generated, stable opaque identifier (`book_` followed by at
least 256 bits of random data, canonically encoded). `record_version` is
incremented inside and outside the ciphertext on every accepted mutation; the
values must match after decryption. It aids diagnosis but does not replace
Cosmos `_etag` concurrency.

The canonical blob and its authenticated application envelope are defined in
[cryptography.md](cryptography.md). The envelope's `record` member is:

```json
{
  "schema_version": 2,
  "record_version": 5,
  "book_id": "book_K7c3...",
  "created_at": 1787184000000,
  "content": {
    "txt_key": "base64url 128 bytes",
    "txt_prefix": "base64url 32 bytes",
    "path": "base64url 32 bytes"
  },
  "shares": [
    {
      "share_id": "base64url 32 bytes",
      "share_content_key": "base64url 128 bytes",
      "share_prefix": "base64url 32 bytes",
      "share_path": "base64url 32 bytes",
      "state": "active",
      "created_at": 1787356800000,
      "sequence": 2
    }
  ],
  "next_share_sequence": 3
}
```

Validation preserves the current rules:

- content and share locators are validated before interpolating an R2 key;
- share state is exactly `creating`, `active`, or `deleting`; and
- a book cannot be deleted while `shares` is non-empty.

### Catalog item

A second item, sharing the same `id` correlation but its own Cosmos identity,
holds the book's catalog metadata. Its `id` is `catalog_` followed by the
random suffix that follows `book_` in the corresponding book item's `id` (so
`book_K7c3...` pairs with `catalog_K7c3...`), which lets any route compute one
from the other without a lookup.

```json
{
  "id": "catalog_K7c3...",
  "owner_pk": "own_opaqueRandomValue",
  "kind": "catalog",
  "schema_version": 1,
  "record_version": 2,
  "ciphertext": "base64url canonical authenticated blob",
  "updated_at": 1787356800000
}
```

Envelope `record`:

```json
{
  "schema_version": 1,
  "record_version": 2,
  "book_id": "book_K7c3...",
  "catalog": {
    "name": "original.epub",
    "title": "Title",
    "authors": ["Author"],
    "subjects": ["Subject"],
    "publisher": "Publisher"
  }
}
```

Catalog fields keep the same accepted types and limits as ingestion today, and
`publisher` may be `null`. A catalog item is created together with its book
item at ingest (one transactional batch, [auth_api.md](auth_api.md)) and is
deleted together with it. Editing catalog metadata replaces only this item and
republishes the snapshot; it never touches the book item's content or shares.

### Reading-state object (R2, not Cosmos)

Reading position and bookmarks are the highest-frequency mutation associated
with a book — a qualifying read updates `last_accessed` once per session, a
visible relocation debounces `last_cfi` roughly every 15 seconds while
actively reading, and bookmarks are added and removed independently of both.
None of that belongs in Cosmos: it would either burn RU on the shared owner
partition for a mutation that a Cosmos read never needs, or force a snapshot
republish (a new immutable R2 object plus a Cosmos transactional batch) far
more often than the "almost immutable once ingested" book/catalog items
warrant.

Instead, each book's reading state is one small, independently mutable,
non-immutable R2 object, addressed deterministically from `book_id` and never
routed through Fastly or Cosmos at all:

```text
{db_prefix}/reading/{book_id}.blob
```

Decrypted canonical JSON:

```json
{
  "purpose": "txt:cosmos-reading",
  "envelope_version": 1,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "book_id": "book_K7c3...",
  "last_accessed": 1787356800000,
  "last_cfi": "epubcfi(...)",
  "bookmarks": [
    {
      "cfi": "epubcfi(...)",
      "page_number": 12,
      "preview": "normalized UTF-8 preview",
      "created_at": 1787356800000,
      "sequence": 4
    }
  ],
  "next_bookmark_sequence": 5
}
```

Validation preserves the current rules: `last_accessed` is `0` until the first
qualifying read and otherwise Unix milliseconds; `last_cfi` may be `null`;
bookmark uniqueness is `(book_id, cfi)`; previews are normalized and capped at
100 UTF-8 bytes; a book has at most 20 bookmarks, evicting the lowest
`sequence` when the cap is exceeded; `page_number` is optional display
metadata, never a bookmark identity. `book_id` is an authenticated back-
reference: it lets any UI surface that lists reading state across the library
(recently-read, all-bookmarks) open the correct book without a second lookup,
and it lets validation reject a reading-state blob copied onto the wrong
book's object key, mirroring the outer/inner identity binding used everywhere
else in this design.

This object is created with `If-None-Match: *` and thereafter overwritten with
`If-Match: <ETag>` using the owner's existing temporary R2 prefix credential —
the same conditional-write pattern the current (pre-Cosmos) system uses for
the whole `db_path` object, just scoped to one book instead of the whole
library. A `412` means another tab or device wrote first: download the latest
object, reapply the same semantic mutation, and retry, exactly as
[docs/data_model.md](../data_model.md) §1 already specifies for the legacy
whole-database object. There is no Cosmos `_etag`, no `record_version`
field outside the ciphertext, and no Fastly route in this path — Fastly's only
role was minting the R2 credential this object is written with. Because
Fastly never inspects this object, the cap/uniqueness/preview-length rules
above are enforced entirely client-side, at the same trust level EPUB content
already has today.

### Reading index (R2, derived)

The library screen still needs one cheap way to sort by "recently read" and
show bookmark counts for the whole library without a per-book R2 fetch. A
second small, mutable R2 object aggregates exactly that, and only that, across
every book:

```text
{db_prefix}/reading/index.blob
```

```json
{
  "purpose": "txt:cosmos-reading-index",
  "envelope_version": 1,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "entries": [
    { "book_id": "book_K7c3...", "last_accessed": 1787356800000, "bookmark_count": 2 }
  ]
}
```

A reading-state mutation updates both the per-book object and this index in
two small conditional R2 writes; neither touches Cosmos. Like the catalog
snapshot, the index is a **derived, rebuildable accelerator** — never the sole
copy of anything — and is excluded from the cleaner's deletion candidates the
same way `catalog-head`'s current object is. Unlike the catalog snapshot, it
never has a "generation" or an owning Cosmos pointer: it is simply the latest
successfully-written object at that fixed key, rebuildable at any time by
paging the fixed Fastly book scan and reading each book's own reading-state
object.

### Catalog head

The only Cosmos item in the owner partition that is not `book` or `catalog` is
a pointer to the current immutable library snapshot:

```json
{
  "id": "catalog-head",
  "owner_pk": "own_opaqueRandomValue",
  "kind": "catalog-head",
  "schema_version": 1,
  "generation": 184,
  "object_key": "{db_prefix}/catalog/184-random.blob",
  "ciphertext_sha256": "base64url 32 bytes",
  "ciphertext_bytes": 91842,
  "book_count": 713,
  "created_at": 1787356800000
}
```

The pointer metadata is not confidential. Its integrity and concurrency come
from authenticated Cosmos transport, route authorization, `_etag`, and the
snapshot AEAD/hash checks — **and**, before Fastly accepts a new pointer, a
direct R2 existence/length/hash check against the object it names (see
[auth_api.md](auth_api.md) `/v1/vault/commit`). `generation` increases by one
for every snapshot publication. It is not a timestamp.

The empty library still has a valid head and an encrypted snapshot envelope
whose `books` member is `[]`; absence of `catalog-head` is an initialization or
corruption error.

Catalog metadata edits, ingest, and delete all advance `generation`.
Reading-state and bookmark mutations never do — see
[catalog.md](catalog.md) for the exact republish list.

## `share_control`

Partition key: `/registry_pk`. Access: fixed Fastly share routes and offline
administration only. Every item uses `registry_pk: "shares"` so a registration
or deletion can be a single-partition transactional batch, except the schema
marker item, which uses `registry_pk: "system"`.

### Share registry item

```json
{
  "id": "share:{share_id_hash}",
  "registry_pk": "shares",
  "kind": "share",
  "schema_version": 1,
  "share_id_hash": "base64url SHA-256",
  "object_path_hash": "base64url SHA-256",
  "state": "active",
  "created_at": 1787356800000,
  "updated_at": 1787356800000
}
```

Only `active` entries may produce a shared URL. The raw share identifier and
R2 path are carried in the authenticated share grant, not stored in plaintext
control records.

### Object-path reservation

```json
{
  "id": "path:{object_path_hash}",
  "registry_pk": "shares",
  "kind": "share-path-reservation",
  "schema_version": 1,
  "share_id_hash": "base64url SHA-256",
  "object_path_hash": "base64url SHA-256",
  "created_at": 1787356800000
}
```

Create the share and reservation with create-only operations in one Cosmos
[transactional batch](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch).
This preserves uniqueness of both the share ID and exact R2 path without a
cross-partition unique-key assumption. When the create-only batch fails
because `share:{share_id_hash}` already exists, Fastly must not treat that as
an unconditional 409: it point-reads the existing share and reservation items
and compares their hashes against the request. Identical hashes on both items
is the idempotent-retry case described in
[auth_api.md](auth_api.md) `POST /v1/shares` (return a fresh grant, no write);
any other combination — a different `object_path_hash` for the same
`share_id_hash`, a partially-written pair, or a `deleting`/absent counterpart
— is the genuine 409. Deletion updates `active` to `deleting`, deletes R2, then
transactionally removes both items.

## `rate_limit_control`

Partition key: `/bucket_pk`. Access: Fastly limiter code and offline
administration only. Configure container TTL and set a per-item `ttl` slightly
longer than its window. The schema marker item uses `bucket_pk: "system"`.

```json
{
  "id": "window:1787356800",
  "bucket_pk": "owner-keys:{subject_hash}",
  "kind": "rate-limit",
  "scope": "owner-keys",
  "subject_hash": "base64url HMAC-SHA-256",
  "window_start": 1787356800,
  "count": 1,
  "limit": 60,
  "ttl": 7200
}
```

Fastly consumes a slot atomically: create the item with count 1, or on
conflict use conditional PATCH to increment only while `count < limit`. A
concurrent precondition failure is treated as limited and may be retried only
after a fresh point read. Cosmos unavailability fails closed for protected
operations. The in-process limiter may reject obvious floods early, but this
container is authoritative across replicas and restarts. Any pre-verification
flood control (before a Firebase token is checked at all) must use a
subject-independent bucket — normalized client IP or a global counter, never
one keyed by an unverified token claim — so an attacker who does not hold a
validly signed token cannot consume the owner-specific budget; see
[auth_api.md](auth_api.md) for the exact ordering.

This container also holds single-use possession-proof nonces (`kind:
"nonce"`), created with `If-None-Match: *` and a `ttl` just past the proof's
expiry; see [cryptography.md](cryptography.md) and
[auth_api.md](auth_api.md) for the proof this defends.

## Index policies

Use minimal explicit indexing. Cosmos automatically supports point reads by ID
and partition key; ciphertext and most value metadata do not need indexes.

- `owner_control`: include `/kind/?`, `/firebase_uid/?`, and `/schema_version/?`;
  exclude wrapped/encrypted binary fields.
- `vault`: include `/kind/?`, `/schema_version/?`, and `/generation/?`; exclude
  `/ciphertext/?`. Runtime book and catalog access is always a point read.
- `share_control`: include `/kind/?`, `/state/?`, and hash fields; most runtime
  operations are point reads or same-partition batches.
- `rate_limit_control`: point reads only; exclude all paths except required
  system paths and the partition key.

Validate the exact policy and measured RU cost in a staging account before
production. Do not enable broad indexing merely to inspect encrypted data.

## R2 object layout

```text
{db_prefix}/{txt_prefix}/{path}                       owner EPUB
{db_prefix}/catalog/{generation}-{random}.blob        library snapshot
{db_prefix}/reading/{book_id}.blob                    per-book reading state (mutable)
{db_prefix}/reading/index.blob                        reading index (mutable, derived)
{db_prefix}/shared/{share_prefix}/{share_path}        shared EPUB copy
{db_prefix}/exports/{timestamp}-{random}.blob         optional control/data export
```

The former top-level `{db_path}` SQLCipher object and rqlite backup prefix are
not part of the target layout. Existing owner and share EPUB object paths stay
unchanged during migration. Catalog and export objects are immutable and
uploaded with `If-None-Match: *`. Reading-state and reading-index objects are
the only mutable objects in this layout, and are always written with a
conditional `If-Match`/`If-None-Match` header carrying the previously observed
ETag.

The cleaner constructs the live set from all decrypted vault book and catalog
records, the current and retained catalog heads, the current per-book
reading-state object referenced by each live `book_id` plus the reading
index, active/deleting server share records, and retained exports. It never
infers liveness from an R2 listing alone.
