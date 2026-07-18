# Crypto

All cryptographic operations use **leancrypto**, loaded as a system shared library via ctypes (native) / compiled to WebAssembly (browser). No other crypto dependency is required. None of this changed in the InstantDB/R2/Firebase redesign — what changed is *what sits at the top of the key hierarchy* and *where each secret lives*, not the primitives, the blob format, or the encrypt/decrypt code path.

## Key Hierarchy

```
user_root_key (per user; see Provisioning below)
  └── HKDF+AEAD → umkStore.umkBlob (64 raw random bytes, one per user; enforced 1-to-1, see data_model.md's Uniqueness note)
        ├── HKDF+AEAD → txt.txtKeyBlob (64 raw random bytes, one per entry)
        │       ├── HKDF+AEAD → the entry's $files content (current content + version history; see Entry Data File below)
        │       └── HKDF+AEAD → a bookmark's $files content (one per bookmark on that entry; see Bookmark Encryption below)
        └── HKDF+AEAD → metadataStore.metadataKeyBlob (64 raw random bytes, one per user)
                └── HKDF+AEAD → the metadata index's $files content (see Filename Index below)
```

Each arrow wraps a freshly generated random secret under a key derived from whatever's above it — this shape is unchanged from before. What's different:

- **`user_root_key`** replaces the old global `root_master_key`. It's a 256-byte random secret, generated **per user** by the admin CLI at account-creation time, and delivered to that user exactly once, out-of-band, as part of their provisioning bundle (see Provisioning below). It is never stored server-side in InstantDB — only `umkStore.umkBlob` (the thing it wraps) lives there. This is a strictly better isolation property than the old global `root_master_key`: compromising one user's `user_root_key` exposes only that user's `umk` and everything under it, not every user's. The admin CLI's local config holds a **keyring** of every user's `user_root_key` (see Credentials/Config below), since admin-mediated ingest still needs to unwrap a specific user's `umk` to wrap a fresh `txt.txtKeyBlob` under it.
- **`umkStore.umkBlob`** ("user master key") — unchanged in shape from the old `umk_store.umk`: 64 raw random bytes generated once per user, wrapped under a key derived from that user's own `user_root_key` instead of a shared `root_master_key`.
- **`txt.txtKeyBlob`** — for each entry, 64 raw random bytes generated at ingest time and stored encrypted, wrapped under a key derived from the owning user's decrypted `umk`. This is the entry's one and only content key, same role as the old `txt.txt_key` column — it never changes. There is no `txt_shares`-equivalent in this redesign: this key is never re-wrapped under any other user's `umk`, because sharing was dropped (see [architecture.md](architecture.md), [security.md](security.md)).
- **`metadataStore.metadataKeyBlob`** — for each user, 64 raw random bytes generated once, wrapped under that user's `umk`. Renamed from `txt_metadata.txt_metadata_key`; same role. `umk` still never encrypts bulk data directly — it only ever wraps other keys (`txtKeyBlob`, `metadataKeyBlob`); actual content is always encrypted under one of those, and now always lives in a linked `$files` row rather than a DB column (see Entry Data File, Filename Index, and Bookmark Encryption below) — only the small wrapped-key blobs themselves stay inline.

Possessing one user's `umk` only ever unwraps that user's own `txtKeyBlob`s, their own bookmarks, and their own `metadataKeyBlob` — never another user's `umk` or any of another user's data. Only that specific user's `user_root_key` can unwrap their `umk` — and, unlike the old scheme, there is no longer any single secret that unwraps *every* user's `umk` at once. The admin CLI's keyring is functionally equivalent to holding all of them, but that is a property of the CLI's config file, not of the crypto scheme itself.

## Credentials / Config (admin CLI)

The admin CLI's local config file holds:

```json
{
  "instant_app_id":         "<InstantDB app ID>",
  "instant_admin_token":    "<InstantDB admin token -- bypasses instant.perms.ts entirely>",
  "firebase_service_account": { "...": "..." },
  "user_root_keys": {
    "<user email>": "<base64, 256 random bytes>"
  }
}
```

This file is the new single point of total compromise, same trust tier `root_master_key`/`creds.json` occupied before: anyone holding it can mint an InstantDB admin session (full read/write over every row, bypassing every permission rule) and unwrap every user's `umk` via `user_root_keys`. It never leaves the machine the admin CLI runs on, and — unlike the old `creds.json` — it is never loaded into a browser session. See [security.md](security.md).

## User Identity, Login, and Provisioning

There is no `username_hash`/`pw_hash` scheme in this redesign — Firebase Auth replaces it for login, and (as in the old design) login credentials never fed the crypto hierarchy directly; they only gate *who gets handed which `user_root_key`*.

**Create user** (admin CLI):

```
1. Create a Firebase account for the user (via firebase-admin, using the
   service account in the CLI's config).
2. umk = random(64 bytes); user_root_key = random(256 bytes)
3. umkBlob = encrypt(umk, ikm=user_root_key)                      # fresh salt
   CREATE umkStore { umkBlob }, linked to a new $users row
   { email, type: "user" } via umkStoreOwner, using the InstantDB
   admin SDK (bypasses instant.perms.ts).
4. metadataKey = random(64 bytes)
   metadataKeyBlob = encrypt(metadataKey, ikm=umk)
   emptyContent = encrypt(brotli('{}'), ikm=metadataKey)
   db.storage.uploadFile(emptyContent) -> new $files row
   CREATE metadataStore { metadataKeyBlob }, linked to that $files row via
   metadataFileEntry and to umkStore via umkStoreMetadata
5. instant_token = admin_auth.createToken(email)   # InstantDB admin API
6. Store user_root_key in the CLI config's user_root_keys keyring.
7. Bundle { instant_token, user_root_key } and deliver it to the user
   exactly once, out-of-band (this bundle is never stored in InstantDB).
```

**User bootstrap** (web UI, once per browser/device):

```
1. User signs into Firebase (proves identity to the app).
2. User imports the admin-delivered { instant_token, user_root_key } bundle
   once (e.g. pastes/uploads it).
3. UI calls db.auth.signInWithToken(instant_token) to establish an
   InstantDB session, and persists both instant_token and user_root_key in
   browser local storage.
4. On every later visit: Firebase login is checked again (an app-level
   "are you still you" gate), but the persisted instant_token/user_root_key
   are what actually authorize InstantDB access from then on -- reusing them
   does not re-derive anything from the Firebase session. See security.md
   for why this is called out explicitly as a trade-off rather than glossed
   over.
```

**Revoke/delete user** (admin CLI):

```
DELETE $users row for that user, via the admin SDK.
```

`onDelete: 'cascade'` on `umkStoreOwner` → `txtUmkStore`/`umkStoreMetadata` → `txtFileEntry`/`txtBookmarks`/`metadataFileEntry`/`bookmarkFileEntry` wipes that user's `umkStore` row, every `txt` row it owns, their `metadataStore` row, every bookmark on every one of their entries, and every linked `$files` row (entry content, the metadata index, bookmark payloads), in one operation. Whether InstantDB's admin SDK additionally offers a way to invalidate an already-issued `instant_token` short of deleting the user outright is not something this doc asserts one way or the other — treat it as TBD until confirmed against the actual SDK, the same way `crypto.md` has historically flagged an exact leancrypto symbol as TBD (see Primitives below) rather than guess.

This replaces the old CLI-mediated Sharing flow entirely — see [architecture.md](architecture.md) and [security.md](security.md) for why sharing itself was dropped, not just re-plumbed.

## Primitives

| Primitive | leancrypto API | Parameters |
|-----------|---------------|------------|
| AEAD | Ascon-Keccak (`lc_ak_alloc_taglen`) | 64-byte key, 64-byte IV, 64-byte tag |
| KDF | HKDF-SHA3-512 (`lc_hkdf_*`) | produces 128 or 160 bytes of OKM |
| MAC | HMAC-SHA3-256 (`lc_hmac_*`) | 32-byte digest (currently unused now that `username_hash` is gone; kept in case a future blind-index need reappears) |

Unchanged from before, minus the password KDF row (PBKDF2-HMAC-SHA3-256) — password verification is now Firebase's responsibility entirely, not this app's.

## Blob Format

Every encrypted blob — the small wrapped-key columns (`umkStore.umkBlob`, `txt.txtKeyBlob`, `metadataStore.metadataKeyBlob`) and the bulk content stored as `$files` bytes (an entry's content + history, the metadata index's content, a bookmark's content) — shares one wire format, unchanged from before:

```
magic (2) || version (2) || salt (64) || ciphertext (var) || tag (64)
```

| Field | Size | Value |
|-------|------|-------|
| magic | 2 bytes | `0x54 0x58` ("TX") |
| version | 2 bytes | major · minor (e.g. `0x01 0x00` = v1.0) |
| salt | 64 bytes | random per blob, HKDF input salt |
| ciphertext | variable | AEAD-encrypted (and, for structured payloads, brotli-compressed) payload bytes |
| tag | 64 bytes | Ascon-Keccak authentication tag covering AD + ciphertext |

Minimum valid blob length: `2 + 2 + 64 + 0 + 64 = 132` bytes.

### Version numbering

| Version bytes | Meaning |
|----------------|---------|
| `0x01 0x00` | v1.0, current format |

Bump minor for additive, backward-compatible changes; bump major for breaking changes. Unchanged from before — see the Blob Format section's original rationale, which still applies verbatim since InstantDB stores these blobs as opaque strings/file bytes, the same way SQLite stored them as opaque `BLOB`s.

### Additional Data (AD)

```
AD = magic (2) || version (2) || salt (64)   -> 68 bytes total
```

Unchanged.

### Upgrade handling

Unchanged: a blob is re-encrypted to the current version lazily, on next write. An explicit "re-encrypt all" pass can upgrade eagerly if needed.

## Key Derivation

```
salt         = os.urandom(64)
key_material = HKDF-SHA3-512(ikm=parent_secret, salt=salt, info=b"", length=128)

key = key_material[:64]    # Ascon-Keccak key
iv  = key_material[64:]    # Ascon-Keccak IV
```

Where `parent_secret` is:

| Blob | `parent_secret` |
|------|------------------|
| `umkStore.umkBlob` | that user's `user_root_key` |
| `txt.txtKeyBlob` | the owning user's decrypted `umk` |
| `metadataStore.metadataKeyBlob` | that user's decrypted `umk` |
| the entry data file's content (`$files`, via `txtFileEntry`) | that entry's decrypted `txtKeyBlob` |
| a bookmark's content (`$files`, via `bookmarkFileEntry`) | that entry's decrypted `txtKeyBlob` |
| the metadata index's content (`$files`, via `metadataFileEntry`) | that user's decrypted `metadataKey` |

## Encrypt / Decrypt

Both unchanged from before — same Ascon-Keccak AEAD scheme, same AD, same brotli-before-encrypt rule for structured/textual payloads (raw key material is never compressed):

```
plaintext  = raw bytes of the payload
             (umk, txtKeyBlob, metadataKey: raw, no compression;
              entry data file content, the metadata index's content, a bookmark's content: brotli-compressed)
salt       = os.urandom(64)
version    = 0x01 0x00
ad         = MAGIC || version || salt
key, iv    = derive(parent_secret, salt)
ct_tag     = Ascon-Keccak-encrypt(plaintext, key, iv, aad=ad)
blob       = MAGIC || version || salt || ct_tag
```

```
magic, version, salt, ct_tag = blob[:2], blob[2:4], blob[4:68], blob[68:]
if magic != MAGIC: reject immediately
ad = magic || version || salt
key, iv    = derive(parent_secret, salt)
plaintext  = Ascon-Keccak-decrypt(ct_tag, key, iv, aad=ad)
if blob type is a structured payload: plaintext = brotli.decompress(plaintext)
```

## Entry Data File

Referenced from `txtFileEntry` in [data_model.md](data_model.md). An entry's content — and, new in this redesign, its full edit history — lives in exactly one file, uploaded via InstantDB Storage (`db.storage.uploadFile`, backed by Cloudflare R2) and linked to its `txt` row through `txtFileEntry`. This replaces the old `txt_parts`/`part_count` tables entirely: the old paragraph-chunking into ~200 KB rows existed only to work around SQLite BLOB row-size practicality, and object storage doesn't need that workaround, so a single blob per entry is both simpler and sufficient.

The blob's plaintext (after decrypt + brotli-decompress) is a JSON document:

```json
{ "name": "<filename>", "current": "<current text>", "history": [ { "at": <unix ms>, "content": "<prior text>" }, ... ] }
```

Ingest/edit appends the prior `current` value onto `history` before writing the new `current` — a capability the old design never had (`--force` re-ingest simply overwrote content with no retention). Swapping a new version in is a two-step, atomically-linked operation:

```
1. db.storage.uploadFile(newContent) -> new $files row (unlinked so far)
2. db.transact([
     link the new $files row to this txt row via txtFileEntry,
     unlink (and delete) the old $files row
   ])
```

Because step 2 is one atomic transaction, there is never an externally observable moment where an entry has zero or two linked files — only the brief moment between step 1 and step 2 where the *new* file exists but isn't linked to anything yet. That's exactly why `txtFileEntry` is safe as `has: 'one'`/`has: 'one'` without `required: true` — see [data_model.md](data_model.md)'s note on this link.

## Filename Index

Renamed from the old `txt_metadata`. Each user has one `metadataStore` row, holding only the wrapped `metadataKeyBlob` — the actual index (a JSON object `{"<entryId>": "<name>", ...}` covering every entry they own) lives in a linked `$files` row via `metadataFileEntry`, encrypted under that user's own `metadataKey` (itself wrapped under their `umk`), not an inline column. The admin CLI decrypts a user's index file to check for an existing filename by direct dictionary lookup at ingest time, and rewrites it once per ingest run (not once per file) — same rationale as before, just swapped in via the same atomic upload-then-relink `db.transact` described in Entry Data File above rather than an `UPDATE`. There is no shared-to-them case anymore, since sharing was dropped.

## Provisioning

Replaces the old Sharing section — there is no grant/revoke of read access between users in this redesign (see [architecture.md](architecture.md), [security.md](security.md) for why). What used to be "grant"/"revoke" is now "create user"/"delete user" — see User Identity, Login, and Provisioning above for both flows in full. The one property carried over unchanged: provisioning (like the old sharing) is admin-CLI-mediated and requires the admin's config (the new keyring), not something a logged-in browser session can do to itself or anyone else.

## Bookmark Encryption

```
plaintext = JSON.stringify({part_num, line, txt_preview})
```

The `bookmarks` entity itself has no fields at all — this plaintext is encrypted, uploaded via `db.storage.uploadFile`, and linked to its `bookmarks` row through `bookmarkFileEntry`, the same one-file-per-row shape as Entry Data File above (see [data_model.md](data_model.md)'s note on why `has: 'one'`/`has: 'one'` without `required: true` is safe there). Encrypted with a fresh random salt per bookmark, keyed off that entry's `txtKeyBlob` — unchanged in mechanism from before, minus the owner-vs-grantee distinction (there's only ever an owner now). A bookmark's content file is never swapped/rewritten the way an entry's or the metadata index's is — it's created once (upload, then atomically link) and later deleted outright, never updated in place. The 12-per-entry cap is enforced client-side rather than by a DB trigger — see [data_model.md](data_model.md)'s `bookmarks` section and [security.md](security.md).

## Security Properties

| Property | Mechanism |
|----------|-----------|
| Confidentiality | Ascon-Keccak (512-bit key+IV, 512-bit tag) |
| Integrity / authenticity | 64-byte Ascon-Keccak tag |
| Header integrity | Magic + version + salt passed as AD; tag covers all of it, not just salt |
| Fast malformed-input rejection | Magic bytes checked before any crypto work |
| Format evolution without downtime | Every blob carries its own version; upgraded lazily on next write |
| Per-user key isolation | Each user's own `umk` is wrapped under that user's own `user_root_key`, not a shared secret — compromising one user's `user_root_key` doesn't expose any other user's `umk` |
| Per-row DB access control (new) | `instant.perms.ts`'s `isOwner` rules block a user's session from ever querying another user's rows at the database layer, independent of whether they could decrypt them — see [security.md](security.md) |
| No sharing, no shared-secret blast radius | Every entry has exactly one owner; there is nothing analogous to the old `txt_shares` re-wrap, so there's nothing to revoke without forward secrecy either |
| Key isolation per blob | HKDF with a unique random salt per blob, at every tier |
| Compression oracle mitigation | Compress before encrypt; no adaptive queries |

See [security.md](security.md) for what this scheme does and does not protect against.
