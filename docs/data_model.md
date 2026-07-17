# Data Model

SQLite schema for the local `.db` file, shared by the CLI and the web UI.

```sql
CREATE TABLE IF NOT EXISTS users (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS umk_store (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    umk     BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(umk bytes)||tag; see crypto.md Blob Format
);

CREATE TABLE IF NOT EXISTS txt (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    txt_key BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(txt_key bytes)||tag; see crypto.md Blob Format
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
    txt_id        INTEGER PRIMARY KEY REFERENCES txt(id) ON DELETE CASCADE,
    last_part_num INTEGER NOT NULL DEFAULT 1,
    last_accessed INTEGER NOT NULL       -- Unix timestamp in milliseconds
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id  INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    bookmark BLOB NOT NULL   -- magic||version||salt||Ascon-Keccak(brotli(JSON))||tag; same scheme as txt_parts
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_txt_id ON bookmarks(txt_id);

CREATE TRIGGER IF NOT EXISTS trg_limit_bookmarks_per_file
BEFORE INSERT ON bookmarks
WHEN (SELECT COUNT(*) FROM bookmarks WHERE txt_id = NEW.txt_id) >= 12
BEGIN
    DELETE FROM bookmarks
    WHERE id = (
        SELECT id FROM bookmarks
        WHERE txt_id = NEW.txt_id
        ORDER BY id ASC LIMIT 1
    );
END;

CREATE TABLE IF NOT EXISTS txt_metadata (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    content BLOB NOT NULL   -- magic||version||salt||Ascon-Keccak(brotli(JSON {"<txt_id>": "<name>", ...}))||tag; this user's own txt_ids only
);
```

## Notes

### `txt` is a bare id + ownership + key-envelope row

Filenames no longer live on `txt` at all (no `name`/`name_hmac` columns). `txt` mints a stable, unique `id` (via `AUTOINCREMENT`), anchors `ON DELETE CASCADE` for `txt_parts`/`part_count`/`txt_access`/`bookmarks`, holds the owning `user_id`, and holds the file's encrypted `txt_key`. Every file belongs to exactly one user — there is no shared/multi-owner file. Filenames live in that owning user's `txt_metadata` row — see [crypto.md](crypto.md).

### `txt_access` and `bookmarks` no longer carry `user_id`

Since ownership is strictly 1:1 (a file's content can only be decrypted via its owning user's `umk`, per [crypto.md](crypto.md)'s key hierarchy), only that owning user could ever produce a meaningful read-position or bookmark for a given `txt_id` — no other user can decrypt the content to bookmark it in the first place. So `user_id` was dropped from both tables as redundant with `txt.user_id`: `txt_access` is now keyed by `txt_id` alone (`PRIMARY KEY`), and `bookmarks`'/its eviction trigger's scoping is by `txt_id` alone. Join through `txt.user_id` if you need the owner.

### `txt_metadata` is one row per user, rewritten as a whole per ingest run

Each user has exactly one `txt_metadata` row (`user_id` is `UNIQUE`), holding a JSON map of only *that user's own* `txt_id → name` entries, wrapped under that user's `umk` (see [crypto.md](crypto.md)). An ingest run for a given user should decrypt that user's row once at the start, apply all of that run's name additions in memory, and write it back once at the end — not once per file. `--force` re-ingests don't touch it (the filename doesn't change, only `txt_id` is reused).

### `users` table identifies users by `hash`, not a plaintext name

`users.hash` implies some credential-based lookup (e.g. a password/passphrase hash) rather than a plain display name — but the hashing scheme itself (algorithm, salt/iteration handling) isn't specified yet, and neither is the login/session flow that would use it. [crypto.md](crypto.md) doesn't yet cover this hash, since it's a different kind of primitive than the AEAD/HKDF/HMAC scheme used for content — flagging both as open items rather than inventing a scheme unasked.
