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
user_root_key (per-user config secret, ≥256 random bytes, base64; not stored in Turso)
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

- `user_root_key` is a per-user secret (at least 256 random bytes, base64-encoded) held in config, not in Turso — each user has their own, not a value shared across the corpus. It is the IKM used to wrap and unwrap that user's `umk`.
- `umk` is 64 random bytes generated once when a user's `umk_store` row is created. Unwrapped, it is used directly as HKDF IKM (no intermediate per-purpose derivation) to wrap and unwrap both `txt.txt_key` and `txt_metadata.txt_metadata_key`.
- `txt_key` and `txt_metadata_key` are themselves used directly as IKM to encrypt/decrypt the content columns they protect. `txt_key` — the document's own (unwrapped) key — is the IKM for both `txt_parts.content` and `bookmarks.bookmark`, since bookmarks are scoped per-`txt_id`. `txt_metadata_key` is the IKM for `txt_metadata.content`.
- Every wrapped-key and content blob uses the blob format, AEAD, and KDF mechanics from [crypto.md](crypto.md) uniformly — the same Encrypt/Decrypt procedure, just with a different IKM and payload at each layer.
- `username_lookup_key` (referenced in the `username_hash` comment, not a table column) is also a per-user config secret: 32 random bytes, base64-encoded. Login computes `username_hash = HMAC-SHA3-256(username_lookup_key, username)` and looks the row up by that unique value.
- Login flow: look up the user's row (via `username_hash`, using that user's `username_lookup_key`), then verify the supplied password by recomputing `PBKDF2-HMAC-SHA3-256(password, pw_salt)` and comparing to the stored `pw_hash` for that row's `user_id`. `pw_hash`/`pw_salt` exist purely for this verification step — they authenticate the user and resolve the correct `user_id`, and are never used as IKM anywhere in the key hierarchy above. A server that leaks only the `users` table cannot unwrap any `umk`.

## Design Notes / Open Questions

- **Per-user root key blast radius.** Since `user_root_key` (and `username_lookup_key`) are per-user rather than shared, compromising one user's config secret only exposes that user's `umk`/`txt_key`/`txt_metadata_key` chain, not the whole corpus.
- **Where per-user config lives.** The per-user `user_root_key`/`username_lookup_key` pairs are held in a JSON config file, keyed per user — not in Turso.
