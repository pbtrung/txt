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
`object-path`/`prefix` segments, possession-proof nonces, and any future
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

## The whole picture

Every section below shows one entry's complete shape: its outer, plaintext KV
fields, and — nested right below, not in a separate document — what its
`ciphertext` field decrypts to. Every `vault`-store entry's decrypted envelope
follows the exact same eight-field pattern (`purpose`, `envelope_version`,
`container_role`, `owner_pk`, `vault_id`, `item_id`, `kind`, `record`);
[cryptography.md](cryptography.md) defines that pattern and its validation
rules once, generically, rather than repeating it per entry.

```mermaid
flowchart TB
  subgraph LEGEND["How every vault ciphertext unwraps"]
    L1["KV entry: plaintext fields + ciphertext"] --> L2["envelope: purpose / envelope_version /<br/>container_role / owner_pk / vault_id / item_id / kind"]
    L2 --> L3["record: the entry's own fields, defined below"]
  end

  subgraph OC["KV Store: owner_control"]
    OWNER["owner"]
  end

  subgraph VAULT["KV Store: vault"]
    BOOK["book:{book_id}"]
    READING["reading:{book_id}"]
    RIDX["reading-index"]
    HEAD["catalog-head"]
  end

  subgraph SC["KV Store: share_control"]
    SHARE["share:{share_id_hash}"]
    PATH["path:{object_path_hash}"]
  end

  subgraph RLC["KV Store: rate_limit_control"]
    WINDOW["window:... (TTL)"]
    NONCE["nonce:... (TTL)"]
  end

  subgraph R2S["R2: immutable objects"]
    EPUB["owner EPUB"]
    SNAP["library snapshot"]
    SHCOPY["shared EPUB copy"]
  end

  BOOK ---|book_id| READING
  READING -.->|projects bookmarks into| RIDX
  BOOK -.->|projects catalog + shares into| SNAP
  HEAD -->|decrypted object_key names| SNAP
  BOOK -.->|content.path| EPUB
  BOOK -.->|shares[].share_path| SHCOPY
  SHARE -.->|book_id back-reference| BOOK
```

Solid arrows are same-book links; dashed arrows are a projection into a
derived object or a plaintext reference to another store. `owner_control` and
`rate_limit_control` have no outgoing arrows above because nothing else in
the system references them.

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

The owner entry contains no plaintext `user_handle` or display name. It is
safe for Fastly to return the wrapped/encrypted fields from `/v1/keys`, but
the entry itself remains server-only.

### Schema and migration markers

Every store carries its own schema/migration marker key so `/health/ready`
can validate all four independently:

```text
owner_control:      schema:owner-control
vault:              schema:vault
share_control:      schema:share-control
rate_limit_control: schema:rate-limit-control
```

```json
{
  "kind": "schema",
  "version": 1,
  "updated_at": 1787356800000
}
```

Migration marker keys follow the same convention, for example
`migration:initial-import:v1`. Only the deployment migrator may write these
keys. Runtime startup fails readiness if the supported and stored versions
differ in any store.

## `vault`

Access: fixed Fastly vault routes and offline administration only. No browser
credential can access this store.

### `book:{book_id}` entry

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
key `book:{id}`. `record_version` is incremented inside and outside the
ciphertext on every accepted mutation; the values must match after
decryption. It aids diagnosis but does not replace the KV Store `generation`
for concurrency.

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
      "path": "base64url 32 bytes"
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
        "state": "active",
        "created_at": 1787356800000,
        "sequence": 2
      }
    ],
    "next_share_sequence": 3
  }
}
```

Validation rules for `record` (envelope-level binding checks are in
[cryptography.md](cryptography.md)):

- content and share locators are validated before interpolating an R2 key;
- catalog fields keep the accepted types and limits used at ingestion, and
  `publisher` may be `null`;
- share state is exactly `creating`, `active`, or `deleting`; and
- a book cannot be deleted while `shares` is non-empty.

Editing catalog metadata, changing a content locator, and creating/removing a
share all replace this same entry and republish the snapshot; none of them
touch reading state.

### `reading:{book_id}` entry

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
semantic mutation, and retry.

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
book's `reading:{book_id}` entry — not a count. A bookmark-count badge is
just `bookmarks.length`; a library-wide bookmarks view renders directly from
this one entry instead of fetching every book's reading entry individually.

`last_cfi` is deliberately excluded, and for a reason that is about write
frequency, not read convenience: opening a book always fetches its own
`reading:{book_id}` entry directly ([catalog.md](catalog.md)'s initial-load
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
reading session cost exactly one KV write (`reading:{book_id}` alone), not
two.

Like the catalog snapshot, the index is a **derived, rebuildable
accelerator** — never the sole copy of anything. Unlike the catalog
snapshot, it never has a "generation" field of its own inside the ciphertext
or an owning pointer elsewhere: it is simply the latest successfully-written
entry at that fixed key, rebuildable at any time by paging the fixed Fastly
book scan and reading each book's own reading entry.

### `catalog-head` entry

The only vault entry that is not a `book`, `reading`, or `reading-index` entry
is a pointer to the current immutable library snapshot:

```json
{
  "kind": "catalog-head",
  "schema_version": 1,
  "generation": 184,
  "ciphertext": "base64url canonical authenticated blob",
  "created_at": 1787356800000
}
```

`ciphertext` decrypts to the same eight-field vault entry envelope as every
other entry in this store ([cryptography.md](cryptography.md)), but unlike a
`book` or `reading` entry, its `record` holds only the R2 object key, not a
complete application record:

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

This is encrypted client-side with `vault_master_key` before it is sent to
Fastly. Fastly never learns the plaintext object key from this entry; it
only ever sees one transiently, as a request field, when it needs to perform
the R2 existence check described below. Keeping it wrapped at rest means a
KV Store leak, log capture, or mishandled administrative export cannot
reveal `db_prefix` or the snapshot object-naming pattern through this entry.

The `generation` field is plaintext — a bare counter carries no owner
information worth hiding — and increases by one for every snapshot
publication; it is a counter, not a timestamp, and is distinct from the KV
Store `generation` marker on the `catalog-head` key itself. Its integrity and
concurrency come from route authorization and the KV Store `generation`
marker — **and**, before Fastly accepts a new pointer, a direct R2 existence
check against the object the request names (see [auth_api.md](auth_api.md)
`/v1/vault/commit`). There is no separate persisted length or hash to check
against: the canonical blob's own AEAD authentication is what detects a
corrupted or truncated object, at decrypt time on the next load.

The empty library still has a valid head and an encrypted snapshot envelope
whose `books` member is `[]`; absence of `catalog-head` is an initialization
or corruption error.

Catalog metadata edits, ingest, delete, and share state changes all advance
the pointer's `generation` field. Reading-state and bookmark mutations never
do — see [catalog.md](catalog.md) for the exact republish list.

## `share_control`

Access: fixed Fastly share routes and offline administration only.

### `share:{share_id_hash}` entry

```json
{
  "id": "share:{share_id_hash}",
  "kind": "share",
  "schema_version": 1,
  "share_id_hash": "base64url SHA-256",
  "object_path_hash": "base64url SHA-256",
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
control entries.

### `path:{object_path_hash}` entry

```json
{
  "id": "path:{object_path_hash}",
  "kind": "share-path-reservation",
  "schema_version": 1,
  "share_id_hash": "base64url SHA-256",
  "object_path_hash": "base64url SHA-256",
  "created_at": 1787356800000
}
```

Create the path reservation first, then the share entry, both as create-only
writes, so that the exact R2 path a share resolves to is reserved before the
share itself becomes visible. A failure between the two steps leaves an
orphan reservation with no matching share; on the next attempt, or during
administrative reconciliation, Fastly point-reads both entries: identical
`object_path_hash` on both is the idempotent-retry case described in
[auth_api.md](auth_api.md) `POST /v1/shares` (return a fresh grant, no
write); a reservation with no matching share and an age past a short grace
period is a safe-to-remove orphan; any other combination — a different
`object_path_hash` for the same `share_id_hash`, or a `deleting`/absent
counterpart — is the genuine 409. Deletion updates `active` to `deleting`,
deletes the R2 object, then deletes both entries, path reservation last so an
interrupted delete never leaves a share with no reservation.

## `rate_limit_control`

Access: Fastly limiter code and offline administration only. Every window and
nonce entry is written with a KV Store TTL slightly longer than the window or
proof it guards; KV Store TTL is a garbage-collection guarantee, not a precise
expiry, so never rely on TTL alone to make an expired value unreadable a
security boundary — the application field below is authoritative for that.

```json
{
  "id": "window:owner-keys:{subject_hash}:1787356800",
  "kind": "rate-limit",
  "scope": "owner-keys",
  "subject_hash": "base64url HMAC-SHA-256",
  "window_start": 1787356800,
  "count": 1,
  "limit": 60
}
```

Fastly consumes a slot with a read-modify-write loop: read the window entry
(or its absence) and its `generation`, then create it with count 1 or
conditionally overwrite it with count incremented, using `if_generation_match`
against the value just read. A generation mismatch means a concurrent request
won the same window; re-read and retry, capped at a small number of attempts,
treating exhaustion as rate-limited. KV Store unavailability fails closed for
protected operations. Any pre-verification flood control (before a Firebase
token is checked at all) must use a subject-independent bucket — normalized
client IP or a global counter, never one keyed by an unverified token claim —
so an attacker who does not hold a validly signed token cannot consume the
owner-specific budget; see [auth_api.md](auth_api.md) for the exact ordering.

This store also holds single-use possession-proof nonces (`kind: "nonce"`),
created with a create-only write and a TTL just past the proof's expiry; see
[cryptography.md](cryptography.md) and [auth_api.md](auth_api.md) for the
proof this defends and for the eventual-consistency caveat that applies to
it.

## R2 object layout

```text
{db_prefix}/{txt_prefix}/{path}                       owner EPUB
{db_prefix}/catalog/{random}                          library snapshot
{db_prefix}/shared/{share_prefix}/{share_path}        shared EPUB copy
{db_prefix}/exports/{timestamp}-{random}.blob         optional control/data export
```

The snapshot's object name carries only a random component, not the
generation number — the generation is already available, in plaintext, on
the `catalog-head` entry itself, and repeating it in the object key would
leak publish cadence to anyone who could see the wrapped pointer's ciphertext
length change over time without buying anything else.

Every object in this layout is immutable and uploaded with `If-None-Match: *`;
reading state, bookmarks, and every other mutable owner value live in KV
Store, not R2.

The cleaner constructs the live set from all decrypted vault book entries, the
current and retained catalog heads, active/deleting server share entries, and
retained exports. It never infers liveness from an R2 listing alone.
