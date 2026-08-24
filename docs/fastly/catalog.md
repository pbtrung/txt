# Encrypted library snapshot and local search

The initial library screen must not fetch and decrypt every book entry. It
downloads one small encrypted R2 catalog object and one small encrypted KV
Store reading index. The catalog uses exactly one fixed R2 key:

```text
{db_prefix}/catalog/library.blob
```

Every publication conditionally overwrites that object. R2 therefore keeps
only the most recent catalog object; the application does not create or retain
catalog generations under other keys. The `catalog-head` KV entry pins the
ETag, byte length, ciphertext digest, and logical snapshot generation that
committed successfully.

The snapshot is a derived projection of authoritative encrypted book entries.
The reading index is independently derived from authoritative per-book reading
entries. Either can be rebuilt without treating its current bytes as truth.

## Snapshot schema

After decryption, the canonical JSON envelope is:

```json
{
  "purpose": "txt:catalog",
  "envelope_version": 1,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "generation": 184,
  "object_key": "{db_prefix}/catalog/library.blob",
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

One `record_version` detects a stale projection because identity, catalog
metadata, content locator, and shares occupy one book entry. The projection
omits the EPUB `txt_key` and content path; opening a book fetches its
authoritative entry. It also omits `last_accessed`, `last_cfi`, and bookmarks,
which belong to reading state and the reading index.

The browser or CLI must verify the decrypted envelope's owner, vault, fixed
object key, snapshot generation, canonical order, duplicate-free book IDs,
versions, and every projected value. Fastly cannot validate those encrypted
fields. Share secrets in the projection remain under `vault_master_key` and
must never appear in `catalog-head` or logs.

## Reading index schema

The independent `reading-index` KV entry decrypts to:

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

Each `bookmarks` array is the complete array from the corresponding reading
entry. `last_cfi` stays out because opening a book always fetches its reading
entry. The index changes only when a session's `last_accessed` first qualifies
or bookmarks change, never for a CFI-only debounce.

The ciphertext has no internal generation. Its KV Store generation controls
conditional replacement. An index row for an absent book is stale and is
dropped client-side; a book with no row has never been opened.

## Initial load

After `/v1/keys` and local unwrapping:

1. Call `GET /v1/vault/head` and validate the plaintext operational fields.
2. Look up verified encrypted snapshot bytes locally by the head's ciphertext
   digest and ETag.
3. If absent, GET the exact fixed R2 object through the scoped owner R2 flow.
   Use the R2 S3 endpoint directly with caches disabled; do not list, use a
   caching custom domain, or use ranges.
4. Before decryption, require response ETag and byte length to equal the head,
   compute SHA-256 over the received bytes, and require it to equal both the
   head digest and object checksum metadata.
5. Decrypt and parse canonical JSON with duplicate-key rejection. Require all
   inner bindings, including the fixed key and logical generation, to match
   the bootstrap and head; validate every projected row.
6. In parallel, fetch and decrypt `reading-index`; absence means an empty
   index, not an error.
7. Keep plaintext and the search index only in memory. IndexedDB may store
   ciphertext and verified nonsensitive metadata, never plaintext or session
   credentials.
8. Render ordering, bookmark badges, and share state, then build local search
   over name, title, authors, subjects, and publisher.

If the R2 object and head ETags differ, publication was interrupted. Do not
accept whichever happens to be newer. A previously verified local snapshot may
remain visible with an explicit stale/repairing state, but mutation waits for
repair. If no verified cache exists, fail closed into repair.

Opening a result fetches and decrypts the `{book_id}` KV entry and compares its
`record_version` with the projection. It separately fetches
`reading_{book_id}` for current position and bookmark detail. A book version
mismatch makes the book authoritative and schedules catalog repair; a stale
index row does not.

## Which mutations publish

Every accepted `/v1/vault/commit` publishes the catalog: ingest, delete,
metadata edits, content-locator changes, and share transitions. Fastly cannot
see encrypted semantics, so there is no book-write route that bypasses catalog
publication.

Reading mutations never publish the catalog:

- require six seconds of visible reading before a session qualifies;
- retain the candidate CFI locally before qualification;
- after qualification, write reading state first, then independently write
  the index with the new `last_accessed`;
- debounce relocation by two seconds and write at most every 15 seconds,
  updating only reading state for CFI-only changes;
- flush qualified state on hidden, book switch, or close; and
- after adding or removing a bookmark, write reading state first and then the
  index.

If the second write fails, keep only the index mutation unsaved and retry it
through `PUT /v1/vault/reading-index`; do not replay a successful reading-state
write.

## Overwrite and commit protocol

R2 object updates are strongly consistent, but R2 and KV Store do not share a
transaction. Publication uses a conditional overwrite plus idempotent
postconditions to make every partial state recoverable.

For one book mutation:

1. Start from the verified head, snapshot, and affected authoritative book
   entry. Apply a pure replayable semantic mutation. Increment the affected
   `record_version` and logical snapshot generation.
2. Canonically serialize, compress, and encrypt the next snapshot for the
   fixed object key. Compute its ciphertext SHA-256 and length.
3. Obtain upload authorization only if a direct R2 `HEAD` still exactly
   matches the current `catalog-head` ETag. The PUT is bound to the fixed key,
   `If-Match: <head ETag>`, content type, and checksum metadata. Initial setup
   uses `If-None-Match: *`. These
   [conditional headers](https://developers.cloudflare.com/r2/examples/aws/custom-header/)
   are part of the signed request. A concurrent winner makes the PUT fail
   rather than overwrite again.
4. PUT the new bytes and record R2's returned ETag. There is now still exactly
   one catalog object.
5. Call `POST /v1/vault/commit` with the book operation and next head metadata.
   Fastly directly HEADs R2 first and requires exact ETag, length, and digest
   metadata; then it applies the idempotent book operation and conditionally
   writes the head.
6. Success or exact already-applied postconditions are the commit point. Cache
   the verified encrypted snapshot.

Only one ordinary publisher can move from a committed head ETag. If a client
crashes after step 4, R2's ETag no longer matches `catalog-head`; new
publication stops. The matching in-flight commit may still finish. Otherwise,
repair scans authoritative books, conditionally overwrites the mismatched
object using its current R2 ETag, and advances the head through
`PUT /v1/vault/head`.

If the book write succeeded but the head write or response failed, retry the
same semantic commit with a fresh proof. Fastly's exact book/head
postconditions recognize completed phases without applying the book mutation
again. A response identifies `snapshot`, `book`, `head`, or `propagation`;
never infer success from a timeout.

## Conflicts and content replacement

On a true conflict, refetch the winning head and affected book, load or repair
the winning snapshot, reapply the semantic mutation, and attempt one new
conditional overwrite. Match the current maximum of three automatic attempts.
After that, retain the mutation as visibly unsaved. Never byte-overwrite a
winner.

Content replacement uses a fresh EPUB path and fresh `book_id`, so old CFIs
and bookmarks cannot attach to unrelated content. Create and publish the new
book first; only after it is visible delete and publish removal of the old
book, after removing its shares. Then conditionally delete the old reading
entry and remove its index row through the independent reading-index route. A
crash can leave old only, both, or new only, never neither; abandoned reading/
index residue is repairable. Do not transfer reading state automatically.

## Cache, repair, and cleanup

Cache only verified ciphertext and nonsensitive head metadata. Keep the
previous verified snapshot locally until the current one authenticates, even
though R2 itself contains only the latest object. Offline rendering requires a
successful local unlock; mutations remain queued until both stores are
available. Service workers must not cache authenticated API routes, signed
URLs, grants, or R2 responses.

Repair is required for an absent object, head/object metadata mismatch, failed
AEAD/schema validation, or projected/live row mismatch:

1. retain opaque diagnostics without plaintext;
2. page through the fixed authenticated owner book scan;
3. decrypt and validate every canonical blob against its outer key and kind;
4. block rather than omit any undecryptable entry;
5. build a sorted projection at the next logical generation;
6. conditionally overwrite the fixed object — using its current ETag even when
   it differs from the head, or `If-None-Match: *` if absent — and publish the
   matching head through `PUT /v1/vault/head`; and
7. retry a concurrent winner and accept it only after full validation.

The reading index is repaired separately by scanning book IDs, point-reading
present reading entries, and conditionally recreating or replacing the index.
An absent reading entry means never opened. An orphan `reading_{book_id}` is
deleted only after two checks separated by a safety interval confirm the book
is absent and no repair is in progress.

The R2 cleaner never lists catalog generations because none exist. The fixed
catalog key is always live. It inventories immutable EPUB/share/export objects,
retains objects newer than the safety age plus every authoritative reference
and protected export, and deletes only after a second pass. Backups and exports
provide rollback; overwriting the catalog object is not a backup mechanism.

## Scale guardrails

Record encrypted snapshot/index size and compression ratio, book count, build/
download/decrypt/index timings, conditional-overwrite and head-mismatch repair
counts, KV conditional conflicts by route, and Class A/B operations against
the capacity budget. Warn at 8 MiB encrypted or 10,000 books and independently
at 8 MiB for the reading index. A future sharded format requires a conditionally
published manifest and complete repair semantics; it must not silently replace
this protocol.
