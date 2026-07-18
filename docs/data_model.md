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

CREATE TABLE IF NOT EXISTS key_store (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    pub_key  BLOB    NOT NULL,       -- raw composite ML-KEM-1024 + X448 public key, 1624 bytes
    priv_key BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(priv_key bytes)||tag, wrapped under owner's umk
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

CREATE TABLE IF NOT EXISTS txt_shares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id        INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kem_ct        BLOB    NOT NULL,   -- ML-KEM-1024 encapsulation ciphertext, 1568 bytes, raw (public value)
    eph_x448_pub  BLOB    NOT NULL,   -- sender's ephemeral X448 public key, 56 bytes, raw (public value)
    txt_key       BLOB    NOT NULL,   -- same txt_key bytes as txt.txt_key, asymmetrically wrapped for this recipient (see crypto.md Encapsulate/Decapsulate)
    UNIQUE (txt_id, user_id)
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
- **`umk_store`** — one row per user, holding that user's master key (`umk`), itself encrypted at rest.
- **`key_store`** — one row per user, holding that user's composite ML-KEM-1024 + X448 keypair (see crypto.md's Composite KEM Key Sizes). `pub_key` is stored raw (1624 bytes) since it isn't sensitive; `priv_key` is wrapped under the owner's `umk`, same pattern as `txt.txt_key`. This keypair exists so other users can share a document with this user without knowing their `umk` — see `txt_shares`.
- **`txt`** — one row per document (a "txt"). `txt_key` is the document's own key material, wrapped under the owner's `umk`.
- **`txt_parts`** — a document's content, chunked into ordered parts (`part_num`) so large documents aren't loaded/decrypted as a single blob. `idx_txt_parts_txt_id_part_num` supports fetching a specific part or range in order.
- **`txt_shares`** — one row per (document, recipient) share grant. Carries the same `txt_key` bytes as the owning `txt` row, but wrapped asymmetrically under the recipient's `key_store.pub_key` (crypto.md's Encapsulate/Decapsulate) instead of the owner's `umk`, so the recipient can decrypt `txt_parts`/`bookmarks` for that document using their own `key_store.priv_key` without ever learning the owner's `umk` or `txt_key`-wrapping secret. `kem_ct` and `eph_x448_pub` are the two public values the recipient needs to Decapsulate before they can unwrap `txt_key` — neither is sensitive on its own (an attacker with only these can't recover `txt_key` without the recipient's `priv_key`).
- **`part_count`** — a denormalized count of `txt_parts` rows per `txt_id`, so pagination UI (e.g. "part 3 of 47") doesn't require a `COUNT(*)` scan. Nothing in the schema keeps it in sync automatically (no trigger, unlike `bookmarks`) — callers that insert/delete `txt_parts` rows are responsible for updating `part_count` to match.
- **`txt_access`** — per-(user, txt) read position, keyed by the pair so each user (owner or share recipient) tracks their own progress through a document independently. `last_part_num`/`last_accessed` are plaintext — reading progress and activity timestamps are not treated as confidential.
- **`bookmarks`** — per-(user, txt) bookmark list, for owners and share recipients alike. The FIFO trigger caps each user at 12 bookmarks per document by evicting the oldest (lowest `id`) on overflow, so storage stays bounded without an application-side cleanup step.
- **`txt_metadata`** — one row per user: `txt_metadata_key` (wrapped under the owner's `umk`, same pattern as `txt.txt_key`) protects `content`, a single encrypted JSON blob per user (e.g. a filename/document index), rather than one row per document.

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
    ├──▶ txt_metadata_key   (txt_metadata.txt_metadata_key — per user)
    │        │  used directly as IKM —
    │        └──▶ txt_metadata.content
    │
    └──▶ key_store.{pub_key, priv_key}   (composite ML-KEM-1024 + X448 keypair — per user;
             priv_key wrapped under umk as above, pub_key stored raw/public)
             │
             │  a document owner Encapsulates (crypto.md) against another
             │  user's pub_key to grant that user access:
             ▼
        txt_shares.{kem_ct, eph_x448_pub, txt_key}   (per (document, recipient) —
             txt_key is the same bytes as txt.txt_key, wrapped for the recipient
             instead of the owner; kem_ct/eph_x448_pub are the public values the
             recipient needs to Decapsulate)
             │
             │  the recipient Decapsulates using their own priv_key (paired with
             │  the pub_key the owner encapsulated against) to recover txt_key,
             │  then reads txt_parts.content/bookmarks.bookmark same as the owner
             ▼
        (recipient now holds the document's txt_key, unwrapped)
```

- `user_root_key` is a per-user secret (at least 256 random bytes, base64-encoded) held in config, not in Turso — each user has their own, not a value shared across the corpus. It is the IKM used to wrap and unwrap that user's `umk`.
- `umk` is 64 random bytes generated once when a user's `umk_store` row is created. Unwrapped, it is used directly as HKDF IKM (no intermediate per-purpose derivation) to wrap and unwrap `txt.txt_key`, `txt_metadata.txt_metadata_key`, and `key_store.priv_key`.
- `txt_key` and `txt_metadata_key` are themselves used directly as IKM to encrypt/decrypt the content columns they protect. `txt_key` — the document's own (unwrapped) key — is the IKM for both `txt_parts.content` and `bookmarks.bookmark`, since bookmarks are scoped per-`txt_id`. `txt_metadata_key` is the IKM for `txt_metadata.content`.
- `key_store` holds each user's composite ML-KEM-1024 + X448 keypair (see crypto.md's Composite KEM Key Sizes). Unlike every other secret in this hierarchy, `priv_key` is never used as IKM directly — it's only used to Decapsulate (crypto.md) a KEM ciphertext down to a shared secret, which then becomes the IKM for a standard Decrypt.
- `txt_shares` lets a document owner grant another user access without either party learning the other's `umk`: the owner Encapsulates (crypto.md) the document's `txt_key` against the recipient's `key_store.pub_key`, storing the resulting `kem_ct`/`eph_x448_pub`/wrapped `txt_key` in the share row; the recipient later Decapsulates using `kem_ct` and `eph_x448_pub` together with their own `key_store.priv_key`.
- Every wrapped-key and content blob uses the blob format, AEAD, and KDF mechanics from [crypto.md](crypto.md) uniformly — the same Encrypt/Decrypt procedure, just with a different IKM and payload at each layer. `key_store.priv_key`/`txt_shares.txt_key` add one more step in front (Encapsulate/Decapsulate) to derive that IKM asymmetrically instead of it being already held by both sides.
- `username_lookup_key` (referenced in the `username_hash` comment, not a table column) is also a per-user config secret: 32 random bytes, base64-encoded. Login computes `username_hash = HMAC-SHA3-256(username_lookup_key, username)` and looks the row up by that unique value.
- Login flow: look up the user's row (via `username_hash`, using that user's `username_lookup_key`), then verify the supplied password by recomputing `PBKDF2-HMAC-SHA3-256(password, pw_salt)` and comparing to the stored `pw_hash` for that row's `user_id`. `pw_hash`/`pw_salt` exist purely for this verification step — they authenticate the user and resolve the correct `user_id`, and are never used as IKM anywhere in the key hierarchy above. A server that leaks only the `users` table cannot unwrap any `umk`.

## Design Notes / Open Questions

- **Per-user root key blast radius.** Since `user_root_key` (and `username_lookup_key`) are per-user rather than shared, compromising one user's config secret only exposes that user's `umk`/`txt_key`/`txt_metadata_key` chain, not the whole corpus.
- **Where per-user config lives.** The per-user `user_root_key`/`username_lookup_key` pairs are held in a JSON config file, keyed per user.
- **Composite KEM combiner binding.** The combiner is `HKDF-Extract(none, ss_kem || ss_x448)` → a 64-byte `PRK` (see crypto.md's Encapsulate/Decapsulate) — a standard robust combiner: the combined key stays secure as long as at least one of ML-KEM-1024 or X448 remains unbroken. It does not yet bind `kem_ct` or either party's public key into the derivation (only the two raw shared secrets). Hybrid-KEM designs like X-Wing additionally fold `kem_ct`, `eph_x448_pub`, and the recipient's static X448 `pub_key` into the derivation (as HKDF `info`) for domain separation and cross-protocol safety — worth adopting the same here rather than combining the two secrets alone.
- **`txt_key`/`txt_metadata_key` raw byte length is unspecified.** `umk` (64 bytes) and the composite KEM keys (crypto.md) both have documented raw sizes, but `txt.txt_key` and `txt_metadata.txt_metadata_key` never state how many random bytes they are before wrapping — worth pinning down for consistency (64 bytes, matching `umk`, would be the natural choice given every other symmetric key/salt/tag in this system is 64 bytes).
