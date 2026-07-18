# Data Model

Backend: Turso (libSQL/SQLite-compatible cloud). Every column that holds user content, a wrapped key, or anything else sensitive stores an opaque encrypted blob in the wire format defined in [crypto.md](crypto.md) — `magic || version || salt || ciphertext || tag`. Turso itself only ever sees ciphertext; all encryption/decryption and key unwrapping happens in the client (or admin tooling), never in the database.

## Schema

```sql
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username_hash BLOB NOT NULL UNIQUE,  -- HMAC-SHA3-256(username_lookup_key, username)
    pw_salt       BLOB NOT NULL,         -- 32 random bytes, fresh per user
    pw_hash       BLOB NOT NULL          -- PBKDF2-HMAC-SHA3-256(password, pw_salt, 1000 iterations)
);

CREATE TABLE IF NOT EXISTS umk_store (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    umk     BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(umk bytes)||tag
);

CREATE TABLE IF NOT EXISTS txt (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    txt_key BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(txt_key bytes)||tag, wrapped under owner's umk
);

CREATE TABLE IF NOT EXISTS txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    content  BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(brotli(plaintext))||tag
);

CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id_part_num ON txt_parts(txt_id, part_num);

CREATE TABLE IF NOT EXISTS part_count (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS txt_access (
    txt_id        INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_part_num INTEGER NOT NULL DEFAULT 1,
    last_accessed INTEGER NOT NULL,      -- Unix timestamp in milliseconds
    PRIMARY KEY (txt_id, user_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bookmark BLOB NOT NULL   -- magic||version||salt||Ascon-Keccak(brotli(JSON))||tag
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_txt_id_user_id ON bookmarks(txt_id, user_id);

CREATE TRIGGER IF NOT EXISTS trg_limit_bookmarks_per_file
BEFORE INSERT ON bookmarks
WHEN (SELECT COUNT(*) FROM bookmarks WHERE txt_id = NEW.txt_id AND user_id = NEW.user_id) >= 12
BEGIN
    DELETE FROM bookmarks
    WHERE id = (
        SELECT id FROM bookmarks
        WHERE txt_id = NEW.txt_id AND user_id = NEW.user_id
        ORDER BY id ASC LIMIT 1
    );
END;

CREATE TABLE IF NOT EXISTS txt_metadata (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    txt_metadata_key BLOB    NOT NULL,   -- magic||version||salt||Ascon-Keccak(txt_metadata_key bytes)||tag, wrapped under owner's umk
    content          BLOB    NOT NULL    -- magic||version||salt||Ascon-Keccak(brotli(JSON))||tag
);
```

### Tables

- **`users`** — one row per account. `username_hash` is a keyed HMAC (not a general-purpose hash) so the username lookup key can be rotated independently of the password KDF; it's what the login query looks up by, never the plaintext username. `pw_salt`/`pw_hash` are login-verification material only — they authenticate the user to the server and are not part of the encryption key chain (see Key Hierarchy).
- **`umk_store`** — one row per user, holding that user's master key (UMK), itself encrypted at rest.
- **`txt`** — one row per document (a "txt"). `txt_key` is the document's own key material, wrapped under the owner's UMK.
- **`txt_parts`** — a document's content, chunked into ordered parts (`part_num`) so large documents aren't loaded/decrypted as a single blob. `idx_txt_parts_txt_id_part_num` supports fetching a specific part or range in order.
- **`part_count`** — a denormalized count of `txt_parts` rows per `txt_id`, so pagination UI (e.g. "part 3 of 47") doesn't require a `COUNT(*)` scan.
- **`txt_access`** — per-(user, txt) read position, keyed by the pair so each user tracks their own progress through a document independently. `last_part_num`/`last_accessed` are plaintext — reading progress and activity timestamps are not treated as confidential.
- **`bookmarks`** — per-(user, txt) bookmark list. The FIFO trigger caps each user at 12 bookmarks per document by evicting the oldest (lowest `id`) on overflow, so storage stays bounded without an application-side cleanup step.
- **`txt_metadata`** — one row per user: `txt_metadata_key` (wrapped under the owner's UMK, same pattern as `txt.txt_key`) protects `content`, a single encrypted JSON blob per user (e.g. a filename/document index), rather than one row per document.

## Key Hierarchy

```
user_root_key (config secret, not stored in Turso)
    │  IKM for HKDF, wraps/unwraps —
    ▼
umk  (umk_store.umk — 64 random bytes, generated once per user)
    │  used directly as IKM for HKDF, wraps/unwraps —
    ├──▶ txt_key            (txt.txt_key — per document)
    │        │  used directly as IKM —
    │        └──▶ txt_parts.content, bookmarks.bookmark  (per document's content and bookmarks)
    │
    └──▶ txt_metadata_key   (txt_metadata.txt_metadata_key — per user)
             │  used directly as IKM —
             └──▶ txt_metadata.content
```

- `user_root_key` is a single secret held in application config (an environment variable or secret store), not in the database. It is the IKM used to wrap and unwrap every user's `umk`.
- `umk` is 64 random bytes generated once when a user's `umk_store` row is created. Unwrapped, it is used directly as HKDF IKM (no intermediate per-purpose derivation) to wrap and unwrap both `txt.txt_key` and `txt_metadata.txt_metadata_key`.
- `txt_key` and `txt_metadata_key` are themselves used directly as IKM to encrypt/decrypt the content columns they protect (`txt_parts.content`/`bookmarks.bookmark`, and `txt_metadata.content`, respectively).
- Every wrapped-key and content blob uses the blob format, AEAD, and KDF mechanics from [crypto.md](crypto.md) uniformly — the same Encrypt/Decrypt procedure, just with a different IKM and payload at each layer.

## Design Notes / Open Questions

- **Single shared root key.** `user_root_key` is one secret shared across all users. Compromise of that one config value unwraps every user's `umk` and therefore every `txt_key`/`txt_metadata_key` in the system — the blast radius is the whole corpus, not one account. Worth weighing against a per-user root key (e.g. derived from something user-specific) if that single-secret exposure is a concern.
- **`txt_parts.content`/`bookmarks.bookmark` IKM.** The schema comments state `txt_key` and `txt_metadata_key` are "wrapped under owner's umk," but don't say explicitly what encrypts `txt_parts.content` and `bookmarks.bookmark`. This doc assumes the natural reading — the document's own (unwrapped) `txt_key` is used directly as IKM for both, since bookmarks are scoped per-`txt_id` — but that should be confirmed against the implementation.
- **`username_lookup_key`.** Referenced in the `username_hash` comment but not shown as a table column — presumably another config-held secret alongside `user_root_key`. Worth documenting its provenance/rotation story once settled.
- **Login vs. encryption separation.** `pw_hash`/`pw_salt` authenticate the user to the server; they are never used as IKM anywhere in the key hierarchy above. A server that only leaks the `users` table (not `user_root_key`) cannot unwrap any `umk`.
