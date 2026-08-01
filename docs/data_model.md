# Data Model — InstantDB

This project stores data in a single InstantDB app — isolation between users is enforced entirely by InstantDB's permission rules (CEL expressions), not by physical separation into per-user databases. Identity comes from Firebase Auth; InstantDB maps a verified Firebase ID token to an InstantDB user by its email claim.

InstantDB itself holds only two things: `$users` (identity plus this account's wrapped key hierarchy) and a page-store (`dbMeta`/`pages`/`$files`/`activeReaders`) for **one SQLCipher-encrypted SQLite database per user**, paged remotely into R2. The actual application schema — documents, their content, bookmarks — lives entirely *inside* that per-user SQLCipher database (see "Per-user SQLCipher database schema" below) and is never visible to InstantDB as rows at all: InstantDB only ever sees opaque, client-encrypted page pointers.

Exact InstantDB API names below (`i.entity`, `unique()`, `.ref()`, permission rule shape) come from InstantDB's own docs (`instantdb.com/docs/modeling-data`, `/docs/permissions`, `/docs/auth/firebase`, `/docs/storage`) — verify against a real `npx instant-cli@latest push schema` before treating any of this as final. Two items below are explicitly flagged as unverified and worth confirming empirically before this design is trustworthy enough to build on.

## Entities

- **`$users`** (InstantDB's built-in auth entity) — one row per Firebase-authenticated identity, keyed by email. Also carries this account's key hierarchy directly, as custom attributes:
  - **`umk`** — base64, 128 random bytes, wrapped (`crypto.md`'s Blob format) under `user_root_key` — an external secret supplied by `creds.json`, never stored in InstantDB. Same role as the pre-InstantDB Turso design's `umk_store.umk`, just twice the byte length.
  - **`creds`** — base64, itself a Blob-wrapped JSON payload under `umk`. For the admin role:
    ```json
    {
      "r2_config": {
        "endpoint": "",
        "read_only_access_key_id": "",
        "read_only_secret_access_key": "",
        "read_write_access_key_id": "",
        "read_write_secret_access_key": "",
        "region": "",
        "bucket": ""
      },
      "path_key": "<base64, 128 random bytes>",
      "db_key": "<base64, 256 random bytes>"
    }
    ```
    `r2_config` is the same shape as the pre-InstantDB design's R2 connection info, needed to read/write this user's page objects directly in R2. `path_key` wraps each page-version's R2 object key before it's used as `$files.path` (see below). `db_key` is the raw SQLCipher key for this user's own database — **must be ≥256 raw bytes**: the leancrypto cipher provider (`sqlcipher/sqlcipher.js`, this repo's vendored WASM build) rejects anything shorter (`sqlcipher_cipher_ctx_key_derive: key must be supplied as a raw key blob x'...' of at least 256 bytes`, confirmed against the real WASM module) — unlike `umk`/`path_key`, which are just HKDF input keying material and have no such hard minimum. The shape of `creds` for non-admin roles isn't decided yet.
- **`users`** — an app-level profile entity, one-to-one linked to `$users`, holding `type: 'admin' | 'user'`. Kept separate from `$users` because `$users` is managed by InstantDB's auth system and isn't meant to carry arbitrary app fields (aside from the key-hierarchy attributes above, which are a deliberate, narrow exception — see `instant.perms.ts`'s `$users` rules for why). `type` is the permission system's role switch: a `'user'` can only view/create/update their own `dbMeta`/`pages`/`$files`/`activeReaders` rows (every rule is `isAdmin || isOwner`), an `'admin'` can act on any user's data, full stop — including operations (updating/deleting `pages`/`$files` rows) an ordinary owner is never allowed, since those violate the page store's append-only MVCC invariant and are meant only as a deliberate support/repair escape hatch. A `'user'` can update their own profile row but never their own `type` field (blocked via `request.modifiedFields`), so self-promotion to admin isn't possible through the normal write path.
- **`dbMeta`** — one row per user (one-to-one link to `users`): `currentVersion`, `pageCount`, `pageSize`, `needsGc` — the table of contents for that user's SQLCipher database's page store. `pageSize` matches that database's own page size (`PRAGMA page_size`, set to `32768` — see the schema's `PRAGMA` block below); SQLCipher's own `cipher_page_size` follows the same value.
- **`pages`** — one row per (owner, page_no, version) triple of the SQLCipher database above: `pageNo`, `version`, a synthetic `pageKey` (see below), linked to `users` (owner) and to `$files` (the page's pointer). A "page" here is a literal SQLite/SQLCipher page, not an arbitrary document chunk.
- **`$files`** (InstantDB's built-in storage entity) — one row per page-version's pointer. InstantDB only allows creating a `$files` row via `db.storage.uploadFile(path, file)` — `transact()` can update an existing row's `path` or delete the row, but never create one ([instantdb.com/docs/storage#link-files](https://instantdb.com/docs/storage#link-files)). `path` is **not** the same value as `pages.pageKey`: it's `"${auth.id}:" + <path_key-encrypted raw_path>`, where `raw_path` is a fresh Crockford-base32-lowercase encoding of 32 random bytes (this page-version's real R2 object key in the user's own bucket), encrypted via `crypto.md`'s Blob format (IKM = `path_key`) and base64url-encoded. The `auth.id` prefix stays plaintext deliberately — `instant.perms.ts` checks it via string-prefix, since no link to any other entity exists yet at upload time to ref-traverse instead; only the `raw_path` portion is encrypted. Uploaded file *content* is a trivial placeholder — the real page bytes (already SQLCipher/Ascon-Keccak-encrypted under `db_key` at the SQLite page level) live directly in R2, never in InstantDB. InstantDB only ever holds client-encrypted paths.
- **`activeReaders`** — one row per open read session: `snapshotVersion` (the version that session pinned at open) and `leaseExpiresAt`, linked to `users`. Lets garbage collection compute the oldest version still in use by any live reader.

### Why route pointers through `$files` instead of a plain column on `pages`

Two independent, separately-gated permission surfaces (`pages`' rules and `$files`' rules) rather than one — a bug in one rule set doesn't automatically expose the other. These are genuinely different mechanisms: `pages`' rules are ref-traversal (`auth.id in data.ref('owner.authUser.id')`), while `$files`' rules are a string-prefix check on `path` (ref traversal isn't available there at creation time). Now that `$files`' uploaded content is a trivial placeholder rather than meaningful payload, the reason to still use `$files` (instead of just adding an encrypted-pointer string attribute directly to `pages`) isn't a storage-content benefit — it's that `db.storage.uploadFile` is the only InstantDB mechanism that lets a client-supplied string be committed with its own independently-gated permission check, separate from `pages`' own.

## The composite-uniqueness problem (guarded insert)

InstantDB's `unique()` constraint is per-attribute, whole-namespace — it cannot express "unique per (owner, page_no, version)" directly, since every user's page store independently starts at page 1, version 1, and those would collide across users on a bare `pageNo`/`version` attribute. Fix: compute a synthetic `pageKey = "${ownerId}:${pageNo}:${version}"` client-side and mark *that* attribute `unique().indexed()`. Attempting to write a `pages` row whose `pageKey` already exists then fails outright — the guarded-insert guarantee for concurrent writers, enforced by the constraint itself, no hand-rolled SQL needed. `pageKey` is deterministic and plaintext by design (it only needs to be unique and computable, never secret) — unlike `$files.path`'s `raw_path`, which is random and encrypted precisely because it doubles as a real R2 object address.

## Commit protocol (MVCC write path)

1. Client stages dirty pages of its local SQLCipher database (via the vendored `sqlcipher.wasm` + `js-vfs.mjs` remote-page VFS) in memory.
2. On commit, for each dirty page: the SQLCipher layer has already produced that page's ciphertext (encrypted under `db_key`, Ascon-Keccak at the SQLite page level) — this *is* the R2 object body; no separate app-level wrapping of page content is needed.
3. Generate a fresh `raw_path = crockford_base32_lowercase(32 random bytes)` for this page-version, and `PUT` the page ciphertext to the user's own R2 bucket at that key (via `r2_config`'s read-write credentials).
4. Encrypt `raw_path` (`crypto.md`'s Blob format, IKM = `path_key`), base64url-encode the result, and compute `uploadPath = "${auth.id}:" + <that encoded ciphertext>`.
5. `await db.storage.uploadFile(uploadPath, <trivial placeholder body>)` — this *creates* the `$files` row (`path = uploadPath`). This is the only way to create a `$files` row and can't be folded into the `transact()` below; ownership at this point is enforced purely by `instant.perms.ts` checking `data.path.startsWith(auth.id + ':')`, since no link to any other entity exists yet.
6. One `db.transact([...])`: create the new `pages` row (`pageKey = "${auth.id}:${pageNo}:${version}"`, linked to `owner` and, via the upload's returned `data.id`, to the `$files` row through `pointerFile`), and CAS-bump `dbMeta.currentVersion` — all in the same atomic transaction. The CAS is enforced by a permission rule on `dbMeta`'s `update`: `newData.currentVersion == data.currentVersion + 1` — since the rule evaluates against the record's state at commit time inside the same transaction, a concurrent writer that already advanced the version makes the whole transaction fail.

   **New failure modes:** steps 3, 4/5, and 6 are three separate operations, not one atomic unit. A crash between step 3 and step 5 leaves a real R2 object with no `$files` pointer at all. A crash between step 5 and step 6 leaves an uploaded-but-unlinked `$files` row (no `pages` row points at it, though the R2 object from step 3 is fine since that upload already succeeded independently). Garbage collection needs sweeps for both (see below).

   **Unverified — confirm before relying on this:** whether `transact()` is truly serializable per-record, or just "check rules against a possibly-stale read, then apply." This is the one piece of this design load-bearing enough to need real verification.

## Read protocol

Query `pages` for `owner = self, pageNo = N, version <= target`, ordered by version descending, limit 1 (indexed `version` column enables the comparison/ordering), with the linked `$files.path` included in the same query result — no separate download needed, since `path` (unlike `$files`' content) carries the real pointer directly. Strip the `${auth.id}:` prefix, decrypt the remainder with `path_key` to recover `raw_path`, then `GET` that key from R2 — the real (SQLCipher-encrypted) page bytes, handed to the local SQLite/SQLCipher engine, which decrypts them with `db_key` as the page is loaded. Two hops: one InstantDB query, one R2 fetch.

## Garbage collection

Three sweeps now, since content and its pointer both live outside the metadata store, in two different places:

1. Once no `activeReaders` row still needs a superseded page version, delete the `pages` row.
2. Only then delete the `$files` row and the R2 object its decrypted `path` resolves to — in that order, so a crash mid-GC never leaves a `pages` row pointing at something already deleted.
3. Two orphan sweeps for the commit protocol's failure modes above, both needing a full R2 bucket listing diffed against everything currently reachable — structurally the same shape as the existing `txt.ts --clean-bucket` tool, just decrypting via `path_key` instead of that tool's `txt_key`/`txt_metadata_key` chain:
   - **Unlinked `$files` rows**: rows with no incoming `pointerFile` link, older than some grace period (long enough to outlast any in-flight commit's step 5-to-6 gap) — delete these and the R2 object their decrypted `path` resolves to.
   - **Untracked R2 objects**: real R2 objects with no `$files` row pointing at them at all (the step-3 `PUT` succeeded, but the step-5 upload or step-6 transact never completed) — same grace-period reasoning, delete directly.

Maintenance/GC tooling almost certainly needs to run via InstantDB's server-side Admin SDK (an app-level secret token bypassing permission rules entirely, analogous to Firebase's Admin SDK) rather than as an ordinary authenticated client — GC needs cross-user visibility that per-user CEL rules should never grant to a regular client.

## Auth

Every unlock requires a live Firebase sign-in (`getIdToken()` → `db.auth.signInWithIdToken()`), since InstantDB resolves identity from the token's email claim at session-creation time, not from a long-lived static credential. A non-interactive, file-based unlock flow would need Firebase custom tokens minted from a small backend instead — a server component this design otherwise avoids. After sign-in, the client reads its own `$users.umk`/`creds`, unwraps them (`user_root_key` → `umk` → `creds`), and uses `creds.db_key` to open (or create) its own per-user SQLCipher database via the vendored `sqlcipher.wasm` + `js-vfs.mjs` remote-page VFS, backed by the `dbMeta`/`pages`/`$files` page store above.

## Per-user SQLCipher database schema

Entirely opaque to InstantDB — these tables live inside the per-user SQLCipher-encrypted SQLite file itself (paged into R2 via the page store above), never as InstantDB rows. Because SQLCipher already encrypts every page of this file under `db_key`, individual columns don't need their own app-level `Blob`-wrapping the way every sensitive column in the pre-InstantDB Turso design did — the whole file is ciphertext at rest, InstantDB and R2 both included.

```sql
PRAGMA page_size = 32768;
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE txt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,  -- original filename
    metadata      BLOB,              -- brotli(JSON)
    last_part_num INTEGER,           -- this document's own read position; NULL until first opened
    last_accessed INTEGER,           -- unix ms; NULL until first opened
    created_at    INTEGER NOT NULL,  -- unix ms
    FOREIGN KEY (id, last_part_num) REFERENCES txt_parts(txt_id, part_num)
);

CREATE INDEX idx_txt_last_accessed ON txt(last_accessed DESC);

CREATE TABLE txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    content     BLOB    NOT NULL UNIQUE, -- brotli(raw text)
    UNIQUE (txt_id, part_num)
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num   INTEGER NOT NULL,
    line       INTEGER NOT NULL,
    preview    TEXT    NOT NULL CHECK (length(preview) <= 60),
    created_at INTEGER NOT NULL,  -- unix ms
    UNIQUE (txt_id, part_num, line)
);

CREATE INDEX idx_txt_bookmarks_txt_id_created_at ON txt_bookmarks(txt_id, created_at);

-- Enforces the per-document bookmark cap in the database instead of relying
-- on every caller to evict before inserting: after each insert, keep only
-- the 20 most recent rows (by created_at, id as tiebreak) for that txt_id
-- and delete the rest.
CREATE TRIGGER trg_txt_bookmarks_cap
AFTER INSERT ON txt_bookmarks
BEGIN
  DELETE FROM txt_bookmarks
  WHERE txt_id = NEW.txt_id
    AND id NOT IN (
      SELECT id FROM txt_bookmarks
      WHERE txt_id = NEW.txt_id
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    );
END;
```

### Pragmas

- **`page_size = 32768`** — must be set before any table is created (SQLite only honors a `page_size` change on an empty database, or via a subsequent `VACUUM`); this is what `dbMeta.pageSize`/`pages`/`$files` above are keyed to. A larger-than-default page size means fewer, bigger R2 objects per database for a given document size — fewer round-trips to page a large document in, at the cost of moving more bytes than strictly needed when only a small part of a page actually changed.
- **`auto_vacuum = INCREMENTAL`** — also only settable before any table exists. Lets freed pages (e.g. after deleting a document) be reclaimed via an explicit `PRAGMA incremental_vacuum` sweep without rewriting the whole file, unlike a full `VACUUM` — important here since every reclaimed page is also a page-store entry (`pages`/`$files`) and an R2 object to garbage-collect, not just local disk space.

### Tables

- **`txt`** — one row per document, replacing both the old `txt`/`txt_metadata` split: `name` and `metadata` (an OPF sidecar's parsed fields, when present, same shape as the old `txt_metadata.content` JSON entries) live directly on the document's own row now, rather than in one JSON blob per account. `last_part_num`/`last_accessed` are this document's own read position — since each user has their own database, there's no need for the old cross-account `txt_access` table (keyed by `txt_id`, capped, client-evicted) at all; a document's read position is just two columns on its own row.
- **`txt_parts`** — a document's content, chunked into ordered parts, same as before — except `content` (brotli-compressed raw text) is stored *directly* in this table now, not as a pointer to a separate R2 object. SQLCipher's own page-level encryption protects it; there's no per-part AEAD wrap or R2 round-trip anymore, since reading a part is just a local (decrypted-on-the-fly-by-SQLCipher) row read once the relevant pages are paged in. `UNIQUE(txt_id, part_num)` supports fetching a specific part or range in order; the `UNIQUE` constraint on `content` itself is a dedup safety net.
- **`txt_bookmarks`** — per-document bookmarks, replacing the old cross-account `bookmarks` JSON blob (keyed by `txt_id`, capped at `constants.BOOKMARK_LIMIT`, client-evicted with no DB-level enforcement). `trg_txt_bookmarks_cap` enforces the same cap (20) directly in the database after every insert — a real improvement over the old design, where nothing stopped a buggy or malicious caller from exceeding the cap; SQLite itself now guarantees it.
- The composite `FOREIGN KEY (id, last_part_num) REFERENCES txt_parts(txt_id, part_num)` on `txt` enforces, at the SQLite level, that a document's read position always points at a part that actually exists — impossible to express when read position lived in a separate cross-account JSON blob with no relational integrity at all.

## Design Notes

- **Isolation depends entirely on permission rules, not physical separation** — a rules bug is a cross-user data leak across the whole app, not contained to a single account. Worth weighing deliberately, not as an afterthought.
- **Two independent layers of encryption protect a page, deliberately**: SQLCipher's own page-level encryption (`db_key`) protects page *content*; `path_key` separately protects the R2 *address* a page lives at. Compromising one without the other isn't enough to read page content (no `db_key`) or to locate which R2 objects belong to which user/page (no `path_key`) — genuine defense-in-depth, not two copies of the same protection.
