# Encrypted library snapshot and local search

The initial library screen must not point-read and decrypt every Cosmos book
record. Instead it downloads one immutable encrypted structured-payload blob
from R2. Cosmos stores only the current object pointer in `catalog-head`.

The snapshot is a derived projection. Encrypted Cosmos book aggregates remain
authoritative and are sufficient to rebuild it.

## Snapshot schema

The decrypted canonical JSON is the authenticated catalog envelope from
[cryptography.md](cryptography.md):

```json
{
  "purpose": "txt:cosmos-catalog",
  "envelope_version": 1,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "generation": 184,
  "object_key": "{db_prefix}/catalog/184-random.blob",
  "snapshot_schema_version": 1,
  "books": []
}
```

`books` is sorted by `book_id` bytewise. Each member is:

```json
{
  "schema_version": 1,
  "book_id": "book_K7c3...",
  "record_version": 37,
  "catalog": {
    "name": "original.epub",
    "title": "Title",
    "authors": ["Author"],
    "subjects": ["Subject"],
    "publisher": "Publisher"
  },
  "last_accessed": 1787356800000,
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
  ]
}
```

The encrypted projection deliberately includes bookmark and owner-side share
metadata needed by the existing library/share UI, so initial rendering remains
one object load. It excludes the EPUB `txt_key`, owner content path, and
`last_cfi`; opening a book point-reads its authoritative row before content is
fetched. Although share secrets are duplicated in the projection, they remain
under the same end-to-end `vault_master_key` and never appear in the Cosmos
pointer or server logs.

Every envelope field must match the authenticated owner bootstrap and
`catalog-head`. Every projected value is validated using the same rules as its
source book record. Duplicate book IDs, bookmark CFIs, share IDs, unsupported
versions, or a count different from `catalog-head.book_count` make the entire
snapshot invalid.

## Initial load

After `/v1/keys`, local unwrapping, and `/v1/r2-token`:

1. Call `GET /v1/vault/head`; Fastly point-reads `catalog-head` from the fixed
   owner `vault` partition.
2. Look up encrypted snapshot bytes in IndexedDB by
   `(object_key, ciphertext_sha256, ciphertext_bytes)`.
3. If absent, GET the exact object with temporary R2 credentials. Do not list
   the bucket and do not use range requests; compression and AEAD require the
   complete object.
4. Verify byte length and SHA-256 before decryption.
5. Decrypt using the canonical structured-payload procedure from
   [docs/crypto.md](../crypto.md), parse canonical JSON with duplicate-key
   rejection, verify all envelope/head fields, and validate every entry.
6. Keep the plaintext projection and search index only in memory. IndexedDB
   stores ciphertext and verified pointer metadata, never plaintext or session
   credentials.
7. Render the current library ordering, bookmark summaries, and share state,
   and build the existing local full-text index over `name`, `title`,
   `authors`, `subjects`, and `publisher`.

Search behavior remains client-side, offline after unlock/cache load, and
independent of Cosmos indexing. Queries, tokens, normalized terms, and result
sets never reach Fastly or Cosmos.

Opening a search result calls the fixed Fastly book route, decrypts the matching
book aggregate, checks its `record_version` against the projection, and fetches
the immutable EPUB. If versions differ, treat the row as authoritative and
schedule snapshot repair rather than showing stale share or bookmark state.

## Which mutations republish the snapshot

Republish when any projected field changes:

- ingest, replace-as-new, or delete a book;
- edit catalog metadata;
- first qualified reading access that changes `last_accessed`;
- clear `last_accessed`;
- add, update, remove, or clear a bookmark; or
- create, activate, mark deleting, or remove a share.

Later qualified relocation updates that change only `last_cfi` update the book
row without publishing a snapshot. Preserve current reader semantics:

- require six seconds of visible reading before a session qualifies;
- retain candidate CFI only before qualification;
- after qualification, persist `last_accessed` and the latest CFI;
- debounce owner relocation by two seconds and write at most every 15 seconds;
- perform the final qualified flush on hidden, book switch, or reader close;
- keep a failed semantic mutation as visibly unsaved and retryable.

## Atomic publication protocol

Cross-service transactions do not exist, so publication orders R2 and Cosmos
to guarantee that an accepted head never points to an object that was not
uploaded.

For one semantic mutation:

1. Start from the currently decrypted book row and snapshot identified by the
   opaque Cosmos `_etag` values returned through Fastly.
2. Apply a pure, replayable mutation to produce the next book record and
   projection. Increment the book `record_version` and head `generation`.
3. Build the authenticated catalog envelope, canonically serialize it, Encrypt
   it with the canonical structured-payload procedure, and SHA-256 hash the raw
   blob as defined in [cryptography.md](cryptography.md).
4. Upload it to a new random immutable R2 object with `If-None-Match: *`.
5. Call `POST /v1/vault/commit`. Fastly validates the outer items and submits a
   Cosmos transactional batch in the one owner partition containing:
   - create/replace/delete of the affected book item, with its expected `_etag`
     where applicable; and
   - replace of `catalog-head` with its expected `_etag` and the new pointer.
6. Treat success of the full batch as the commit point. Update in-memory state
   and cache the encrypted snapshot.

The batch contains at most two operations for interactive mutations, well
within Cosmos batch limits. Cosmos provides ACID behavior for a transactional
batch within one logical partition. Optimistic concurrency and `_etag`
behavior are described in the official
[transactional batch](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch)
and [optimistic concurrency](https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/database-transactions-optimistic-concurrency)
documentation.

If the R2 upload fails, Cosmos is untouched. If the upload succeeds but the
batch fails, the new object is an unreferenced orphan and the previous head
remains valid.

## Conflict replay

On `409 conflict` from Fastly after a Cosmos precondition failure:

1. Refetch the winning `catalog-head` and affected book row through Fastly.
2. Load and validate the winning snapshot.
3. Reapply the original semantic mutation, not a byte-level overwrite.
4. Upload a new generation to a new immutable key.
5. Retry the conditional batch.

Match the current store's limit of three automatic attempts. Newly uploaded
losing generations remain safe orphans for cleanup. After the third conflict,
retain the mutation as unsaved, surface a recoverable error, and never silently
discard or overwrite another device's update.

Serialization is per browser tab. Cross-tab coordination uses the existing
browser locking mechanism where supported, but `_etag` remains authoritative
across tabs, devices, and CLI writers.

For a `last_cfi`-only mutation, call the conditional Fastly single-book replace
route. A conflict still replays the semantic relocation against the latest
decrypted book. It must not overwrite newer bookmarks, shares, catalog, or
content fields.

## Cache and offline behavior

- Cache only verified ciphertext and nonsensitive pointer metadata.
- Key cache entries by ciphertext hash, not merely generation.
- Keep at least the current and immediately previous verified snapshot locally
  until the current one has decrypted successfully.
- A cached snapshot may render while offline only after the user supplies the
  root key and it authenticates. Mutations remain queued/unsaved until both
  Cosmos and R2 are available.
- Never let a service worker cache `/v1/keys`, `/v1/r2-token`, any `/v1/vault/*`
  route, grants, signed URLs, or credential-bearing responses.

## Repair and rebuild

If the current snapshot is missing, corrupt, fails AEAD/schema validation, or
contains a row version mismatch:

1. retain the failed head/object for diagnosis without exposing plaintext;
2. page through Fastly's fixed authenticated owner-book scan; never submit
   client query text;
3. decrypt each canonical blob and validate its inner envelope against the
   outer row;
4. sort and build a fresh projection;
5. publish a new immutable generation using an `_etag` condition on the head;
6. retry on a concurrent winner and accept the winner if it validates.

This is the only normal path that scans vault rows. The browser may offer it as
an explicit repair action; the administration CLI also implements it. A row
that cannot authenticate blocks automatic publication and is reported by
opaque ID so a backup can be restored. Never omit an undecryptable row and
publish silent data loss.

The orphan cleaner retains:

- the current head object;
- a configurable number of previously referenced generations, default 10;
- all objects newer than a safety age, default seven days; and
- objects referenced by protected exports or an in-progress migration.

It deletes only objects that are absent from this live/retained set after a
second inventory pass. Cleanup is an administration operation, not a browser
startup side effect.

## Scale guardrails

The single snapshot is intentional for this one-owner library because it makes
initial load and full-text indexing one request. Record these metrics:

- encrypted/compressed snapshot bytes and compression ratio;
- book count, build time, download time, decrypt/decompress time, and index
  build time;
- R2 publication failures/orphans;
- Fastly-to-Cosmos request latency, batch RU, conflicts, and 429 responses; and
- cache hit rate.

Set an initial warning at 8 MiB encrypted or 10,000 books. Crossing it does not
silently change the format. A future version may shard by stable book-ID range
behind a signed manifest, but must keep atomic manifest publication, local
search, and complete rebuild semantics.
