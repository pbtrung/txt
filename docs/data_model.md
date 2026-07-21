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
    pub_key  BLOB    NOT NULL,       -- lc_kyber_1024_x448 composite keypair (lc_kyber_keypair, type lc_kyber_1024_x448), raw public key, 1624 bytes
    priv_key BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(priv_key bytes)||tag, wrapped under owner's umk
);

CREATE TABLE IF NOT EXISTS r2_config (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    config   BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(brotli(JSON))||tag, wrapped under owner's umk
);

CREATE TABLE IF NOT EXISTS txt (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    txt_key BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(txt_key bytes)||tag, wrapped under owner's umk; txt_key itself is 64 random bytes
);

CREATE TABLE IF NOT EXISTS txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    path     BLOB    NOT NULL        -- magic||version||salt||Ascon-Keccak(path)||tag, wrapped under this txt's txt_key; path = Crockford base32 (see txt/base32.py) of constants.RAW_PATH_LEN random bytes
);

CREATE TABLE IF NOT EXISTS txt_shares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id        INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    to_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    salt_kem_ct   BLOB    NOT NULL,   -- salt (64 random bytes) || lc_kyber_1024_x448 KEM ciphertext (1624 bytes), raw (public value)
    txt_key       BLOB    NOT NULL,   -- same txt_key bytes as txt.txt_key, wrapped for this recipient via HKDF-SHA3-512(IKM=ss, salt) -> 128-byte OKM (see crypto.md Encapsulate/Decapsulate); ss is the raw (uncombined) shared secret from lc_kyber_1024_x448_enc/_dec, never stored
    UNIQUE (txt_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id_part_num ON txt_parts(txt_id, part_num);

CREATE TABLE IF NOT EXISTS part_count (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS txt_access (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    txt_access_key BLOB    NOT NULL,   -- magic||version||salt||Ascon-Keccak(txt_access_key bytes)||tag, wrapped under owner's umk; txt_access_key itself is 64 random bytes
    access         BLOB    NOT NULL    -- magic||version||salt||Ascon-Keccak(brotli(JSON))||tag, wrapped under txt_access_key; JSON = {"<txt_id>": {"last_part_num": int, "last_accessed": int (unix ms)}, ...}, capped at 7 txt_ids (client evicts the entry with the oldest last_accessed before exceeding the cap — no DB-level enforcement)
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    bookmark_key BLOB    NOT NULL,   -- magic||version||salt||Ascon-Keccak(bookmark_key bytes)||tag, wrapped under owner's umk; bookmark_key itself is 64 random bytes
    bookmark     BLOB    NOT NULL    -- magic||version||salt||Ascon-Keccak(brotli(JSON))||tag, wrapped under bookmark_key; JSON = {"<txt_id>": [{"part_num": int, "line": int, "txt_preview": str, "created_at": int (unix ms)}, ...], ...}, each txt_id's list capped at constants.BOOKMARK_LIMIT (20) entries, oldest-first (client evicts index 0 before exceeding the cap — no DB-level enforcement)
);

CREATE TABLE IF NOT EXISTS txt_metadata (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    txt_metadata_key BLOB    NOT NULL,   -- magic||version||salt||Ascon-Keccak(txt_metadata_key bytes)||tag, wrapped under owner's umk; txt_metadata_key itself is 64 random bytes
    content          BLOB                -- magic||version||salt||Ascon-Keccak(brotli(JSON))||tag
);
```

### Tables

- **`users`** — one row per account. `username_hash` is a keyed HMAC (not a general-purpose hash) so the username lookup key can be rotated independently of the password KDF; it's what the login query looks up by, never the plaintext username. `pw_salt`/`pw_hash` are login-verification material only — they authenticate the user to the server and are not part of the encryption key chain (see Key Hierarchy).
- **`umk_store`** — one row per user, holding that user's master key (`umk`), itself encrypted at rest.
- **`r2_config`** — one row per user: `config` (wrapped under the owner's `umk`, same pattern as `key_store.priv_key`) is a single encrypted JSON blob holding that user's R2 bucket/credentials configuration needed to read/write `txt_parts.path` objects. Which R2 keys a given user's config may hold (read-only only, vs. read-write too) depends on their role — see [credentials.md](credentials.md).
- **`key_store`** — one row per user, holding that user's `lc_kyber_1024_x448` composite keypair (`lc_kyber_keypair`, type `lc_kyber_1024_x448`; see crypto.md's Composite KEM Key Sizes). `pub_key` is stored raw (1624 bytes) since it isn't sensitive; `priv_key` is wrapped under the owner's `umk`, same pattern as `txt.txt_key`. This keypair exists so other users can share a document with this user without knowing their `umk` — see `txt_shares`.
- **`txt`** — one row per document (a "txt"). `txt_key` is the document's own key material, wrapped under the owner's `umk`.
- **`txt_parts`** — a document's content, chunked into ordered parts (`part_num`, target ~200 KB per part — see `constants.PART_TARGET`) so large documents aren't loaded/decrypted as a single blob. The actual content lives in R2 object storage, not Turso: the R2 object body is `Blob.encrypt(txt_key, brotli(cleaned part text))`, and its key is `raw_path = crockford_base32(os.urandom(constants.RAW_PATH_LEN))` (`txt/base32.py` — the human-readable variant that excludes visually ambiguous I/L/O/U, no padding) — a fresh random key per part, unrelated to its content. `path` stores that `raw_path`, itself wrapped under the owning `txt`'s `txt_key` (`Blob.encrypt(txt_key, raw_path)`) — so the object key is never visible to Turso either, only to whoever unwraps `path`. `idx_txt_parts_txt_id_part_num` supports fetching a specific part or range in order. See `txt/ingest.py` (`--txt-ingest`) for how raw `.txt` files are cleaned (`txt/textproc.py`), split, and uploaded.
- **`txt_shares`** — one row per (document, recipient) share grant. Carries the same `txt_key` bytes as the owning `txt` row, but wrapped asymmetrically under the recipient's `key_store.pub_key` (crypto.md's Encapsulate/Decapsulate) instead of the owner's `umk`, so the recipient can decrypt `txt_parts` for that document using their own `key_store.priv_key` without ever learning the owner's `umk` or `txt_key`-wrapping secret. (The recipient's own read position and bookmarks for this document live under their own `umk` chain — `txt_access`/`bookmarks` — independent of this share; see below.) `salt_kem_ct` is `salt || lc_kyber_1024_x448_ct`, the public value the recipient needs to Decapsulate before they can unwrap `txt_key` — it isn't sensitive on its own (an attacker with only `salt_kem_ct` can't recover `txt_key` without the recipient's `priv_key`, since the wrapping OKM is derived from the shared secret `ss`, not from `salt_kem_ct`).
- **`part_count`** — a denormalized count of `txt_parts` rows per `txt_id`, so pagination UI (e.g. "part 3 of 47") doesn't require a `COUNT(*)` scan. Nothing in the schema keeps it in sync automatically — callers that insert/delete `txt_parts` rows are responsible for updating `part_count` to match.
- **`txt_access`** — one row per user (`user_id` is `UNIQUE`, same pattern as `txt_metadata`), holding that user's read position across every document they've opened — owner or share recipient alike. `txt_access_key` (wrapped under the owner's `umk`, same pattern as `txt.txt_key`) protects `access`, a single encrypted JSON blob keyed by `txt_id`: `{"<txt_id>": {"last_part_num": int, "last_accessed": int}, ...}`. Capped at 7 `txt_id` entries; there's no DB-level enforcement — the client evicts the entry with the oldest `last_accessed` before a write would exceed the cap.
- **`bookmarks`** — one row per user (`user_id` is `UNIQUE`), holding that user's bookmarks across every document they've opened — owner or share recipient alike. `bookmark_key` (wrapped under the owner's `umk`, same pattern as `txt.txt_key`) protects `bookmark`, a single encrypted JSON blob keyed by `txt_id`: `{"<txt_id>": [{"part_num": int, "line": int, "txt_preview": str, "created_at": int (unix ms)}, ...], ...}` (`line` is 1-based, indexing into that part's text as split into lines the same way the reader renders them; `txt_preview` is that line's text truncated to 60 characters; `created_at` is when the bookmark was added). Each `txt_id`'s list is capped at `constants.BOOKMARK_LIMIT` (20) entries — the client evicts the entry with the oldest `created_at` before adding one that would exceed the cap, and sorts by `created_at` (most recent first) for display, the same pattern as `txt_access`'s `last_accessed`-based eviction. There's no DB-level enforcement (no trigger or index over `txt_id`, since there's no longer a `txt_id` column to index or trigger on).
- **`txt_metadata`** — one row per user (`user_id` is `UNIQUE`), created by `--init` (`AdminInitializer._ensure_txt_metadata`) alongside `umk_store`/`key_store`/`r2_config` — provisioning it is `--init`'s job, not `--txt-ingest`'s. `content` starts `NULL`: there's nothing to encrypt until this user has at least one `txt`. `txt_metadata_key` (wrapped under the owner's `umk`, same pattern as `txt.txt_key`) protects `content` once it exists — a single encrypted JSON blob per user rather than one row per document, `{"<txt_id>": {"name": "original filename", "metadata": {...}}, ...}` (`metadata` only present when a `<name>.opf` sidecar was found, see below) — created/updated by `--txt-ingest` (`TxtIngester._update_txt_metadata_entry`) as each file is ingested. Once decrypted and parsed, looking up an entry by `txt_id` is an O(1) average-case dict access, but *persisting* any single change still costs O(size of the whole blob): there's no partial-update path, so every write decrypts (or, the first time, starts from `{}` since `content` was `NULL`), mutates, and re-encrypts the entire JSON document. `--txt-delete` (`txt/delete.py`'s `TxtDeleter`) resets `content` to `NULL` once every txt is gone.

## Key Hierarchy

```
user_root_key (per-user config secret, ≥256 random bytes, base64; not stored in Turso)
    │  IKM for HKDF, wraps/unwraps —
    ▼
umk  (umk_store.umk — 64 random bytes, generated once per user)
    │  used directly as IKM for HKDF, wraps/unwraps —
    ├──▶ txt_key            (txt.txt_key — 64 random bytes, per document)
    │        │  used directly as IKM —
    │        └──▶ txt_parts.path   (per document's part paths)
    │
    ├──▶ txt_metadata_key   (txt_metadata.txt_metadata_key — 64 random bytes, per user)
    │        │  used directly as IKM —
    │        └──▶ txt_metadata.content
    │
    ├──▶ txt_access_key     (txt_access.txt_access_key — 64 random bytes, per user)
    │        │  used directly as IKM —
    │        └──▶ txt_access.access   (read position, keyed by txt_id, for every document this user has opened)
    │
    ├──▶ bookmark_key       (bookmarks.bookmark_key — 64 random bytes, per user)
    │        │  used directly as IKM —
    │        └──▶ bookmarks.bookmark   (bookmarks, keyed by txt_id, for every document this user has opened)
    │
    ├──▶ r2_config.config   (used directly as IKM, no intermediate key — same pattern as key_store.priv_key)
    │
    └──▶ key_store.{pub_key, priv_key}   (lc_kyber_1024_x448 composite keypair — per user;
             priv_key wrapped under umk as above, pub_key stored raw/public)
             │
             │  a document owner Encapsulates (crypto.md) against another
             │  user's pub_key to grant that user access:
             ▼
        txt_shares.{salt_kem_ct, txt_key}   (per (document, recipient) —
             txt_key is the same bytes as txt.txt_key, wrapped for the recipient
             instead of the owner via HKDF(IKM=ss, salt) -> 128-byte OKM;
             salt_kem_ct = salt || lc_kyber_1024_x448_ct is the public value the
             recipient needs to Decapsulate down to ss)
             │
             │  the recipient Decapsulates using their own priv_key (paired with
             │  the pub_key the owner encapsulated against) to recover ss, then
             │  unwraps txt_key, then reads txt_parts.path the same as the owner
             │  (the recipient's own read position/bookmarks for this document
             │  live under their own umk chain — txt_access_key/bookmark_key —
             │  independent of this share)
             ▼
        (recipient now holds the document's txt_key, unwrapped)
```

- `user_root_key` is a per-user secret (at least 256 random bytes, base64-encoded) held in config, not in Turso — each user has their own, not a value shared across the corpus. It is the IKM used to wrap and unwrap that user's `umk`.
- `umk` is 64 random bytes generated once when a user's `umk_store` row is created. Unwrapped, it is used directly as HKDF IKM (no intermediate per-purpose derivation) to wrap and unwrap `txt.txt_key`, `txt_metadata.txt_metadata_key`, `txt_access.txt_access_key`, `bookmarks.bookmark_key`, `key_store.priv_key`, and `r2_config.config`.
- `txt_key`, `txt_metadata_key`, `txt_access_key`, and `bookmark_key` are each 64 random bytes, same size as `umk`. Unwrapped, they're themselves used directly as IKM to encrypt/decrypt the content column they protect: `txt_key` — the document's own (unwrapped) key — is the IKM for `txt_parts.path` only; `txt_metadata_key`, `txt_access_key`, and `bookmark_key` are each per-user (not per-document) and are the IKM for `txt_metadata.content`, `txt_access.access`, and `bookmarks.bookmark` respectively. `txt_access.access`/`bookmarks.bookmark` moved off `txt_key` deliberately: each is now a single JSON blob keyed by `txt_id` spanning every document (owned or shared) a user has opened, so there's no single document's `txt_key` left to wrap it under — a per-user key wrapped under that same user's `umk` (same pattern as `txt_metadata_key`) is required instead.
- `key_store` holds each user's `lc_kyber_1024_x448` composite keypair, generated via `lc_kyber_keypair` (see crypto.md's Composite KEM Key Sizes). Unlike every other secret in this hierarchy, `priv_key` is never used as IKM directly — it's only used to Decapsulate (crypto.md) a KEM ciphertext down to a shared secret `ss`, which then becomes the IKM for a standard Decrypt.
- `txt_shares` lets a document owner grant another user access without either party learning the other's `umk`: the owner generates a random 64-byte `salt` and Encapsulates (crypto.md) against the recipient's `key_store.pub_key` via `lc_kyber_1024_x448_enc`, producing a KEM ciphertext `ct` and an 88-byte raw shared secret `ss` (ML-KEM-1024-SS || X448-SS, uncombined — not the `_enc_kdf` variant, which would combine them internally via its own KMAC256 construction). It stores `salt_kem_ct = salt || ct` (public) and wraps `txt_key` using `HKDF-SHA3-512(IKM=ss, salt)` → 128-byte OKM, same AEAD-key/IV split as a standard Encrypt — this HKDF call is what actually combines the two shared secrets. The recipient later parses `salt` and `ct` back out of `salt_kem_ct`, Decapsulates `ct` with their own `priv_key` via `lc_kyber_1024_x448_dec` to recover the same raw `ss` (never stored or transmitted), and reruns the same HKDF derivation to unwrap `txt_key`.
- Every wrapped-key and content blob uses the blob format, AEAD, and KDF mechanics from [crypto.md](crypto.md) uniformly — the same Encrypt/Decrypt procedure, just with a different IKM and payload at each layer. `key_store.priv_key`/`txt_shares.txt_key` add one more step in front (Encapsulate/Decapsulate) to derive that IKM asymmetrically instead of it being already held by both sides.
- `username_lookup_key` (referenced in the `username_hash` comment, not a table column) is also a per-user config secret: 32 random bytes, base64-encoded. Login computes `username_hash = HMAC-SHA3-256(username_lookup_key, username)` and looks the row up by that unique value.
- Login flow: look up the user's row (via `username_hash`, using that user's `username_lookup_key`), then verify the supplied password by recomputing `PBKDF2-HMAC-SHA3-256(password, pw_salt)` and comparing to the stored `pw_hash` for that row's `user_id`. `pw_hash`/`pw_salt` exist purely for this verification step — they authenticate the user and resolve the correct `user_id`, and are never used as IKM anywhere in the key hierarchy above. A server that leaks only the `users` table cannot unwrap any `umk`.

## Design Notes / Open Questions

- **Per-user root key blast radius.** Since `user_root_key` (and `username_lookup_key`) are per-user rather than shared, compromising one user's config secret only exposes that user's `umk`/`txt_key`/`txt_metadata_key`/`txt_access_key`/`bookmark_key` chain, not the whole corpus.
- **Client-enforced caps for `txt_access`/`bookmarks`.** Both tables moved from one row per (`txt_id`, `user_id`) pair to one row per user (a single JSON blob keyed by `txt_id`), so their per-`txt_id` caps (7 `txt_id` entries for `txt_access`, `constants.BOOKMARK_LIMIT` entries per `txt_id` for `bookmarks`) can no longer be enforced by a SQL trigger over rows the way the old per-row `bookmarks` design was — enforcement moves entirely to the client, which must evict before writing past either cap. A buggy or malicious client could write past either cap; they bound blob size for well-behaved clients, not a security boundary Turso enforces.
- **Where per-user config lives.** The per-user `user_root_key`/`username_lookup_key` pairs are held in a JSON config file, keyed per user.
- **Composite KEM combiner binding.** `ss` is the raw, uncombined concatenation `ML-KEM-1024-SS (32 bytes) || X448-SS (56 bytes)` from leancrypto's plain `lc_kyber_1024_x448_enc`/`_dec` (deliberately not `_enc_kdf`/`_dec_kdf`, which run their own separate KMAC256-based combiner). The combining happens in this codebase's own `HKDF-SHA3-512(ss, salt)` — the same KDF used for every other Encrypt/Decrypt in the system, rather than depending on a second KDF construction. This is a standard robust combiner: the derived key stays secure as long as at least one of ML-KEM-1024 or X448 remains unbroken. It does not yet bind `ct` or either party's public key into the derivation, only the two raw shared secrets and `salt`. Hybrid-KEM designs like X-Wing additionally fold `ct`, and the recipient's static X448 `pub_key` into the derivation (as HKDF `info`) for domain separation and cross-protocol safety — worth adopting the same here rather than combining the two secrets alone.
