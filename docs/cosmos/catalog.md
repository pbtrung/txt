# Encrypted library snapshot and local search

The initial library screen must not point-read and decrypt every Cosmos book
and catalog item. Instead it downloads two small immutable/derived R2 objects:
the catalog snapshot (browse/search) and the reading index
([data_model.md](data_model.md)). Cosmos stores only the current snapshot
pointer in `catalog-head`; the reading index has no Cosmos pointer at all.

The snapshot is a derived projection of every `catalog` (and, for shares,
`book`) item. Encrypted Cosmos catalog/book items remain authoritative and are
sufficient to rebuild it. The reading index is a derived projection of every
per-book reading-state R2 object and is rebuildable the same way, without
touching Cosmos at all.

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
  "book_id": "book_K7c3...",
  "catalog_schema_version": 1,
  "catalog_record_version": 2,
  "catalog": {
    "name": "original.epub",
    "title": "Title",
    "authors": ["Author"],
    "subjects": ["Subject"],
    "publisher": "Publisher"
  },
  "book_schema_version": 2,
  "book_record_version": 5,
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

The projection intentionally carries two independent record-version fields
because catalog and book/shares are now independently mutable Cosmos items:
`catalog_record_version` lets a search result detect a stale catalog entry,
and `book_record_version` lets it detect a stale share list, without either
mutation forcing the other to republish. The projection deliberately excludes
`last_accessed`, `last_cfi`, and `bookmarks` — those live only in the R2
reading-state/reading-index objects described in
[data_model.md](data_model.md), refreshed far more often than a catalog
generation, and are never part of this envelope. It also excludes the EPUB
`txt_key` and owner content path; opening a book point-reads its authoritative
`book` row before content is fetched. Although share secrets are duplicated in
the projection, they remain under the same end-to-end `vault_master_key` and
never appear in the Cosmos pointer or server logs.

Every envelope field must match the authenticated owner bootstrap and
`catalog-head`. Every projected value is validated using the same rules as its
source catalog/book record. Duplicate book IDs, unsupported versions, or a
count different from `catalog-head.book_count` make the entire snapshot
invalid.

## Reading index schema

The reading index ([data_model.md](data_model.md)) is a second, independent
small object:

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

It has no generation, no Cosmos pointer, and no relationship to
`catalog-head`'s conditional-write protocol: it is simply overwritten in place
with `If-Match` whenever any book's reading state changes, and read with a
plain GET (no hash/length pinning beyond the object's own ETag, since there is
no separate authoritative pointer to compare against — the object itself is
the only copy of "current"). An entry referencing a `book_id` absent from the
current snapshot is stale (the book was deleted after the index was last
written) and is dropped client-side rather than treated as corruption; the
reverse — a book present in the snapshot with no index entry — means it has
never been opened, and sorts as never-read.

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
6. In parallel with steps 2–5, GET `{db_prefix}/reading/index.blob` with the
   same temporary credential. Its absence (first session, or an owner with no
   reading history yet) is not an error — treat it as an empty index. Verify
   and decrypt it the same way, without a hash/length pin (see above).
7. Keep the plaintext projections and search index only in memory. IndexedDB
   stores ciphertext and verified snapshot pointer metadata, never plaintext
   or session credentials. The reading index has no pointer metadata to cache
   beyond its own ETag.
8. Render the current library ordering (using the reading index's
   `last_accessed`, falling back to catalog/ingest order for entries absent
   from the index), bookmark-count badges, and share state, and build the
   existing local full-text index over `name`, `title`, `authors`, `subjects`,
   and `publisher` from the snapshot.

Search behavior remains client-side, offline after unlock/cache load, and
independent of Cosmos indexing. Queries, tokens, normalized terms, and result
sets never reach Fastly or Cosmos.

Opening a search result calls the fixed Fastly book route (which returns the
paired `book` and `catalog` items together), decrypts them, checks their
`record_version`s against the projection, and separately fetches
`{db_prefix}/reading/{book_id}.blob` directly from R2 for `last_cfi` and full
bookmark detail before rendering the reader. If a `record_version` differs
from the projection, treat the row as authoritative and schedule snapshot
repair rather than showing stale catalog or share state; a stale reading-index
entry is never treated as a repair trigger, since the per-book reading object
fetched here is always the authoritative one.

## Which mutations republish the snapshot

Republish (bump `generation`, upload a new immutable snapshot object, replace
`catalog-head`) when any projected field changes:

- ingest a book (create `book` + `catalog` + empty reading-state);
- delete a book (delete `book` + `catalog` + reading-state object + reading-
  index entry);
- edit catalog metadata (`catalog` item only); or
- create, activate, mark deleting, or remove a share (`book` item only).

Reading position (`last_accessed`, `last_cfi`) and bookmark mutations **never**
republish the snapshot — they write only the per-book reading-state object and
the reading index, both in R2, both outside Cosmos and outside
`/v1/vault/commit` entirely. This is the deliberate point of splitting them
out: the highest-frequency mutation in the system no longer touches the
Cosmos partition, the RU budget, or a generation counter at all. Preserve
current reader semantics for triggering those R2 writes:

- require six seconds of visible reading before a session qualifies;
- retain candidate CFI only before qualification;
- after qualification, write `last_accessed` and the latest CFI to the
  reading-state object and update the reading index;
- debounce owner relocation by two seconds and write at most every 15 seconds;
- perform the final qualified flush on hidden, book switch, or reader close;
- keep a failed semantic mutation as visibly unsaved and retryable.

## Atomic publication protocol

Cross-service transactions do not exist, so publication orders R2 and Cosmos
to guarantee that an accepted head never points to an object that was not
uploaded — and, since [auth_api.md](auth_api.md)'s `/v1/vault/commit` now
verifies the object directly against R2 before accepting the batch, that
guarantee no longer depends solely on client behavior.

For one snapshot-affecting mutation:

1. Start from the currently decrypted `catalog`/`book` row(s) and snapshot
   identified by the opaque Cosmos `_etag` values returned through Fastly.
2. Apply a pure, replayable mutation to produce the next `catalog`/`book`
   record(s) and projection. Increment the affected item's `record_version`
   and the head `generation`.
3. Build the authenticated catalog envelope, canonically serialize it, Encrypt
   it with the canonical structured-payload procedure, and SHA-256 hash the raw
   blob as defined in [cryptography.md](cryptography.md).
4. Upload it to a new random immutable R2 object with `If-None-Match: *`.
5. Call `POST /v1/vault/commit` with the possession proof and whichever of
   `book`/`catalog`/`head` changed. Fastly validates the outer items,
   performs the R2 existence/length/hash check on the new head object, and
   submits a Cosmos transactional batch in the one owner partition containing
   the affected item operation(s) and the `catalog-head` replace, each with
   its expected `_etag` where applicable.
6. Treat success of the full batch as the commit point. Update in-memory state
   and cache the encrypted snapshot.

Reading-state/bookmark mutations follow a separate, simpler protocol with no
Cosmos step at all — see the R2 conditional-write description in
[data_model.md](data_model.md).

If the R2 snapshot upload fails, Cosmos is untouched. If the upload succeeds
but the batch fails (including a failed R2 existence check on Fastly's side),
the new object is an unreferenced orphan and the previous head remains valid.

## Conflict replay

On `409 conflict` from Fastly after a Cosmos precondition failure or a failed
R2 existence check on a new head:

1. Refetch the winning `catalog-head` and affected `catalog`/`book` row(s)
   through Fastly.
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
across tabs, devices, and CLI writers for `catalog`/`book`/`catalog-head`.
Reading-state/reading-index conflicts use R2's `ETag`/`If-Match` the same way,
independently and without any Cosmos involvement — a `412` there means another
tab or device wrote the same per-book reading object first; download, reapply,
retry, exactly as [docs/data_model.md](../data_model.md) §1 already specifies
for the legacy whole-database object.

## Cache and offline behavior

- Cache only verified ciphertext and nonsensitive pointer metadata.
- Key snapshot cache entries by ciphertext hash, not merely generation. Key
  the cached reading index by its own ETag, since it has no generation.
- Keep at least the current and immediately previous verified snapshot locally
  until the current one has decrypted successfully.
- A cached snapshot and reading index may render while offline only after the
  user supplies the root key and it authenticates. Mutations remain
  queued/unsaved until R2 is available (Cosmos as well, for anything that
  still touches it).
- Never let a service worker cache `/v1/keys`, `/v1/r2-token`, any `/v1/vault/*`
  route, grants, signed URLs, or credential-bearing responses.

## Repair and rebuild

If the current snapshot is missing, corrupt, fails AEAD/schema validation, or
contains a row version mismatch:

1. retain the failed head/object for diagnosis without exposing plaintext;
2. page through Fastly's fixed authenticated owner `catalog`/`book` scan
   (`owner-vault-scan`, [auth_api.md](auth_api.md)); never submit client query
   text;
3. decrypt each canonical blob and validate its inner envelope against the
   outer row, including the `catalog_` ↔ `book_` ID correlation;
4. sort and build a fresh projection;
5. publish a new immutable generation using an `_etag` condition on the head;
6. retry on a concurrent winner and accept the winner if it validates.

This is the only normal path that scans vault rows. The browser may offer it as
an explicit repair action; the administration CLI also implements it. A row
that cannot authenticate blocks automatic publication and is reported by
opaque ID so a backup can be restored. Never omit an undecryptable row and
publish silent data loss.

The reading index can be rebuilt independently and more cheaply: page the same
scan for `book` IDs, GET each `{db_prefix}/reading/{book_id}.blob` that
exists (a missing one means the book has never been opened — record it as
never-read, not an error), and overwrite the index with `If-Match` on its
current ETag (or `If-None-Match: *` if absent). This never touches Cosmos and
never blocks on the catalog snapshot's own repair.

The orphan cleaner retains:

- the current head object;
- a configurable number of previously referenced generations, default 10;
- all objects newer than a safety age, default seven days;
- objects referenced by protected exports or an in-progress migration; and
- the current reading-state object for every live `book_id` and the current
  reading index.

It deletes only objects that are absent from this live/retained set after a
second inventory pass. Cleanup is an administration operation, not a browser
startup side effect.

## Scale guardrails

The single snapshot and single reading index are intentional for this
one-owner library because they make initial load and full-text indexing two
small requests instead of one-per-book. Record these metrics:

- encrypted/compressed snapshot and reading-index bytes and compression ratio;
- book count, build time, download time, decrypt/decompress time, and index
  build time for both objects;
- R2 publication failures/orphans, and R2 conditional-write conflicts on
  reading-state/reading-index objects;
- Fastly-to-Cosmos request latency, batch RU, conflicts, and 429 responses —
  now driven only by ingest/edit/delete/share activity, not reading position;
  and
- cache hit rate.

Set an initial warning at 8 MiB encrypted snapshot or 10,000 books, and
separately at 2 MiB for the reading index (bounded by book count, not by
reading activity, since it holds one small fixed-size entry per book
regardless of how often that book is read). Crossing either does not silently
change the format. A future version may shard the snapshot by stable book-ID
range behind a signed manifest, but must keep atomic manifest publication,
local search, and complete rebuild semantics; the reading index, being
Cosmos-independent, can be sharded the same way without touching the snapshot
protocol at all.
