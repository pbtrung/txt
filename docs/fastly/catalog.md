# Encrypted library snapshot and local search

The initial library screen must not fetch and decrypt every book entry. It
downloads one small encrypted R2 catalog object and one small encrypted KV
Store reading index. Every catalog generation uses a fresh random immutable
R2 key:

```text
{db_prefix}/catalog/{random}
```

`catalog-head` encrypts the current object key with `vault_master_key` and
exposes only its ETag, byte length, ciphertext digest, and logical snapshot
generation. Only the object referenced by the current head is live; failed or
superseded random generations are safety-aged cleanup candidates.

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
      "object_etag": "opaque R2 validator",
      "object_length": 12345,
      "ciphertext_sha256": "base64url SHA-256",
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

The browser or CLI must verify the decrypted envelope's owner, vault, random
object key against the decrypted head pointer, snapshot generation, canonical
order, duplicate-free book IDs, versions, and every projected value. Fastly
cannot validate those encrypted fields. Share secrets in the projection remain
under `vault_master_key` and must never appear in `catalog-head` or logs.

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

1. Call `GET /v1/vault/head`, validate its outer operational fields, then
   decrypt/validate its `catalog-head-pointer` envelope to obtain the random
   object key.
2. Look up verified encrypted snapshot bytes locally by object key, ciphertext
   digest, and ETag.
3. If absent, obtain a 60-second exact `catalog-get` URL for the decrypted
   random ID and GET that object.
   Use the R2 S3 endpoint directly with caches disabled; do not list, use a
   caching custom domain, or use ranges.
4. Before decryption, require response ETag and byte length to equal the head,
   compute SHA-256 over the received bytes, and require it to equal both the
   head digest and object checksum metadata.
5. Decrypt and parse canonical JSON with duplicate-key rejection. Require all
   inner bindings, including the random key and logical generation, to match
   the bootstrap and decrypted head; validate every projected row.
6. In parallel, fetch and decrypt `reading-index`; absence means an empty
   index, not an error.
7. Keep plaintext and the search index only in memory. IndexedDB may store
   ciphertext and verified nonsensitive metadata, never plaintext or session
   credentials.
8. Render ordering, bookmark badges, and share state, then build local search
   over name, title, authors, subjects, and publisher.

If the pointed-to object is absent or its metadata differs from the head, the
head/object pair is corrupt or incomplete. A previously verified local
snapshot may remain visible with an explicit stale/repairing state, but
mutation waits for repair. Unreferenced random catalog objects never affect
load and are not candidates for guessing a newer head.

Opening a result fetches and decrypts the `{book_id}` KV entry and compares its
`record_version` with the projection. It separately fetches
`reading_{book_id}` for current position and bookmark detail. A book version
mismatch makes the book authoritative and schedules catalog repair; a stale
index row does not. To open content, obtain an exact `owner-epub-get` URL with
`If-Match` from the decrypted book record, require response ETag/length/SHA-256
metadata and computed digest equality, then authenticate/decrypt the EPUB.

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

## Immutable publication and commit protocol

R2 object creates are strongly consistent, but R2 and KV Store do not share a
transaction. Publication creates before it points and uses idempotent KV
postconditions to make every partial state recoverable.

For one book mutation:

1. Start from the verified head, snapshot, and affected authoritative book
   entry. Apply a pure replayable semantic mutation. Increment the affected
   `record_version` and logical snapshot generation.
2. Choose a fresh random catalog ID. Canonically serialize, compress, and
   encrypt the next snapshot with that full key inside the envelope; encrypt
   the same key into the next head pointer. Compute ciphertext SHA-256/length.
3. Obtain an exact `catalog-put` URL for the random key. The PUT is bound to
   `If-None-Match: *`, content type, Content-MD5, and SHA-256 metadata. These
   [conditional headers](https://developers.cloudflare.com/r2/examples/aws/custom-header/)
   are part of the signed request. A collision cannot overwrite an object;
   choose a new random ID. After a lost PUT response, use the exact
   `pending-get` recovery operation and accept the object only after complete
   metadata/hash/AEAD validation.
4. PUT the new bytes and record R2's returned ETag.
5. Call `POST /v1/vault/commit` with the book operation, complete encrypted
   head, and the same catalog key as a transient verification-only field. A
   create/replace also supplies the encrypted entry's owner EPUB tuple. Fastly
   directly HEADs each applicable object first, requiring exact ETag, length,
   and digest metadata; then it applies the idempotent book operation and
   conditionally writes the head.
6. Success or exact already-applied postconditions are the commit point. Cache
   the verified encrypted snapshot.

If a client crashes after step 4, the old head remains valid and the new random
object is an orphan. If the book write succeeds but the head write/response
does not, the old snapshot is stale relative to authoritative books. Retry
with the exact original encrypted book/head bytes and transient object fields,
changing only the proof. Fastly's postconditions recognize completed phases
without applying the book mutation again. Re-encryption is a new attempt, not
an idempotent retry. A response identifies `content`, `snapshot`, `book`,
`head`, or `propagation`; never infer success from a timeout.

## Conflicts and content replacement

On a true conflict, refetch/decrypt the winning head and affected book, load or
repair the winning snapshot, reapply the semantic mutation, upload a fresh
random generation, and retry. Match the current maximum of three automatic
attempts. Losing uploads remain immutable orphans for cleanup. After that,
retain the mutation as visibly unsaved. Never repoint to unvalidated bytes.

Content replacement uses a fresh EPUB path and fresh `book_id`, so old CFIs
and bookmarks cannot attach to unrelated content. Create and publish the new
book first; only after it is visible delete and publish removal of the old
book, after removing its shares. Then conditionally delete the old reading
entry and remove its index row through the independent reading-index route. A
crash can leave old only, both, or new only, never neither; abandoned reading/
index residue is repairable. Do not transfer reading state automatically.

## Cache, repair, and cleanup

Cache only verified ciphertext and nonsensitive head metadata. Keep the
previous verified snapshot locally until the current one authenticates. R2
may temporarily contain safety-aged unreferenced generations, but the current
encrypted head pointer alone selects live bytes. Offline rendering requires a
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
6. create a fresh random immutable catalog object and publish its encrypted
   pointer/integrity metadata through `PUT /v1/vault/head`; and
7. retry a concurrent winner and accept it only after full validation.

The reading index is repaired separately by scanning book IDs, point-reading
present reading entries, and conditionally recreating or replacing the index.
An absent reading entry means never opened. An orphan `reading_{book_id}` is
deleted only after two checks separated by a safety interval confirm the book
is absent and no repair is in progress.

The R2 cleaner treats only the decrypted current head object as a live catalog
generation. It inventories immutable EPUB/share/catalog/export objects,
retains objects newer than the safety age plus every authoritative reference
and protected export, and deletes an unreferenced generation only after a
second pass. Cleanup is not a rollback mechanism; backups and verified local
cache provide recovery history. If the head pointer cannot authenticate, the
cleaner performs no catalog deletion until repair publishes a valid head.

## Scale guardrails

Record encrypted snapshot/index size and compression ratio, book count, build/
download/decrypt/index timings, orphan-generation cleanup and head/object
repair counts, KV conditional conflicts by route, and Class A/B operations
against the capacity budget. Warn at 8 MiB encrypted or 10,000 books and
independently at 8 MiB for the reading index. A future sharded format requires
a conditionally published manifest and complete repair semantics; it must not
silently replace this protocol.
