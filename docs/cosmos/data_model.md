# Cosmos and R2 data model

All binary fields in JSON use unpadded base64url. Persisted timestamps use
nonnegative Unix milliseconds, matching the current SQL/rqlite representation;
protocol fields explicitly named as Unix seconds remain seconds. Item IDs and
partition values use ASCII opaque identifiers and must not contain user
metadata. Clients must reject unknown required schema versions rather than
guessing.

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
not be combined. In particular, no control item may be moved into `vault`,
because the owner browser has `All` permission within its vault partition.

## `owner_control`

Partition key: `/owner_pk`. Access: Northflank and offline administration only.

### Owner item

There is exactly one owner item. Northflank point-reads it using configured
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
  "signing_public_key": "base64url P-521 public key",
  "wrapped_signing_private_key": "base64url",
  "encrypted_credentials": "base64url",
  "created_at": 1787356800000,
  "updated_at": 1787356800000
}
```

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
and shared R2 objects. The decrypted `vault_id`, `owner_pk`, and `db_prefix`
must match the authenticated values or hashes returned by Northflank before the
browser accepts a session.

The control item contains no plaintext `user_handle` or display name. It is
safe for Northflank to return the wrapped/encrypted fields from `/v1/keys`, but
the item itself remains server-only.

### Schema and migration items

Control schema markers use partition `system` and deterministic IDs such as
`schema:owner-control` and `migration:sqlcipher-to-cosmos:v1`:

```json
{
  "id": "schema:owner-control",
  "owner_pk": "system",
  "kind": "schema",
  "version": 1,
  "updated_at": 1787356800000
}
```

Only the deployment migrator may advance these markers. Runtime startup fails
readiness if the supported and stored versions differ.

## `vault`

Partition key: `/owner_pk`. Access: Northflank/offline administration plus a
short-lived native resource token with `All` permission scoped to exactly the
configured owner partition.

All of the owner's items deliberately share one logical partition. This makes
book-and-head publication transactional and makes the delegated permission
unambiguous. Alert well before this partition approaches Cosmos's logical
partition storage limit.

### Encrypted book aggregate

One item holds all mutable owner state for one book:

```json
{
  "id": "book_K7c3...",
  "owner_pk": "own_opaqueRandomValue",
  "kind": "book",
  "schema_version": 1,
  "record_version": 37,
  "ciphertext": "base64url SQLCipher-VLE envelope",
  "updated_at": 1787356800000
}
```

`id` is a randomly generated, stable opaque identifier. `record_version` is
incremented inside and outside the ciphertext on every accepted mutation; the
values must match after decryption. It aids diagnosis but does not replace
Cosmos `_etag` concurrency. `updated_at` is informational and cannot authorize
or order writes.

The decrypted canonical JSON payload is:

```json
{
  "schema_version": 1,
  "record_version": 37,
  "book_id": "book_K7c3...",
  "created_at": 1787184000000,
  "catalog": {
    "name": "original.epub",
    "title": "Title",
    "authors": ["Author"],
    "subjects": ["Subject"],
    "publisher": "Publisher"
  },
  "content": {
    "txt_key": "base64url 128 bytes",
    "txt_prefix": "base64url 32 bytes",
    "path": "base64url 32 bytes"
  },
  "reading": {
    "last_accessed": 1787356800000,
    "last_cfi": "epubcfi(...)"
  },
  "bookmarks": [
    {
      "cfi": "epubcfi(...)",
      "page_number": 12,
      "preview": "normalized UTF-8 preview",
      "created_at": 1787356800000,
      "sequence": 4
    }
  ],
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
  "next_bookmark_sequence": 5,
  "next_share_sequence": 3
}
```

Validation preserves the current rules:

- catalog fields have the same accepted types and limits as ingestion today;
- `publisher` may be `null`;
- `last_accessed` is `0` until the first qualifying read and otherwise is Unix
  milliseconds; `last_cfi` may be `null`;
- bookmark uniqueness is `(book_id, cfi)`;
- bookmark previews are normalized and capped at 100 UTF-8 bytes;
- a book has at most 20 bookmarks, evicting the lowest `sequence` when the cap
  is exceeded;
- `page_number` is optional display metadata, never a bookmark identity;
- share state is exactly `creating`, `active`, or `deleting`;
- content and share locators are validated before interpolating an R2 key; and
- a book cannot be deleted while `shares` is non-empty.

Keeping dependent rows in one encrypted aggregate makes these rules atomic and
avoids client queries over encrypted columns. A record must remain well below
Cosmos's item-size limit; reject writes once encoded item size exceeds a
configured safety threshold, default 1.5 MiB.

### Catalog head

The only non-book item in the owner partition is a pointer to the current
immutable library snapshot:

```json
{
  "id": "catalog-head",
  "owner_pk": "own_opaqueRandomValue",
  "kind": "catalog-head",
  "schema_version": 1,
  "generation": 184,
  "object_key": "{db_prefix}/catalog/184-random.json.br.vle",
  "ciphertext_sha256": "base64url 32 bytes",
  "ciphertext_bytes": 91842,
  "book_count": 713,
  "created_at": 1787356800000
}
```

The pointer metadata is not confidential. Its integrity and concurrency come
from authenticated Cosmos transport, scoped authorization, `_etag`, and the
snapshot AEAD/hash checks. `generation` increases by one for every snapshot
publication. It is not a timestamp.

The empty library still has a valid head and an encrypted snapshot containing
`[]`; absence of `catalog-head` is an initialization or corruption error.

## `share_control`

Partition key: `/registry_pk`. Access: Northflank and offline administration
only. Every item uses `registry_pk: "shares"` so a registration or deletion can
be a single-partition transactional batch.

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
cross-partition unique-key assumption. Deletion updates `active` to `deleting`,
deletes R2, then transactionally removes both items.

## `rate_limit_control`

Partition key: `/bucket_pk`. Access: Northflank and offline administration only.
Configure container TTL and set a per-item `ttl` slightly longer than its
window.

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

Northflank consumes a slot atomically: create the item with count 1, or on
conflict use conditional PATCH to increment only while `count < limit`. A
concurrent precondition failure is treated as limited and may be retried only
after a fresh point read. Cosmos unavailability fails closed for protected
operations. The in-process limiter may reject obvious floods early, but this
container is authoritative across replicas and restarts.

## Index policies

Use minimal explicit indexing. Cosmos automatically supports point reads by ID
and partition key; ciphertext and most value metadata do not need indexes.

- `owner_control`: include `/kind/?`, `/firebase_uid/?`, and `/schema_version/?`;
  exclude wrapped/encrypted binary fields.
- `vault`: include `/kind/?`, `/schema_version/?`, and `/generation/?`; exclude
  `/ciphertext/?`. Runtime book access is always a point read.
- `share_control`: include `/kind/?`, `/state/?`, and hash fields; most runtime
  operations are point reads or same-partition batches.
- `rate_limit_control`: point reads only; exclude all paths except required
  system paths and the partition key.

Validate the exact policy and measured RU cost in a staging account before
production. Do not enable broad indexing merely to inspect encrypted data.

## R2 object layout

```text
{db_prefix}/{txt_prefix}/{path}                       owner EPUB
{db_prefix}/catalog/{generation}-{random}.json.br.vle library snapshot
{db_prefix}/shared/{share_prefix}/{share_path}        shared EPUB copy
{db_prefix}/exports/{timestamp}-{random}.json.br.vle  optional control/data export
```

The former top-level `{db_path}` SQLCipher object and rqlite backup prefix are
not part of the target layout. Existing owner and share EPUB object paths stay
unchanged during migration. New catalog and export objects are immutable and
uploaded with `If-None-Match: *`.

The cleaner constructs the live set from all decrypted vault book records,
the current and retained catalog heads, active/deleting server share records,
and retained exports. It never infers liveness from an R2 listing alone.
