# Data Model — Design

Each user, as provisioned in docs/auth.md, has exactly one SQLCipher database: a single file in R2 at `s3://{bucket}/{db_path}`. The client downloads it, opens it locally with `db_master_key`, reads and writes it there, and — if anything changed — uploads it back to the same key. There is no live database connection: the file is the database.

A document's own content is not in that file. Each document is a separate encrypted object in R2, referenced by a row in the `txt` table.

---

## 1. Where things live

`user_handle`, `db_path`, `db_prefix`, and `db_master_key` (256 random bytes, base64-encoded — the SQLCipher key for the file in §1) all come from encrypted `cred_store.content` after `/v1/keys` (docs/auth.md §2 and §5). That endpoint also returns a 24-hour Worker-signed binding ticket. The client submits the ticket, decrypted handle, two paths, and a fresh versioned P-521 proof to `/v1/r2-token` for handle binding, possession checking, pair-binding authorization, and scoped R2 credentials. Renewing R2 credentials requires neither another Firebase token nor a Turso lookup while the ticket remains valid.

```
s3://{bucket}/{db_path}
s3://{bucket}/{db_prefix}/{txt.txt_prefix}/{txt.path}
s3://{bucket}/{db_prefix}/shared/{txt_shares.share_prefix}/{txt_shares.share_path}
```

The first is the user's whole SQLCipher database. The second is one immutable owner document per `txt` row. The third is an independently encrypted copy created only by the administrator for one public share. Every random path component is stored as 32 raw bytes and rendered as 52 lowercase base32-Crockford characters. A shared copy never reuses the owner's `txt_key`, `txt_prefix`, or `path`.

`{bucket}` is not a secret, but the client carries no R2 connection details of its own — `bucket`, along with the endpoint and region, travels in the `/v1/r2-token` response itself (docs/auth.md §4.2), the client's only source of R2 configuration.

---

## 2. The read-write round trip

1. The client authenticates and obtains `db_path`, `db_prefix`, `db_master_key`, an exact-`db_path` read-write credential, and a `{db_prefix}/*` credential (read-only for ordinary accounts, read-write for the configured administrator; docs/auth.md).
2. It downloads `s3://{bucket}/{db_path}` without HTTP caching and retains the response `ETag` alongside the bytes. If no object exists yet at that key, it creates a fresh database from the schema below and records that the next upload is a create.
3. It opens the database with `db_master_key`, reapplies `PRAGMA page_size = 16384` before the first schema access, and runs the idempotent schema check.
4. It reads document metadata and reading state locally. Document content is downloaded and decrypted separately through the prefix credential.
5. A reading-state change is represented as a semantic mutation — update last access/location, add or remove a bookmark — and serialized through one write queue in the page. The mutation runs in a SQLite transaction.
6. The client uploads the whole encrypted database with `If-Match: <downloaded ETag>`. Creating a previously absent database uses `If-None-Match: *`. A successful response supplies the new current `ETag`.
7. `412 PreconditionFailed` means another tab or device committed first. The client downloads and opens the latest database, reapplies the same semantic mutation, and retries with the new `ETag`, up to a bounded limit. It never merges encrypted bytes or blindly overwrites the winner.

R2 is the durable source of truth; the browser's open database is only a working copy. The in-page queue prevents overlapping writes from one session, while the conditional upload prevents lost updates across tabs and devices. If a write still cannot be committed after bounded retries, the UI keeps it visibly unsaved and offers retry rather than claiming success. Credential expiry is handled before retrying data operations: the client refreshes both temporary credentials through `/v1/r2-token` and does not treat an authorization failure as a database conflict.

---

## 3. Schema

The database's persisted page size is fixed at 16 KiB when a fresh database is created (§2 step 2). Because SQLCipher encrypts page 1, every connection must still issue `PRAGMA page_size = 16384` immediately after applying the key and before its first schema read; on an existing database this configures the connection rather than rewriting the file:

```sql
PRAGMA page_size = 16384;

CREATE TABLE txt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_key       BLOB    NOT NULL,   -- 128 random bytes; the AEAD key for this document's content object
    txt_prefix    BLOB    NOT NULL,   -- 32 random bytes; first key segment of the content object (§1)
    path          BLOB    NOT NULL,   -- 32 random bytes; second key segment of the content object (§1)
    catalog       BLOB    NOT NULL,   -- brotli(JSON): {name, title, authors, subjects, publisher} (§3.1)
    last_accessed INTEGER NOT NULL,   -- unix ms; initially 0, set after the Reader's six-second grace period
    last_cfi      TEXT,               -- last stable EPUB CFI reported by the rendition, null until first location
    created_at    INTEGER NOT NULL    -- unix ms
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    cfi        TEXT    NOT NULL,
    page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
    preview    TEXT    NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 100),
    created_at INTEGER NOT NULL,   -- unix ms, display only
    UNIQUE (txt_id, cfi)
);
CREATE INDEX idx_txt_bookmarks_txt_id ON txt_bookmarks(txt_id, id);

CREATE TABLE txt_shares (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id            INTEGER NOT NULL REFERENCES txt(id) ON DELETE RESTRICT,
    share_id          BLOB NOT NULL CHECK (length(share_id) = 32),
    share_content_key BLOB NOT NULL CHECK (length(share_content_key) = 128),
    share_prefix      BLOB NOT NULL CHECK (length(share_prefix) = 32),
    share_path        BLOB NOT NULL CHECK (length(share_path) = 32),
    state             TEXT NOT NULL CHECK (state IN ('creating', 'active', 'deleting')),
    created_at        INTEGER NOT NULL,
    UNIQUE (share_id),
    UNIQUE (share_prefix, share_path)
);
CREATE INDEX idx_txt_shares_txt_id ON txt_shares(txt_id, state, id);

CREATE TABLE txt_schema_migrations (
    name TEXT PRIMARY KEY
);

-- Per-document cap of 20, enforced in the database rather than in every caller.
-- Ordered by id: monotonic, and immune to client clock skew.
CREATE TRIGGER trg_txt_bookmarks_cap
AFTER INSERT ON txt_bookmarks
BEGIN
  DELETE FROM txt_bookmarks
  WHERE txt_id = NEW.txt_id
    AND id NOT IN (
      SELECT id FROM txt_bookmarks
      WHERE txt_id = NEW.txt_id
      ORDER BY id DESC
      LIMIT 20
    );
END;
```

### 3.1 `catalog`

A fixed, flat shape — just what the Library screen needs to search and browse without opening every document:

```json
{
  "name": "original filename",
  "title": "the OPF sidecar's dc:title, or name if there wasn't one",
  "authors": ["every dc:creator, in order"],
  "subjects": ["every dc:subject, in order"],
  "publisher": "the OPF sidecar's dc:publisher, or null"
}
```

`name` is the original filename, not from the sidecar. Anything else the sidecar carries (description, language, series, whatever else Calibre wrote) isn't kept here — every valid EPUB already carries the same core fields in its own internal package document, so the Reader gets full metadata by parsing that directly once it has the document's bytes in hand, rather than this column duplicating it.

The whole file is already encrypted by SQLCipher under `db_master_key`, so `catalog` is only brotli-compressed, not separately encrypted — there is no second key for it to be wrapped under.

### 3.2 Reading state and bookmarks

An open becomes a qualifying reading session only after the Reader has successfully loaded the document and remained visible for six seconds. The timer pauses while the page is hidden. Until the grace period completes, rendition relocation events update only an in-memory CFI candidate; closing the Reader or switching books discards that candidate without changing `last_accessed` or `last_cfi`. The initial relocation event establishes the candidate position but never marks the database dirty by itself.

When the grace period completes, one semantic mutation sets `last_accessed` for recent-book sorting and stores the latest stable CFI in `last_cfi`. After that, user-driven relocation events update `last_cfi` after a two-second debounce. Reading-state mutations are coalesced and uploaded at most once every 15 seconds to avoid replacing the whole database on every page turn. The client attempts a final flush when the page becomes hidden or the Reader switches books, but only for a session that passed the grace period; correctness does not depend solely on an unload-time request.

An EPUB Canonical Fragment Identifier (CFI) identifies a content position independently of viewport width, font size, column count, and generated page numbering. It remains the bookmark's navigation authority. `page_number` is only the positive page number shown when the bookmark was created; it is a nullable display hint because reflow can change page numbering. On open, a non-null `last_cfi` is passed to the renderer's `display(cfi)`; an invalid CFI falls back to the beginning without discarding the rest of the database.

A manual bookmark stores the current page-start CFI, the current display page number, and a short nearby plain-text preview. Re-bookmarking the same `(txt_id, cfi)` updates its page number, preview, and display timestamp rather than adding a duplicate. Bookmark creation and deletion are uploaded immediately; deletion is replayed by `(txt_id, cfi)` during conflict recovery rather than by local numeric `id`.

`preview` is capped at 100 UTF-8 bytes rather than 100 characters (`CAST(... AS BLOB)`), since one character can occupy up to four bytes. `trg_txt_bookmarks_cap` keeps at most 20 bookmarks per document, deleting the oldest by `id`. `AUTOINCREMENT` makes that ordering monotonic even after manual deletions and avoids relying on client clocks. `idx_txt_bookmarks_txt_id` supports listing one document's bookmarks and the cap trigger without a table scan.

The EPUB content object referenced by a `txt` row is immutable. That makes a structural CFI sufficient even when the renderer does not emit optional text-location assertions. Replacing a book creates a new content object/row rather than silently changing the document underneath saved CFIs.

### 3.3 Administrator shares

Only the account whose Firebase uid equals the Worker's trusted `ADMIN_UID` can create or delete shares. Creation generates a 32-byte `share_id`, a fresh 128-byte `share_content_key`, and independent 32-byte `share_prefix` and `share_path` values. The browser decrypts the owner object locally, re-encrypts the EPUB under `share_content_key`, and uploads it immutably with `If-None-Match: *` to `{db_prefix}/shared/{share_prefix}/{share_path}`.

The `creating` state is committed before upload and a completed upload becomes `active`. Copying the URL registers the share in D1. Deletion changes the local row to `deleting`; the Worker validates the bound path, deletes the R2 object, removes the D1 row, and then the browser removes the local row. A failed Worker deletion leaves the local entry retryable. There is no revoked state, registry tombstone, or `object_etag`: share paths are immutable, never reused, and deletion is unconditional. `ON DELETE RESTRICT` prevents deleting the source book before its shares are removed.

`--clean-bucket` never deletes objects below a reachable account's `{db_prefix}/shared/` namespace. Only the authenticated Worker deletion flow may remove them: the generic cleaner cannot establish that a shared object is absent from D1, and an R2 rollback could hide an otherwise-live `txt_shares` row from its allowlist scan.

The Library exposes Shares below Recent only for the administrator. Shares shows the source book's normal row metadata with Copy and Delete actions. Browse/All Books adds a Share action beside search; selecting books creates independent shares. Copy asks the Worker to register the live D1 row and creates a fresh opaque grant; the resulting URL is returned to the clipboard and is not stored. Its fragment contains the random share capability, opaque encrypted-path grant, and client-side decryption key. D1 stores only 32-byte SHA-256 capability and object-path BLOBs plus the creation timestamp; deleting a share removes that row. Anonymous reading state and bookmarks remain browser-local under a local-storage key containing the base64url share id and never mutate the owner's `db_path`.

### 3.4 Migration

Migration is driven by inspecting the tables, columns, indexes, and triggers that are actually present. Fresh databases are created directly from the complete schema above; existing databases receive only the missing changes.

`txt --update-db admin_creds.json --local-db-dir DIR --verbose` migrates every reachable database transactionally and idempotently before the writing UI is deployed:

1. If `txt.metadata` is present, add and populate `catalog`, then drop `metadata` as in the existing catalog migration.
2. Add nullable `txt.last_cfi` when absent.
3. If the legacy `txt_bookmarks(line, ...)` table exists, require it to be empty because a line number cannot be converted reliably to a CFI, then replace it with the CFI table, index, and trigger above. A nonempty legacy table aborts that account rather than losing data.
4. Add nullable `txt_bookmarks.page_number` when absent.
5. Create and validate `txt_shares` and its lookup index when absent.
6. Ensure `txt_schema_migrations` exists. If it lacks `reset_initial_last_accessed`, correct the original ingestion bug by resetting every existing `txt.last_accessed` to `0`, then record that named migration in the same transaction. Subsequent runs see the marker row and never repeat the reset. A browser opening an old database may create the marker table but does not insert this row, so browser-before-CLI deployment order cannot accidentally skip the reset. Fresh databases record the marker immediately because new ingestion initializes `last_accessed` to `0` rather than `created_at`.
7. `VACUUM`, write the local checkpoint, and conditionally upload the database only after every step succeeds.

The command reaches the administrator through its self-owned `cred_store` row and every ordinary account through the administrator-owned backup guaranteed by docs/auth.md. Each ordinary-user backup includes that user's `user_root_key`, encrypted under the administrator's `umk`; self-owned payloads and the administrator's own payload do not. It verifies that every required row is present and decryptable before making changes. R2 is always its input source; `--local-db-dir` contains checkpoints for inspection only, never a later upload base. A changed database is uploaded with `If-Match` against the downloaded ETag, so a concurrent browser commit aborts without data loss and the operator reruns from the new remote object. An already-migrated database is not uploaded. Idempotent account provisioning installs path bindings and signing keys; `--update-ctl` installs encrypted handles, `users.user_handle_hash`, and its unique index. Neither operation belongs to `--update-db`, and there is no `users.user_handle` column.

`txt_key` is unrelated to `db_master_key`: it is the AEAD key for one document's content object, generated fresh per document, so leaking one document's key exposes nothing about any other document or about the database file itself.

---

## 4. Deployment order

1. Bring the control plane to the current encrypted-handle, path-binding, and P-521 signing schema using docs/auth.md §3 and §9.
2. Run `--update-db` against every reachable R2 database before deploying UI code that creates bookmarks or shares.
3. Configure R2 CORS for `GET`, `PUT`, conditional-write headers, range reads, and exposed `ETag` as shown in `docs/r2-cors.example.json`.
4. Create and migrate the D1 `SHARE_REGISTRY` binding before enabling public share links.
5. Deploy the Worker and UI together, then test credential renewal, conditional database conflicts, bookmark persistence, and the complete share copy/read/delete flow.
