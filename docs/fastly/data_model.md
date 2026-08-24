# KV Store and R2 data model

All binary fields in JSON use unpadded base64url. Persisted timestamps use
nonnegative Unix milliseconds; protocol fields explicitly named as Unix
seconds remain seconds. KV Store keys and the identifiers embedded in them
use ASCII opaque tokens and must not contain user metadata. Clients must
reject unknown required schema versions rather than guessing.

Every random identifier, nonce, or opaque token minted anywhere in this
directory uses at least 256 bits (32 bytes) of CSPRNG output before encoding,
unless a cited external algorithm fixes a different nonce size (XChaCha20-
Poly1305's 24-byte nonce in [cryptography.md](cryptography.md) is the one
exception, and is exempt because the cipher construction — not identifier
collision resistance — fixes that size). This applies to book IDs, `share_id`,
object-path/prefix segments, possession-proof nonces, and any future
opaque token; a 128-bit floor is not sufficient.

The 32-byte content/share prefix and path fields remain binary inside encrypted
JSON. Before using one as an R2 path segment, decode it and render the same 52
lowercase base32-Crockford characters used today. API path fields carry that
rendered form; they never put raw binary or base64url directly into an object
key.

## KV Store layout

```text
owner control:      owner_control
share control:      share_control
rate-limit control: rate_limit_control
owner data:          vault
```

Production names may differ, but store roles and access boundaries must not
be combined. Fastly routes are bound to one store role each; no route may
accept a client-selected store or key.

A KV Store has no partition key and no cross-key transaction. Every entry
below is addressed by one opaque key inside its store, and every mutation that
must be visible in more than one entry — for example, publishing a book
alongside the catalog head — is expressed as an ordered sequence of
independent, individually conditional writes, described where it occurs. Each
entry carries a `generation` marker maintained by KV Store itself, used the
same way throughout this directory: read it, act only while it still matches
on the next write, and treat a mismatch as a conflict to reload and retry.

Every KV key uses only ASCII letters, digits, `_`, and `-`. In particular,
the type separator is `_`, never `:`: Fastly accepts a colon in an individual
key but does not accept one in the `prefix` parameter used by list/repair
operations. Recheck this restriction against Fastly's current
[KV Store limits](https://docs.fastly.com/products/compute-resource-limits#kv-store)
before provisioning.

## The whole picture

Every section below shows one entry's complete shape: its outer, plaintext KV
fields and, when encrypted, what its `ciphertext` field decrypts to. Encrypted
`vault` entries follow the exact same eight-field pattern (`purpose`,
`envelope_version`, `container_role`, `owner_pk`, `vault_id`, `item_id`,
`kind`, `record`);
[cryptography.md](cryptography.md) defines that pattern and its validation
rules once. `catalog-head` combines nonsensitive outer integrity metadata with
an encrypted vault envelope containing its random R2 object key.

Four KV Stores, plus R2 for encrypted content:

- `owner_control` holds one `owner` entry. Nothing else references it.
- `vault` holds `{book_id}`, `reading_{book_id}`, `reading-index`, and
  `catalog-head`. A `book` and its `reading` entry share the same `book_id`;
  `book` projects its catalog fields and shares into the R2 library
  snapshot, `catalog-head` privately points to that snapshot object, and
  `reading` projects its bookmarks into `reading-index`.
- `share_control` holds `share_{share_id_hash}` (which carries a plaintext
  `book_id` back-reference) and `path_{object_path_hash}`.
- `rate_limit_control` holds TTL'd `slot_...` and `nonce_...` entries,
  referenced by nothing else.
- R2 holds immutable owner EPUB/share copies and immutable catalog generations
  at random paths. `catalog-head` encrypts the current path and pins its ETag,
  length, and ciphertext digest.

## `owner_control`

Access: the fixed Fastly bootstrap route and offline administration only.

### `owner` entry

There is exactly one entry in this store holding owner identity, at key
`owner`.

```json
{
  "id": "owner",
  "kind": "owner",
  "schema_version": 1,
  "firebase_uid": "configured Firebase subject",
  "user_handle_hash": "base64url SHA-256 digest",
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "db_prefix": "52-character owner R2 prefix",
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

`owner_pk` is an opaque identity constant generated once at initialization. It
is not a partition key — KV Store has none — but an authenticated value
embedded in every encrypted envelope in this directory and checked after
decryption, so that ciphertext from a different deployment or environment
cannot be mistaken for this owner's data.

`sign_public_key` and `wrapped_sign_private_key` are the P-521
request-signing keypair described in [docs/crypto.md](../crypto.md). This
design does not use a signed session ticket; it uses this keypair for the
per-route possession proof defined in [cryptography.md](cryptography.md) and
required by [auth_api.md](auth_api.md) on every route whose abuse is not
self-contained. `sign_public_key` is not secret; Fastly reads it on every
proof check the same way it reads any other owner-entry field.

The encrypted credential plaintext is versioned and contains:

```json
{
  "version": 1,
  "user_handle": "base64url 32 bytes",
  "display_name": "owner display name",
  "vault_master_key": "base64url 128 bytes",
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "db_prefix": "52-character owner R2 prefix"
}
```

`vault_master_key` is 128 bytes of key material used as the IKM for every
encrypted KV Store entry and R2 object in this directory. `db_prefix` scopes
owner EPUB, catalog, and shared R2 objects. The decrypted `vault_id`,
`owner_pk`, and `db_prefix` must match the authenticated values or hashes
returned by Fastly before the browser accepts a session.

`db_prefix` is plaintext operational routing metadata. Fastly must know it to
construct and authorize owner R2 keys and to bind possession proofs; a
client-supplied prefix is never trusted. It is random rather than user
metadata, must never be logged, and must match both `vault_binding_hash` and
the decrypted credential value. The owner entry contains no plaintext
`user_handle` or display name. It is
safe for Fastly to return the wrapped/encrypted fields from `/v1/keys`, but
the entry itself remains server-only.

### Schema and migration markers

Every store carries its own schema/migration marker key so `/health/ready`
can validate all four independently:

```text
owner_control:      schema_owner-control
vault:              schema_vault
share_control:      schema_share-control
rate_limit_control: schema_rate-limit-control
```

```json
{
  "kind": "schema",
  "version": 1,
  "updated_at": 1787356800000
}
```

Migration marker keys follow the same convention, for example
`migration_initial-import_v1`. Only the deployment migrator may write these
keys. Runtime startup fails readiness if the supported and stored versions
differ in any store.

## `vault`

Access: fixed Fastly vault routes and offline administration only. No browser
credential can access this store.

### `{book_id}` entry

One entry holds a book's near-immutable identity — its content locator and
owner-side share state — together with its catalog metadata, so that ingest
and delete each require exactly one vault write.

```json
{
  "id": "book_K7c3...",
  "kind": "book",
  "schema_version": 1,
  "record_version": 5,
  "ciphertext": "base64url canonical authenticated blob",
  "updated_at": 1787356800000
}
```

`id` is a randomly generated, stable opaque identifier (`book_` followed by at
least 256 bits of random data, canonically encoded), also used to derive the
KV key exactly as-is. Do not prepend `book_` a second time: the ID already
supplies the `book_` prefix used by scans. `record_version` is incremented
inside and outside the ciphertext on every accepted mutation; the values must
match after decryption. It aids diagnosis but does not replace the KV Store
`generation` for concurrency.

`ciphertext` decrypts to the vault entry envelope
([cryptography.md](cryptography.md)):

```json
{
  "purpose": "txt:book",
  "envelope_version": 1,
  "container_role": "vault",
  "owner_pk": "own_opaqueRandomValue",
  "vault_id": "vault_opaqueRandomValue",
  "item_id": "book_K7c3...",
  "kind": "book",
  "record": {
    "schema_version": 1,
    "record_version": 5,
    "book_id": "book_K7c3...",
    "created_at": 1787184000000,
    "content": {
      "txt_key": "base64url 128 bytes",
      "txt_prefix": "base64url 32 bytes",
      "path": "base64url 32 bytes",
      "object_etag": "opaque R2 validator",
      "object_length": 12345,
      "ciphertext_sha256": "base64url SHA-256"
    },
    "catalog": {
      "name": "original.epub",
      "title": "Title",
      "authors": ["Author"],
      "subjects": ["Subject"],
      "publisher": "Publisher"
    },
    "shares": [
      {
        "share_id": "base64url 32 bytes",
        "share_content_key": "base64url 128 bytes",
        "share_prefix": "base64url 32 bytes",
        "share_path": "base64url 32 bytes",
        "object_etag": "opaque R2 validator",
        "object_length": 12345,
        "ciphertext_sha256": "base64url SHA-256",
        "state": "active",
        "created_at": 1787356800000,
        "sequence": 2
      }
    ],
    "next_share_sequence": 3
  }
}
```

After decryption, the browser or CLI applies these validation rules for
`record` in addition to [cryptography.md](cryptography.md)'s envelope binding
checks. Fastly can validate only the outer entry:

- content and share locators are validated before interpolating an R2 key;
- object ETags are treated as opaque bounded quoted validators; lengths and
  SHA-256 digests must match the exact R2 bytes before decryption;
- catalog fields keep the accepted types and limits used at ingestion, and
  `publisher` may be `null`;
- share state is exactly `creating`, `active`, or `deleting`; and
- a book cannot be deleted while `shares` is non-empty.

A pre-upload `creating` share may carry `null` object ETag/length/digest. After
upload, the client must persist all three while the state remains `creating`
before calling `POST /v1/shares`; `active` and `deleting` shares require them
and never change them.

Editing catalog metadata, changing a content locator, and creating/removing a
share all replace this same entry and republish the snapshot; none of them
touch reading state.

### `reading_{book_id}` entry

Reading position and bookmarks are the highest-frequency mutation associated
with a book — a qualifying read updates `last_accessed` once per session, a
visible relocation debounces `last_cfi` roughly every 15 seconds while
actively reading, and bookmarks are added and removed independently of both.
Keeping this in its own entry means none of that ever rewrites a book's
content locator, catalog metadata, or share state.

```json
{
  "kind": "reading",
  "schema_version": 1,
  "book_id": "book_K7c3...",
  "ciphertext": "base64url canonical authenticated blob",
  "updated_at": 1787356800000
}
```

`ciphertext` decrypts to the same vault entry envelope shape as a `book`
entry ([cryptography.md](cryptography.md)), with `item_id` equal to
`book_id` and `kind: "reading"`:

```json
{
  "purpose": "txt:reading-state",
  "envelope_version": 1,
  "container_role": "vault",
  "owner_pk": "own_opaqueRandomValue",
  "vault_id": "vault_opaqueRandomValue",
  "item_id": "book_K7c3...",
  "kind": "reading",
  "record": {
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
}
```

Validation rules for `record`: `last_accessed` is `0` until the first
qualifying read and
otherwise Unix milliseconds; `last_cfi` may be `null`; bookmark uniqueness is
`(book_id, cfi)`; previews are normalized and capped at 100 UTF-8 bytes; a
book has at most 20 bookmarks, evicting the lowest `sequence` when the cap is
exceeded; `page_number` is optional display metadata, never a bookmark
identity. `book_id` is an authenticated back-reference: it lets any UI
surface that lists reading state across the library (recently-read,
all-bookmarks) open the correct book without a second lookup, and it lets
validation reject a reading-state entry copied onto the wrong book's key,
mirroring the outer/inner identity binding used everywhere else in this
design.

This entry is written through the dedicated Fastly route in
[auth_api.md](auth_api.md), created with a create-only write and thereafter
overwritten conditionally on its previous `generation`. A conflict means
another tab or device wrote first: read the current entry, reapply the same
semantic mutation, and retry. Fastly first verifies that the matching book
exists. The create requires a possession proof and durable admission slot;
conditional replacement is proof-exempt because it is confined to one
existing book's rebuildable state. Deletion after a book is removed requires
proof and the last reading generation; absence is idempotent success.

### `reading-index` entry

The library screen needs one cheap way to sort by "recently read" and show
bookmarks for the whole library — including a surface that lists every
bookmark across every book — without a per-book fetch for each one. One small
entry aggregates exactly that, and only that, across every book:

```json
{
  "kind": "reading-index",
  "schema_version": 1,
  "ciphertext": "base64url canonical authenticated blob",
  "updated_at": 1787356800000
}
```

`ciphertext` decrypts to the same vault entry envelope shape, with
`item_id: "reading-index"` and `kind: "reading-index"`:

```json
{
  "purpose": "txt:reading-index",
  "envelope_version": 1,
  "container_role": "vault",
  "owner_pk": "own_opaqueRandomValue",
  "vault_id": "vault_opaqueRandomValue",
  "item_id": "reading-index",
  "kind": "reading-index",
  "record": {
    "entries": [
      {
        "book_id": "book_K7c3...",
        "last_accessed": 1787356800000,
        "bookmarks": [
          {
            "cfi": "epubcfi(...)",
            "page_number": 12,
            "preview": "normalized UTF-8 preview",
            "created_at": 1787356800000,
            "sequence": 4
          }
        ]
      }
    ]
  }
}
```

Each entry's `bookmarks` array is the same complete array carried in that
book's `reading_{book_id}` entry — not a count. A bookmark-count badge is
just `bookmarks.length`; a library-wide bookmarks view renders directly from
this one entry instead of fetching every book's reading entry individually.

`last_cfi` is deliberately excluded, and for a reason that is about write
frequency, not read convenience: opening a book always fetches its own
`reading_{book_id}` entry directly ([catalog.md](catalog.md)'s initial-load
and open-book steps), so the index is never consulted to find a CFI, and
excluding `last_cfi` costs nothing on the read side. `last_accessed` changes
once per reading session (at the six-second qualification moment) and
`bookmarks` changes only when the owner explicitly adds or removes one, but
`last_cfi` changes on every 15-second debounced relocation while actively
reading — by far the highest-frequency field in the entire system. Because
this index is one entry covering every book, writing it at all means
rewriting the complete `entries` array regardless of which book changed; a
reading-state write therefore updates this index **only when `last_accessed`
first qualifies for the session or `bookmarks` changes**, never on a
CFI-only debounce. This is the specific Class A operation saving described
in [README.md](README.md#capacity-target): most debounced writes during a
reading session cost exactly one KV write (`reading_{book_id}` alone), not
two.

Like the catalog snapshot, the index is a **derived, rebuildable
accelerator** — never the sole copy of anything. Unlike the catalog
snapshot, it never has a "generation" field of its own inside the ciphertext
or an owning pointer elsewhere: it is simply the latest successfully-written
entry at that fixed key, rebuildable at any time by paging the fixed Fastly
book scan and reading each book's own reading entry.

The index uses its own proof-required `PUT /v1/vault/reading-index` route. The
client writes authoritative per-book reading state first and this derived
entry second. An index failure is retried independently and never rolls back
or replays the successful reading-state mutation.

### `catalog-head` entry

The catalog head keeps its object key encrypted while exposing only the
operational metadata needed for conditional publication and integrity checks:

```json
{
  "kind": "catalog-head",
  "schema_version": 2,
  "snapshot_generation": 184,
  "object_etag": "opaque R2 validator",
  "object_length": 12345,
  "ciphertext_sha256": "base64url SHA-256",
  "ciphertext": "base64url encrypted catalog-head-pointer envelope",
  "updated_at": 1787356800000
}
```

The ciphertext decrypts with `vault_master_key` to:

```json
{
  "purpose": "txt:catalog-head-pointer",
  "envelope_version": 1,
  "container_role": "vault",
  "owner_pk": "own_opaqueRandomValue",
  "vault_id": "vault_opaqueRandomValue",
  "item_id": "catalog-head",
  "kind": "catalog-head-pointer",
  "record": {
    "object_key": "{db_prefix}/catalog/random"
  }
}
```

Fastly stores that ciphertext opaquely. A commit supplies the same object key
transiently so Fastly can validate its stored owner prefix/random grammar and
direct-HEAD R2; the key is never persisted in plaintext. Only the browser/CLI
can require equality between that transient construction and the decrypted
pointer on the next load.

`snapshot_generation` increases by exactly one per publication. It is a
logical counter, not a timestamp, and is distinct from KV Store's opaque
per-item `generation` used for conditional writes. Before committing a head,
Fastly requires a direct uncached R2 HEAD of the transiently supplied key to
match the exact ETag, length, and `x-amz-meta-txt-sha256`. The client
additionally computes the digest over downloaded ciphertext, then authenticates
the encrypted snapshot's matching inner generation, owner, vault, and random
key.

The empty library still has a valid head and an encrypted snapshot envelope
whose `books` member is `[]`; absence of `catalog-head` is an initialization
or corruption error.

Catalog metadata edits, ingest, delete, content-locator changes, and share
state changes all advance `snapshot_generation`. Reading-state and bookmark
mutations never do — see [catalog.md](catalog.md) for the exact republish list.

## `share_control`

Access: fixed Fastly share routes and offline administration only.

### `share_{share_id_hash}` entry

```json
{
  "id": "share_{share_id_hash}",
  "kind": "share",
  "schema_version": 1,
  "share_id_hash": "base64url SHA-256",
  "object_path_hash": "base64url SHA-256",
  "object_etag": "opaque R2 validator",
  "object_length": 12345,
  "ciphertext_sha256": "base64url SHA-256",
  "book_id": "book_K7c3...",
  "state": "active",
  "created_at": 1787356800000,
  "updated_at": 1787356800000
}
```

`book_id` is a plaintext back-reference to the owning book. It carries no
confidential information — it is already returned in plaintext by every
authenticated vault route — and it lets the administration CLI look up which
book a share belongs to directly, instead of decrypting every book entry in
the library to find a hash match during reconciliation (see
[sharing.md](sharing.md)).

Only `active` entries may produce a shared URL. The raw share identifier and
R2 path are carried in the authenticated share grant, not stored in plaintext
control entries. The ETag/length/digest are nonsensitive integrity metadata;
Fastly pins the ETag in a shared GET URL, and the recipient compares all three
with the fragment before AEAD decryption.

### `path_{object_path_hash}` entry

```json
{
  "id": "path_{object_path_hash}",
  "kind": "share-path-reservation",
  "schema_version": 1,
  "share_id_hash": "base64url SHA-256",
  "object_path_hash": "base64url SHA-256",
  "created_at": 1787356800000
}
```

Create the path reservation first, then the share entry, both as create-only
writes, so that the exact R2 path a share resolves to is reserved before the
share itself becomes visible. A failure between the two steps leaves a
reservation with no matching share. An exact retry point-reads that matching
share/path-hash reservation and continues with the create-only share write; it
does not wait for cleanup or create another reservation. If the share already
exists, exact active state, `book_id`, hashes, and ETag/length/digest are the
idempotent-retry case described in [auth_api.md](auth_api.md) `POST /v1/shares`
(return a fresh grant, no write).

Administrative reconciliation may remove a reservation with no share only
after a short grace period and a second absence check. A different path hash
for the same share hash or a `deleting` counterpart is a genuine conflict.
Deletion updates `active` to `deleting`, deletes the R2 object, then deletes
both entries, path reservation last so an interrupted delete never leaves a
share with no reservation.

## `rate_limit_control`

Access: Fastly limiter code and offline administration only. Every slot and
nonce entry is written with a KV Store TTL slightly longer than the window or
proof it guards; KV Store TTL is a garbage-collection guarantee, not a precise
expiry, so never rely on TTL alone to make an expired value unreadable a
security boundary — the application field below is authoritative for that.

```json
{
  "id": "slot_owner-keys_{subject_hash}_1787356800_0042",
  "kind": "rate-limit-slot",
  "scope": "owner-keys",
  "subject_hash": "base64url HMAC-SHA-256",
  "window_start": 1787356800,
  "slot": 42,
  "expires_at": 1787360405
}
```

A window with limit `N` has exactly `N` possible slot keys, numbered with a
fixed-width decimal suffix. Fastly selects a CSPRNG-random starting slot and
walks the ring, claiming candidates with a create-only write. The first
successful create admits the request; an already-existing candidate advances
to the next slot; all `N` occupied means 429. There is no read-modify-write
counter and every accepted request mutates a distinct item exactly once, so
the design respects Fastly's one-write-per-second-per-item limit. The
create-only precondition, not an eventually consistent lookup, decides
admission under concurrency. Cap `N` at 120; a small in-instance precheck and
negative cache protect a full window from repeated full-ring probe
amplification. Provider throttling or an indeterminate create fails closed
with 503, never by treating it as an occupied slot.

Only after Firebase verification may an owner UID select its slot ring. For
the public route, validate the cryptographic capability before touching the
single deployment-global durable ring. A best-effort in-instance IP counter
runs before expensive authentication. Keeping IP out of durable ring identity
prevents rotating-source multiplication of Class A writes; the global cap is
the free-tier cost boundary.

This store also holds single-use possession-proof nonces (`kind: "nonce"`),
created with a create-only write and a TTL just past the proof's expiry; see
[cryptography.md](cryptography.md) and [auth_api.md](auth_api.md) for the
proof this defends and for the eventual-consistency caveat that applies to
it.

## R2 object layout

```text
{db_prefix}/{txt_prefix}/{path}                       owner EPUB
{db_prefix}/catalog/{random}                          immutable library snapshot
{db_prefix}/shared/{share_prefix}/{share_path}        shared EPUB copy
{db_prefix}/exports/{timestamp}-{random}.blob         optional control/data export
```

Every object is immutable and created with `If-None-Match: *`. A catalog
publication chooses a fresh random segment and never overwrites another
generation. Reading state, bookmarks, and authoritative mutable owner records
live in KV Store.

The cleaner constructs the live set from all decrypted vault book entries, the
decrypted current catalog-head pointer, active/deleting server share entries,
and retained exports. Superseded/failed catalog objects are unreferenced
cleanup candidates after the safety age; no older catalog generation is
treated as live. It never infers liveness from an R2 listing alone.
