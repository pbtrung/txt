# Data Model — Design

The owner's entire library — catalog metadata, reading state, bookmarks,
and share grants — lives in one D1 database. Nothing proxies raw SQL to a
client: every read and write happens inside a Worker route handler through
the D1 binding.

Each document's own content is not in D1. Every document is a separate
encrypted object in R2, referenced by a row in the `documents` table. R2
object-key layout is `docs/storage_layout.md`. The public-sharing feature
built on top of this schema is `docs/sharing.md`. The crypto primitives
this schema uses are `docs/crypto.md`.

---

## 1. Row-level encryption

D1 cannot host a SQLCipher-encrypted file or a custom VFS, so a
whole-file passphrase has no equivalent here. Instead, every row holding
sensitive data gets its own fresh 128-byte random key, generated
client-side at write time. That per-row key is wrapped by the unwrapped
owner master key (`umk`) using the Encrypt procedure (`docs/crypto.md`),
and the row's own payload is wrapped by the _resulting unwrapped per-row
key_ — not by `umk` directly. `key_store` holds every wrapped per-row
key, referenced by the row it protects.

A per-row key closes a relocation risk the Blob Format's additional data
alone can't: a data blob decrypts only under the specific key its own
row's `*_key_id` points to, so copying one row's ciphertext into another
row simply fails to decrypt there. What a per-row key doesn't defend
against is a caller who can also rewrite the foreign key alongside the
blob, which needs D1 write access — i.e. a compromised Worker, already
inside the trusted computing base (`docs/auth.md` §7).

A column stays plaintext only when D1 itself needs to compare, sort, or
constrain on it. No table below stores plaintext title, author, filename,
CFI, bookmark text, or share capability material.

## 2. Schema

Schema changes are tracked by `wrangler d1 migrations` (`worker/migrations/
NNNN_*.sql`, applied and recorded in its own `d1_migrations` table) rather
than a bespoke `schema_migrations` table — first-class Cloudflare tooling
for exactly this, with no reason to duplicate it by hand.

```sql
CREATE TABLE owner (
    singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
    created_at                INTEGER NOT NULL,
    owner_email_hash          BLOB    NOT NULL CHECK (length(owner_email_hash) = 32), -- SHA-256(owner_email)
    db_prefix_hash            BLOB    NOT NULL CHECK (length(db_prefix_hash) = 32),   -- SHA-256(db_prefix)
    user_handle_hash          BLOB    NOT NULL CHECK (length(user_handle_hash) = 32), -- SHA-256(user_handle)
    wrapped_umk               BLOB    NOT NULL,
    kem_public_key            BLOB    NOT NULL,  -- composite KEM, docs/crypto.md
    wrapped_kem_private_key   BLOB    NOT NULL,  -- Encrypt, IKM = umk
    sign_version              INTEGER NOT NULL CHECK (sign_version = 1),
    sign_algorithm            TEXT    NOT NULL CHECK (sign_algorithm = 'ECDSA-P521-SHA512'),
    sign_public_key           BLOB    NOT NULL,
    wrapped_sign_private_key  BLOB    NOT NULL,  -- Encrypt, IKM = umk
    encrypted_credentials     BLOB    NOT NULL   -- {user_handle, display_name, db_prefix}
) STRICT;

-- Holds every per-row key (§1), wrapped by umk, referenced by the row it
-- protects.
CREATE TABLE key_store (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose     TEXT    NOT NULL CHECK (purpose IN
                     ('catalog_key', 'content_key', 'access_key',
                      'bookmark_key', 'share_key')),
    wrapped_key BLOB    NOT NULL,  -- Encrypt, IKM = umk; plaintext is 128 random bytes
    created_at  INTEGER NOT NULL
) STRICT;

-- Singleton. Points at the one R2 catalog object (docs/storage_layout.md);
-- holds no document data itself.
CREATE TABLE catalog (
    singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
    key_id       INTEGER NOT NULL REFERENCES key_store(id),
    catalog_blob BLOB    NOT NULL,  -- Encrypt, IKM = key_id's unwrapped key
                                     -- plaintext: {catalog_key, catalog_path}
    updated_at   INTEGER NOT NULL
) STRICT;

-- One row per document. Display metadata lives in the R2 catalog object
-- for fast bulk listing; this row holds what's needed to open and
-- decrypt the one document plus its live reading state.
CREATE TABLE documents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     INTEGER NOT NULL,
    content_key_id INTEGER NOT NULL REFERENCES key_store(id),
    content_blob   BLOB    NOT NULL,  -- Encrypt, IKM = content_key_id's unwrapped key
                                       -- plaintext: {content_key (128 random bytes), path}
    access_key_id  INTEGER NOT NULL REFERENCES key_store(id),
    access_blob    BLOB    NOT NULL,  -- Encrypt, IKM = access_key_id's unwrapped key
                                       -- plaintext: {last_accessed, last_cfi}
    access_version INTEGER NOT NULL DEFAULT 0  -- optimistic-concurrency counter for access_blob, §4
) STRICT;
CREATE TRIGGER trg_documents_delete_keys AFTER DELETE ON documents
BEGIN
  DELETE FROM key_store WHERE id = OLD.content_key_id OR id = OLD.access_key_id;
END;
CREATE TRIGGER trg_documents_key_purpose BEFORE INSERT ON documents
WHEN (SELECT purpose FROM key_store WHERE id = NEW.content_key_id) IS NOT 'content_key'
   OR (SELECT purpose FROM key_store WHERE id = NEW.access_key_id) IS NOT 'access_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for documents row');
END;

CREATE TABLE bookmarks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    key_id        INTEGER NOT NULL REFERENCES key_store(id),
    bookmark_blob BLOB    NOT NULL  -- Encrypt, IKM = key_id's unwrapped key
                                     -- plaintext: {cfi, page_number, preview}
) STRICT;
CREATE INDEX idx_bookmarks_document_id ON bookmarks(document_id, created_at, id);

-- Per-document cap of 20, enforced in the database rather than in every
-- caller. Ordered by id: monotonic, and immune to client clock skew.
CREATE TRIGGER trg_bookmarks_cap AFTER INSERT ON bookmarks
BEGIN
  DELETE FROM bookmarks WHERE document_id = NEW.document_id AND id NOT IN (
    SELECT id FROM bookmarks WHERE document_id = NEW.document_id
    ORDER BY id DESC LIMIT 20
  );
END;
-- Fires for both the cap eviction above and any explicit application
-- delete, so an evicted or deleted bookmark's key_store row never has to
-- be tracked and cleaned up by caller code.
CREATE TRIGGER trg_bookmarks_delete_key AFTER DELETE ON bookmarks
BEGIN
  DELETE FROM key_store WHERE id = OLD.key_id;
END;
CREATE TRIGGER trg_bookmarks_key_purpose BEFORE INSERT ON bookmarks
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'bookmark_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for bookmarks row');
END;

CREATE TABLE shares (
    share_id_hash     BLOB    PRIMARY KEY CHECK (length(share_id_hash) = 32),
    document_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
    object_path_hash  BLOB    NOT NULL CHECK (length(object_path_hash) = 32),
    key_id            INTEGER NOT NULL REFERENCES key_store(id),
    owner_blob        BLOB    NOT NULL,  -- Encrypt, IKM = key_id's unwrapped key
                                          -- plaintext: {share_id, share_content_key
                                          --             (128 random bytes), share_path}
    state             TEXT    NOT NULL CHECK (state IN ('creating', 'active', 'deleting')),
    created_at        INTEGER NOT NULL,
    UNIQUE (object_path_hash)
) STRICT;
CREATE TRIGGER trg_shares_delete_key AFTER DELETE ON shares
BEGIN
  DELETE FROM key_store WHERE id = OLD.key_id;
END;
CREATE TRIGGER trg_shares_key_purpose BEFORE INSERT ON shares
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'share_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for shares row');
END;
CREATE TRIGGER trg_catalog_key_purpose BEFORE INSERT ON catalog
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'catalog_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for catalog row');
END;
```

Without the purpose-check triggers, nothing would stop a caller from
referencing the wrong `key_store` row for a column — a `CHECK` constraint
can only validate a single table's own columns, not cross-reference
another table's. Each comparison uses `IS NOT` rather than `!=`
deliberately: if a `*_key_id` pointed at a `key_store` row that doesn't
exist at all, the subquery returns `NULL`, and `NULL != 'x'` evaluates to
`NULL` rather than true in SQL's three-valued logic — a trigger `WHEN`
clause that evaluates to `NULL` does not fire, so `!=` would let exactly
the case these triggers exist to catch slip through unabridged. `IS NOT`
is SQLite's NULL-safe inequality: `NULL IS NOT 'x'` is always true, so a
dangling reference aborts the insert just as reliably as a
wrong-but-present purpose does. Because the purpose-check triggers run
`BEFORE INSERT`, a new row's `key_store` entries must be inserted first —
inserting `documents` before its `content_key_id`/`access_key_id` rows
exist fails validation rather than the other way around.

Unlike plain SQLite, where `foreign_keys` defaults to off per connection,
D1 enforces it by default and doesn't allow turning it off: `PRAGMA
foreign_keys = OFF` runs without error but a subsequent read of the pragma
still reports it on, and a dangling reference is still rejected. `docs/
milestones.md`'s Milestone 1 confirmed this empirically (`worker/tests/
db.test.ts`) rather than assuming it — `bookmarks.document_id ON DELETE
CASCADE` and `shares.document_id ON DELETE RESTRICT` can be relied on. The
`key_store` cleanup/purpose-check triggers don't depend on this either
way — plain `CREATE TRIGGER` objects fire on the `INSERT`/`DELETE` event
itself, independent of the `foreign_keys` pragma, and in fact catch a
dangling `key_store` reference _before_ the `FOREIGN KEY` constraint would:
a `BEFORE INSERT` trigger runs first.

`documents.id`, `bookmarks.id`, and `key_store.id` are plain
`AUTOINCREMENT` integers rather than random tokens: every read and write
of these ids already goes through an authenticated Worker route scoped to
the one owner (`docs/auth.md`), so there is no untrusted caller in a
position to guess or care about an id — unlike R2 object-key segments
(`docs/storage_layout.md`) or `share_id` (`docs/sharing.md`), which exist
because they're addressed directly in a request outside this trust
boundary. `INTEGER PRIMARY KEY` is also a free rowid alias in SQLite/D1
requiring no separate index, unlike a random token, and gives the
bookmark cap trigger free, clock-skew-immune insertion ordering (`ORDER
BY id DESC`).

`shares.share_id_hash` and `object_path_hash` are the exception:
`docs/sharing.md`'s redemption endpoint needs a server-side lookup from a
redeemed capability to an `active` row, and revocation needs a state
transition, so `shares` keeps hash-based lookup columns and `state`
rather than reducing to owner-facing bookkeeping alone.

### 2.1 `catalog`

A fixed, flat shape — just what the Library screen needs to search and
browse without opening every document. The `catalog` row holds no
document data itself, only a pointer: its `catalog_blob` plaintext is
`{catalog_key, catalog_path}` (a fresh 128-byte content key and R2 path
segment, the same indirection `documents.content_blob` uses for EPUB
content). The actual list lives as its own R2 object at
`{db_prefix}/catalog/{catalog_path}` (`docs/storage_layout.md`),
encrypted under `catalog_key`: a brotli-compressed JSON array,
`[{document_id, catalog}, ...]`, where each `catalog` entry is:

```json
{
  "name": "original filename",
  "title": "the OPF sidecar's dc:title, or name if there wasn't one",
  "authors": ["every dc:creator, in order"],
  "subjects": ["every dc:subject, in order"],
  "publisher": "the OPF sidecar's dc:publisher, or null"
}
```

`name` is the original filename, not from the sidecar. Anything else the
sidecar carries isn't kept here — every valid EPUB already carries the
same core fields in its own internal package document, so the Reader gets
full metadata by parsing that directly once it has the document's bytes
in hand, rather than this duplicating it.

Everything needed to actually _open_ a document (`content_key`, its EPUB
`path`) is authoritative in `documents.content_blob`, fetched on demand
by `GET /v1/documents/:id/content` (§3) rather than the Worker's library
query, which never touches it. The catalog object exists purely to make
the Library screen's initial browse/search list fast: fetching and
decrypting one object that already holds every document's display
fields is strictly cheaper than N D1 rows and N per-row decrypts.

**Written by** the Python ingestion tool (`txt --ingest`) directly, over
D1's own HTTP query API (`txt/d1_client.py`) — not the Worker's
ticket/proof-gated `/v1/*` endpoints, which are designed for ephemeral
browser sessions rather than a long-running batch tool carrying its own
Cloudflare API token. Read directly by the browser.

**Write order and recovery.** The `documents` row (D1) and the catalog
object (R2) are two independent stores with no cross-system transaction.
Ingestion inserts the new `documents`/`key_store` rows into D1 _first_,
then rewrites the catalog object second. That ordering makes an
interruption between the two steps a safe, self-correcting state rather
than a broken one: a `documents` row that exists but isn't in the catalog
is simply invisible in the Library screen's list until the next ingestion
run — it isn't lost, and isn't reachable through a dangling reference
either. The reverse order would be worse: a catalog entry could reference
a `document_id` that doesn't exist in D1 yet, which the Library screen
would show and then fail to open. Ingestion re-runs are idempotent for
this reason: each run reconciles by checking for any `documents` row not
yet represented in the current catalog object and adding it.

A `documents` row alone can't say what to write into its catalog entry —
`name` is the original filename, never stored in D1 or R2 outside the
catalog itself. Ingestion keeps a local JSON checkpoint
(`{db_prefix}.ingest-checkpoint.json`, `--local-db-dir`) mapping
`{filename: document_id}`, written immediately after each successful D1
insert and before the catalog rewrite, so a run interrupted between the
two steps resumes from the checkpoint without re-uploading or
re-inserting. The catalog is also checked by filename first on every
run, independent of the checkpoint, so a lost checkpoint file causes at
worst a duplicate `documents` row on retry — never a skipped or
corrupted catalog entry.

**Scaling assumption.** Because catalog is one object holding _every_
document's display metadata, adding a single new book means fully
downloading, decrypting, re-encrypting, and re-uploading the entire
catalog object, not just appending an entry. This holds up fine at
personal-library scale (hundreds to low thousands of documents); a much
larger library would need per-document catalog entries instead, trading
the single-object-fetch benefit for incremental updates.

### 2.2 Reading state and bookmarks

An open becomes a qualifying reading session only after the Reader has
successfully loaded the document and remained visible for six seconds.
The timer pauses while the page is hidden. Until the grace period
completes, rendition relocation events update only an in-memory CFI
candidate; closing the Reader or switching books discards that candidate
without changing `last_accessed` or `last_cfi`.

When the grace period completes, one semantic mutation sets
`last_accessed` for recent-book sorting and stores the latest stable CFI
in `last_cfi`. After that, owner-driven relocation events update
`last_cfi` after a two-second debounce. Reading-state mutations are
coalesced and uploaded at most once every 15 seconds. The client attempts
a final flush when the page becomes hidden or the Reader switches books,
but only for a session that passed the grace period.

An EPUB Canonical Fragment Identifier (CFI) identifies a content position
independently of viewport width, font size, column count, and generated
page numbering. It remains the bookmark's navigation authority.
`page_number` is only the positive page number shown when the bookmark
was created; it is a nullable display hint because reflow can change page
numbering. On open, a non-null `last_cfi` is passed to the renderer's
`display(cfi)`; an invalid CFI falls back to the beginning.

A manual bookmark stores the current page-start CFI, the current display
page number, and a short nearby plain-text preview (capped at 100 UTF-8
bytes). Re-bookmarking the same CFI on the same document updates its page
number, preview, and display timestamp rather than adding a duplicate,
via `bookmarks`' `(document_id, cfi)` semantic identity. This is enforced
client-side, not by the Worker: `cfi` is inside `bookmark_blob`, and the
Worker never holds an unwrapped key to decrypt it (`docs/auth.md`'s trust
boundary). The client already has every bookmark's decrypted CFI from its
last listing fetch, so before creating a new bookmark it checks for a
matching CFI on the same document and, if found, deletes the old row
first. Bookmark creation and deletion are uploaded immediately.
`trg_bookmarks_cap` keeps at most 20 bookmarks per document, deleting the
oldest by `id`.

The EPUB content object referenced by a `documents` row is immutable.
That makes a structural CFI sufficient even when the renderer does not
emit optional text-location assertions. Replacing a book creates a new
content object/row rather than silently changing the document underneath
saved CFIs.

## 3. R2 read/write model

The browser sends individual, already-encrypted field values to
purpose-built `/v1/*` endpoints, which the Worker writes as parameterized
D1 statements inside a D1 transaction. There is no local database file
the browser downloads or uploads; reading the library requires a round
trip to the Worker rather than opening a fully offline local copy.

Because `access_blob` encrypts `last_accessed` and `last_cfi` together,
D1 cannot `ORDER BY` reading state — the Library screen's recency sort
happens client-side, after `GET /v1/documents` returns every `documents`
row and a separate `GET /v1/catalog` returns the catalog pointer row, for
the browser to decrypt and sort locally. The `GET /v1/documents` query
joins `documents` against `key_store` on `access_key_id` only, rather
than fetching each row's access key with a separate query per row,
avoiding an N+1 pattern that would multiply D1's per-query overhead
across the whole library on every Library-screen load.

It deliberately does *not* also join on `content_key_id`: D1 bills by
rows read, and a book's content key is only ever needed to actually open
that book, not to list it. `GET /v1/documents/:id/content` fetches one
document's `content_blob` + wrapped content key lazily, only when a
reader session opens that specific document — so a library of thousands
of books costs the Library screen one `key_store` row per book (the
access key, genuinely needed for every row's recency sort), not two,
regardless of how many of those books anyone ever actually opens. EPUB
content itself stays in R2, fetched and decrypted client-side only at
that same point.

## 4. Concurrency

A D1 transaction guarantees one statement or batch is atomic and
consistent; it says nothing about two _different_ requests, from two
devices, each independently reading then overwriting the same row.
`documents.access_blob` is the row most exposed to this: two devices
syncing reading position near-simultaneously could otherwise silently
lose whichever update loses the race to land last, with no error raised.

`documents.access_version` exists specifically to close this: every
update to `access_blob` is a conditional statement,

```sql
UPDATE documents SET access_blob = ?, access_version = access_version + 1
WHERE id = ? AND access_version = ?
```

using the version number the client's own read returned. `access_key_id`
itself never changes on these updates — the same per-row key encrypts
every successive `access_blob` for that row, with a fresh salt and IV
each time (`docs/crypto.md`); rotating it would mint a new `key_store`
row on every coalesced reading-state write with no trigger positioned to
clean up the old one, since the delete-cascading triggers fire on row
_deletion_, not on an in-place `*_key_id` change. Zero rows affected
means another write landed first; the Worker returns `412`, and the
client re-fetches the row, reapplies its semantic mutation, and retries,
up to a bounded limit.

Bookmark and share rows don't need this: they're created and deleted, not
read-modified-and-written-back in place, so there's no analogous
lost-update window for them.
