# Encrypted library snapshot and local search

The initial library screen must not fetch and decrypt every book entry one at
a time. Instead it downloads one small immutable R2 object, the catalog
snapshot (browse/search), and reads one small KV Store entry, the reading
index ([data_model.md](data_model.md)). KV Store's `catalog-head` entry holds
only the current snapshot pointer.

The snapshot is a derived projection of every book entry. Encrypted book
entries remain authoritative and are sufficient to rebuild it. The reading
index is a derived projection of every book's reading-state entry and is
rebuildable the same way.

## Snapshot schema

The decrypted canonical JSON is the authenticated catalog envelope from
[cryptography.md](cryptography.md):

```json
{
  "purpose": "txt:catalog",
  "envelope_version": 1,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "generation": 184,
  "object_key": "{db_prefix}/catalog/random",
  "snapshot_schema_version": 1,
  "books": []
}
```

`books` is sorted by `book_id` bytewise. Each member is:

```json
{
  "book_id": "book_K7c3...",
  "schema_version": 1,
  "record_version": 5,
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
  ]
}
```

One `record_version` per book is enough to detect a stale projection, because
a book's identity, catalog metadata, and shares live in one KV entry: any
change to any of them advances the same counter. The projection deliberately
excludes `last_accessed`, `last_cfi`, and `bookmarks` — those live only in the
reading-state/reading-index KV entries described in
[data_model.md](data_model.md), refreshed far more often than a catalog
generation, and are never part of this envelope. It also excludes the EPUB
`txt_key` and owner content path; opening a book fetches its authoritative
book entry before content is fetched. Although share secrets are duplicated
in the projection, they remain under the same end-to-end `vault_master_key`
and never appear in the KV Store pointer or server logs.

Every envelope field must match the authenticated owner bootstrap and
`catalog-head`. Every projected value is validated using the same rules as its
source book entry. Duplicate book IDs or unsupported versions make the entire
snapshot invalid; there is no separate persisted book count to cross-check
against — the `books` array's own length is the count, and the array's own
duplicate-ID/schema validation is what catches a malformed projection.

## Reading index schema

The reading index ([data_model.md](data_model.md)) is a second, independent
small KV Store entry:

```json
{
  "purpose": "txt:reading-index",
  "envelope_version": 1,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
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
```

Each entry's `bookmarks` is the complete array from that book's
`reading:{book_id}` entry, not merely a count, so a library-wide "all
bookmarks" view and per-book bookmark-count badges both render from this one
entry — neither needs a per-book fetch. Opening a book always fetches its own
`reading:{book_id}` entry directly (see Initial load below), so the index is
never consulted for that; `last_cfi` therefore stays out of it entirely. It
changes on every debounced relocation, while `bookmarks` changes only when
the owner explicitly adds or removes one — so this index is overwritten only
when a session's `last_accessed` first qualifies or `bookmarks` changes,
never on a CFI-only debounce; see [data_model.md](data_model.md).

It has no generation field inside the ciphertext and no relationship to
`catalog-head`'s conditional-write protocol: it is conditionally overwritten
in place on its own KV Store `generation`, and read as a plain fetch (no
hash/length pinning beyond its own `generation`, since there is no separate
authoritative pointer to compare against — the entry itself is the only copy
of "current"). An
entry referencing a `book_id` absent from the current snapshot is stale (the
book was deleted after the index was last written) and is dropped
client-side rather than treated as corruption; the reverse — a book present
in the snapshot with no index entry — means it has never been opened, and
sorts as never-read.

## Initial load

After `/v1/keys` and local unwrapping:

1. Call `GET /v1/vault/head`; Fastly reads the `catalog-head` entry from the
   `vault` store.
2. Decrypt the head entry's `ciphertext` locally to obtain `object_key`
   ([cryptography.md](cryptography.md)'s `catalog-head-pointer` vault entry
   envelope).
3. Look up encrypted snapshot bytes in IndexedDB by `(object_key, generation)`.
4. If absent, call `POST /v1/r2-token` (adding the possession proof) and GET
   the exact object with the temporary R2 credential. Do not list the bucket
   and do not use range requests; compression and AEAD require the complete
   object.
5. Decrypt using the canonical structured-payload procedure from
   [docs/crypto.md](../crypto.md), parse canonical JSON with duplicate-key
   rejection, verify all envelope/head fields, and validate every entry.
   There is no separate length or hash pre-check: a truncated or corrupted
   object fails AEAD authentication here, which is treated the same as any
   other repair-triggering failure below.
6. In parallel with steps 2–5, call `GET /v1/vault/reading-index`. A
   `present: false` response (first session, or an owner with no reading
   history yet) is not an error — treat it as an empty index. Verify and
   decrypt a present entry the same way, without a hash/length pin (see
   above).
7. Keep the plaintext projections and search index only in memory. IndexedDB
   stores ciphertext and verified snapshot pointer metadata, never plaintext
   or session credentials. The reading index has no pointer metadata to cache
   beyond its own `generation`.
8. Render the current library ordering (using the reading index's
   `last_accessed`, falling back to catalog/ingest order for entries absent
   from the index), bookmark-count badges, and share state, and build the
   existing local full-text index over `name`, `title`, `authors`, `subjects`,
   and `publisher` from the snapshot.

Search behavior remains client-side, offline after unlock/cache load, and
independent of KV Store indexing — KV Store has no query language, and
queries, tokens, normalized terms, and result sets never reach Fastly or KV
Store regardless.

Opening a search result calls `GET /v1/vault/books/{book_id}`, decrypts it,
checks its `record_version` against the projection, and separately calls
`GET /v1/vault/reading/{book_id}` for `last_cfi` and full bookmark detail
before rendering the reader. If `record_version` differs from the
projection, treat the entry as authoritative and schedule snapshot repair
rather than showing stale catalog or share state; a stale reading-index entry
is never treated as a repair trigger, since the per-book reading entry
fetched here is always the authoritative one.

## Which mutations republish the snapshot

Republish (bump `generation`, upload a new immutable snapshot object, replace
`catalog-head`) on every accepted `/v1/vault/commit`: ingest, delete, a
catalog metadata edit, and any share create/activate/mark-deleting/remove all
go through that route, and every one of them changes a field the projection
carries.

Reading position (`last_accessed`, `last_cfi`) and bookmark mutations
**never** republish the snapshot — they write only through
`PUT /v1/vault/reading/{book_id}`, which touches the per-book reading entry
and, only sometimes (see below), the reading index — and nothing else. This
is the deliberate point of keeping them in their own entry: the
highest-frequency mutation in the system never touches a book's merged
entry, `catalog-head`, or a generation counter. Preserve current reader
semantics for triggering those writes:

- require six seconds of visible reading before a session qualifies;
- retain candidate CFI only before qualification;
- after qualification, write `last_accessed` and the latest CFI to the
  reading-state entry, **and include the `reading_index` update** in that
  same call — this is the one write per session that changes
  `last_accessed`;
- debounce owner relocation by two seconds and write at most every 15
  seconds, writing only the reading-state entry — no index update, since
  neither `last_accessed` nor `bookmarks` changed;
- perform the final qualified flush on hidden, book switch, or reader close,
  again without an index update unless a bookmark changed during the
  session;
- include the `reading_index` update on any call that adds or removes a
  bookmark, regardless of qualification state;
- keep a failed semantic mutation as visibly unsaved and retryable.

## Atomic publication protocol

There is no cross-store or cross-key transaction, so publication orders KV
Store and R2 work to guarantee that an accepted head never points to an
object that was not uploaded — and, since `/v1/vault/commit` independently
verifies the object against R2 before accepting the head write, that
guarantee does not depend solely on client behavior.

For one snapshot-affecting mutation:

1. Start from the currently decrypted book entry/entries and snapshot
   identified by the opaque `generation` values returned through Fastly.
2. Apply a pure, replayable mutation to produce the next book entry/entries
   and projection. Increment the affected entry's `record_version` and the
   head's `generation` field.
3. Build the authenticated catalog envelope, canonically serialize it, and
   Encrypt it with the canonical structured-payload procedure, choosing a new
   random `object_key`, as defined in [cryptography.md](cryptography.md).
4. Upload it to that new random immutable R2 object with `If-None-Match: *`,
   then wrap `object_key` alone in the `catalog-head-pointer` vault entry
   envelope.
5. Call `POST /v1/vault/commit` with the possession proof, the book
   operation, the head operation (carrying the wrapped pointer), and the
   plaintext `object_key` as a verification-only field. Fastly validates the
   outer entries, performs the R2 existence check on that object key, then
   writes the book entry followed by the head entry, each conditional on its
   own `generation` where applicable.
6. Treat success of both writes as the commit point. Update in-memory state
   and cache the encrypted snapshot.

Reading-state/bookmark mutations follow a separate, simpler protocol with no
snapshot or head involvement at all — see [data_model.md](data_model.md) and
`PUT /v1/vault/reading/{book_id}` in [auth_api.md](auth_api.md).

If the R2 snapshot upload fails, no KV Store write is attempted. If the
upload succeeds but the book or head write fails (including a failed R2
existence check on Fastly's side), the new object is an unreferenced orphan
and the previous head remains valid.

## Conflict replay

On `409 conflict` from Fastly after a `generation` mismatch or a failed R2
existence check on a new head:

1. Refetch the winning `catalog-head` and affected book entry/entries through
   Fastly.
2. Load and validate the winning snapshot.
3. Reapply the original semantic mutation, not a byte-level overwrite.
4. Upload a new generation to a new immutable key.
5. Retry the write.

Match the current store's limit of three automatic attempts. Newly uploaded
losing generations remain safe orphans for cleanup. After the third conflict,
retain the mutation as unsaved, surface a recoverable error, and never silently
discard or overwrite another device's update.

Serialization is per browser tab. Cross-tab coordination uses the existing
browser locking mechanism where supported, but `generation` remains
authoritative across tabs, devices, and CLI writers for `book`/`catalog-head`
entries. Reading-state/reading-index conflicts use their own `generation`
values the same way, independently of the book/head protocol — a `409` there
means another tab or device wrote the same per-book reading entry or the
index first: fetch, reapply, retry.

## Cache and offline behavior

- Cache only verified ciphertext and nonsensitive pointer metadata.
- Key snapshot cache entries by ciphertext hash, not merely generation. Key
  the cached reading index by its own KV Store `generation`, since it has no
  generation field of its own inside the ciphertext.
- Keep at least the current and immediately previous verified snapshot locally
  until the current one has decrypted successfully.
- A cached snapshot and reading index may render while offline only after the
  user supplies the root key and it authenticates. Mutations remain
  queued/unsaved until KV Store and R2 are both available for whatever the
  mutation touches.
- Never let a service worker cache `/v1/keys`, `/v1/r2-token`, any `/v1/vault/*`
  route, grants, signed URLs, or credential-bearing responses.

## Repair and rebuild

If the current snapshot is missing, corrupt, fails AEAD/schema validation, or
contains a row version mismatch:

1. retain the failed head/object for diagnosis without exposing plaintext;
2. page through the fixed authenticated owner book scan (`owner-vault-scan`,
   [auth_api.md](auth_api.md)); never submit client query text;
3. decrypt each canonical blob and validate its inner envelope against the
   outer entry's key and kind;
4. sort and build a fresh projection;
5. publish a new immutable generation using a `generation` condition on the
   head;
6. retry on a concurrent winner and accept the winner if it validates.

This is the only normal path that scans vault entries. The browser may offer it
as an explicit repair action; the administration CLI also implements it. An
entry that cannot authenticate blocks automatic publication and is reported
by opaque ID so a backup can be restored. Never omit an undecryptable entry
and publish silent data loss.

The reading index can be rebuilt independently and more cheaply: page the same
scan for book IDs, fetch each `reading:{book_id}` entry that exists (a
missing one means the book has never been opened — record it as never-read,
not an error), and overwrite the index conditional on its current
`generation` (or with a create-only write if absent). This never touches a
book's merged entry or `catalog-head`, and never blocks on the catalog
snapshot's own repair.

The same scan also finds orphaned reading entries: a `reading:{book_id}`
entry whose `book_id` does not appear in the current snapshot means the book
was deleted without its reading entry being cleaned up. The administration CLI
deletes it (KV Store deletes are free of Class A cost) after confirming the
book is genuinely absent, not merely mid-repair.

The orphan cleaner retains:

- the current head object;
- a configurable number of previously referenced generations, default 10;
- all objects newer than a safety age, default seven days;
- objects referenced by protected exports or an in-progress migration; and
- every reading entry whose `book_id` is present in the current snapshot.

It deletes only objects/entries that are absent from this live/retained set
after a second inventory pass. Cleanup is an administration operation, not a
browser startup side effect.

## Scale guardrails

The single snapshot and single reading index are intentional for this
one-owner library because they make initial load and full-text indexing two
small requests instead of one-per-book. Record these metrics:

- encrypted/compressed snapshot and reading-index bytes and compression ratio;
- book count, build time, download time, decrypt/decompress time, and index
  build time for both;
- R2 publication failures/orphans, and KV Store conditional-write conflicts on
  book, head, reading-state, and reading-index entries;
- Fastly-to-KV-Store request latency, and KV Store Class A/B operation counts
  broken down by route, checked against the budget in
  [README.md](README.md#capacity-target) — this is the metric that catches a
  route quietly writing more often than its design assumed; and
- cache hit rate.

Set an initial warning at 8 MiB encrypted snapshot or 10,000 books, and
separately at 8 MiB for the reading index too: each entry now carries its
book's full bookmark array (up to the 20-bookmark cap, each with a
100-UTF-8-byte preview), not a bare count, so the index is bounded by book
count times the per-book bookmark cap rather than by one fixed-size field per
book. Crossing either does not silently change the format. A future version
may shard the snapshot by stable book-ID range behind a signed manifest, but
must keep atomic manifest publication, local search, and complete rebuild
semantics; the reading index can be sharded the same way without touching the
snapshot protocol at all.
