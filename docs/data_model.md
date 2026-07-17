# Data Model

SQLite schema for the local `.db` file, shared by the CLI and the web UI.

```sql
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username_hash BLOB NOT NULL UNIQUE,  -- HMAC-SHA3-256(username_lookup_key, username); lookup only, see crypto.md
    pw_salt       BLOB NOT NULL,         -- 32 random bytes, fresh per user
    pw_hash       BLOB NOT NULL          -- PBKDF2-HMAC-SHA3-256(password, pw_salt, 1000 iterations); verification only, not a lookup key
);

CREATE TABLE IF NOT EXISTS umk_store (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    umk     BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(umk bytes)||tag; see crypto.md Blob Format
);

CREATE TABLE IF NOT EXISTS txt (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    txt_key BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(txt_key bytes)||tag, wrapped under owner's umk; see crypto.md Blob Format
);

CREATE TABLE IF NOT EXISTS txt_shares (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id  INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    txt_key BLOB    NOT NULL,       -- same txt_key bytes as txt.txt_key, wrapped under this recipient's umk; see crypto.md
    UNIQUE (txt_id, user_id)
);

CREATE TABLE IF NOT EXISTS txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    content  BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(brotli(plaintext))||tag; see crypto.md Blob Format
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
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id  INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bookmark BLOB NOT NULL   -- magic||version||salt||Ascon-Keccak(brotli(JSON))||tag; same scheme as txt_parts
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
    txt_metadata_key BLOB    NOT NULL,   -- magic||version||salt||Ascon-Keccak(txt_metadata_key bytes)||tag, wrapped under this user's umk; see crypto.md
    content          BLOB    NOT NULL    -- magic||version||salt||Ascon-Keccak(brotli(JSON {"<txt_id>": "<name>", ...}))||tag, keyed off txt_metadata_key (not umk directly); this user's own + shared-to-them txt_ids
);
```

## Notes

### `txt` is a bare id + ownership + key-envelope row

Filenames no longer live on `txt` at all (no `name`/`name_hmac` columns). `txt` mints a stable, unique `id` (via `AUTOINCREMENT`), anchors `ON DELETE CASCADE` for `txt_parts`/`part_count`/`txt_access`/`bookmarks`, holds the owning `user_id`, and holds the file's encrypted `txt_key` (the *owner's* wrapped copy). Every file has exactly one owner — see `txt_shares` below for how other users get read access without becoming co-owners. Filenames live in the owner's (and each recipient's) `txt_metadata` row — see [crypto.md](crypto.md).

### `txt_shares` grants read access without exposing the owner's `umk`

Sharing a file re-wraps the *same* `txt.txt_key` bytes under a recipient's own `umk` and stores that as a new row here — one per `(txt_id, user_id)` grant, enforced `UNIQUE`. This means a recipient can decrypt exactly the files they've been granted, never the owner's `umk` itself (so no other files of the owner's are exposed). Revoking access is `DELETE FROM txt_shares WHERE txt_id=? AND user_id=?`; also clean up that user's `txt_access`/`bookmarks` rows for the `txt_id` and remove the entry from their `txt_metadata` at the same time, since they can no longer decrypt it. Revocation has no forward secrecy: it stops future decryption via this grant, it does not invalidate a plaintext copy the (former) recipient already retrieved before revocation. See [crypto.md](crypto.md) for the wrapping mechanics and the CLI-mediated share operation, and [security.md](security.md) for what revocation does and does not guarantee.

### `txt_access` and `bookmarks` carry `user_id` again, because of sharing

These were briefly simplified to key on `txt_id` alone under the assumption that only a file's owner could ever decrypt it. `txt_shares` breaks that assumption — multiple users can now read the same file — so both tables (and the bookmark-eviction trigger) are keyed on `(txt_id, user_id)` again: each reader gets their own read position and their own 12-bookmark cap per file, independent of any other reader.

### `txt_metadata` is one row per user, rewritten as a whole per ingest or share

Each user has exactly one `txt_metadata` row (`user_id` is `UNIQUE`), holding a JSON map of `txt_id → name` for every file they can open — their own plus anything shared to them — wrapped under a dedicated `txt_metadata_key` (itself wrapped under that user's `umk`, not used to encrypt `content` directly; see [crypto.md](crypto.md)). An ingest run for a given user decrypts that user's row once at the start, applies all of that run's name additions in memory, and writes it back once at the end — not once per file. A share operation does the same for the *recipient's* row, adding just the one shared entry. `--force` re-ingests don't touch it (the filename doesn't change, only `txt_id` is reused).

### `users` table splits lookup from password verification

`username_hash` is a deterministic, directly-queryable lookup key (`SELECT id FROM users WHERE username_hash = ?`), computed with a key derived from `root_master_key` — not a plain unkeyed hash of the username, since that would let anyone holding just the `.db` file (no `creds.json`) dictionary-guess which usernames exist. `pw_salt`/`pw_hash` are a separate, per-user-salted password hash (PBKDF2-HMAC-SHA3-256, 1000 iterations) used only to *verify* a password once the row's already been found by `username_hash` — never as a lookup key itself, since a KDF can't be recomputed cheaply enough to scan the whole table. See [crypto.md](crypto.md) for both formulas and where `root_master_key`/`username_salt` come from.
