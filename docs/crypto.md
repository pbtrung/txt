# Crypto

All cryptographic operations use **leancrypto**, loaded as a system shared library via ctypes (native) / compiled to WebAssembly (browser). No other crypto dependency is required.

## Key Hierarchy

```
root_master_key (config)
  └── HKDF+AEAD → umk_store.umk (64 raw random bytes, one per user_id; enforced 1-to-1)
        ├── HKDF+AEAD → txt.txt_key (64 raw random bytes, one per txt_id; owner's copy)
        │       └── HKDF+AEAD → txt_parts.content, bookmarks.bookmark
        ├── HKDF+AEAD → txt_shares.txt_key (same txt_key bytes as above, one wrapped copy
        │                per (txt_id, recipient user_id) grant, under the recipient's own umk)
        └── HKDF+AEAD → txt_metadata.txt_metadata_key (64 raw random bytes, one per user_id)
                └── HKDF+AEAD → txt_metadata.content
```

Each arrow wraps a freshly generated random secret under a key derived from whatever's above it:

- **`root_master_key`** — a 256-byte random secret stored base64-encoded in the JSON credentials file. Root of the whole hierarchy.
- **`umk_store.umk`** ("user master key") — for each user, 64 raw random bytes generated once and stored encrypted, wrapped under a key derived from `root_master_key`. `umk_store.user_id` is `UNIQUE`, enforcing exactly one `umk` per user (see [data_model.md](data_model.md)).
- **`txt.txt_key`** — for each file, 64 raw random bytes generated at ingest and stored encrypted, wrapped under a key derived from the *owning user's* decrypted `umk`. This is the file's one and only content key — it never changes.
- **`txt_shares.txt_key`** — the exact same `txt_key` bytes as the file's `txt.txt_key`, independently wrapped under a *recipient's* `umk`. One row per `(txt_id, user_id)` grant. This is how sharing works (see the Sharing section below): the content key is never re-derived or duplicated in meaning, only re-wrapped so a different `umk` can unwrap the same bytes.
- **`txt_metadata.txt_metadata_key`** — for each user, 64 raw random bytes generated once, wrapped under that user's `umk`. `umk` never encrypts bulk data directly — it only ever wraps other keys (`txt.txt_key`, `txt_shares.txt_key`, `txt_metadata.txt_metadata_key`); actual content is always encrypted under one of those.

Content encryption (`txt_parts`, `bookmarks`) is keyed off the file's `txt_key`, unwrapped via *either* `txt.txt_key` (if you're the owner) or `txt_shares.txt_key` (if you're a grantee) — both unwrap to identical bytes, so content encryption/decryption code doesn't need to know or care which. Possessing one user's `umk` only ever unwraps that user's own `txt.txt_key` rows, their own `txt_shares.txt_key` grants, and their own `txt_metadata_key` — never another user's `umk`, un-shared files, or another user's filenames. Only `root_master_key` can unwrap every `umk`.

## Primitives

| Primitive | leancrypto API | Parameters |
|-----------|---------------|------------|
| AEAD | Ascon-Keccak (`lc_ak_alloc_taglen`) | 64-byte key, 64-byte IV, 64-byte tag |
| KDF | HKDF-SHA3-512 (`lc_hkdf_*`) | produces 128 or 160 bytes of OKM |
| MAC | HMAC-SHA3-256 (`lc_hmac_*`) | 32-byte digest |

## Blob Format

Every encrypted blob — `umk_store.umk`, `txt.txt_key`, `txt_shares.txt_key`, `txt_metadata.txt_metadata_key`, a `txt_parts` part, `txt_metadata.content`, a bookmark — shares one wire format:

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

Each byte encodes one component (major · minor):

| Version bytes | Meaning |
|----------------|---------|
| `0x01 0x00` | v1.0, current format |

Bump minor for additive, backward-compatible changes (e.g. new optional fields in a plaintext JSON payload, a brotli parameter change) — an older decoder can still decode a newer-minor blob by ignoring unknown fields. Bump major for breaking changes (different cipher/KDF, different field sizes/ordering, different magic bytes) — a decoder must refuse a blob whose major version it doesn't recognize rather than attempt to decode it.

The decoder reads `version[0]` (major) and dispatches to the matching decode path before doing any crypto work. Old and new blob versions can coexist in the same database indefinitely; no coordinated rewrite is required at write time (see Upgrade Handling below).

### Additional Data (AD)

The AEAD tag covers the blob header as well as the ciphertext:

```
AD = magic (2) || version (2) || salt (64)   -> 68 bytes total
```

Any single-bit modification to the magic, version, salt, ciphertext, or tag causes authentication failure before any plaintext is returned — this binds the blob's format identity and version to its authenticity, not just its salt.

### Upgrade handling

Existing blobs remain valid at whatever version they were written with. A blob is only re-encrypted to the current version lazily, when something next writes it (e.g. a bookmark update, a re-ingested file). An explicit "re-encrypt all" operation can upgrade the whole vault eagerly if needed: for each row, decrypt with its own version's decoder and re-encrypt with the current version's encoder.

## Key Derivation

Every blob's salt derives a fresh key/IV from whichever secret is its parent in the key hierarchy above:

```
salt         = os.urandom(64)
key_material = HKDF-SHA3-512(ikm=parent_secret, salt=salt, info=b"", length=128)

key = key_material[:64]    # Ascon-Keccak key
iv  = key_material[64:]    # Ascon-Keccak IV
```

Where `parent_secret` is:

| Blob | `parent_secret` |
|------|------------------|
| `umk_store.umk` | `root_master_key` |
| `txt.txt_key` | the owning user's decrypted `umk` |
| `txt_shares.txt_key` | the recipient user's decrypted `umk` (not the owner's) |
| `txt_metadata.txt_metadata_key` | that user's decrypted `umk` |
| `txt_parts.content`, `bookmarks.bookmark` | the file's decrypted `txt_key` (from `txt.txt_key` or `txt_shares.txt_key`, whichever applies to the reader) |
| `txt_metadata.content` | that user's decrypted `txt_metadata_key` |

## Encrypt

```
plaintext  = raw bytes of the payload
             (umk bytes, a txt_key, a txt_metadata_key: raw, no compression;
              a part, a txt_metadata JSON, a bookmark JSON: brotli-compressed)
salt       = os.urandom(64)
version    = 0x01 0x00
ad         = MAGIC || version || salt
key, iv    = derive(parent_secret, salt)
ct_tag     = Ascon-Keccak-encrypt(plaintext, key, iv, aad=ad)
blob       = MAGIC || version || salt || ct_tag
```

`umk_store.umk`, `txt.txt_key`/`txt_shares.txt_key`, and `txt_metadata.txt_metadata_key` are all raw random key material — brotli-compressing random bytes wastes cycles and cannot shrink them, so only the structured/textual payloads (`txt_parts.content`, `txt_metadata.content`, `bookmarks.bookmark`) are brotli-compressed before encryption. The 64-byte Ascon-Keccak authentication tag is appended by leancrypto and included in `ct_tag`. Passing `ad` (not just `salt`) binds the magic bytes and version to the ciphertext: tampering with any of them fails authentication on decrypt.

## Decrypt

```
magic, version, salt, ct_tag = blob[:2], blob[2:4], blob[4:68], blob[68:]
if magic != MAGIC: reject immediately
ad = magic || version || salt
key, iv    = derive(parent_secret, salt)
plaintext  = Ascon-Keccak-decrypt(ct_tag, key, iv, aad=ad)
if blob type is a structured payload: plaintext = brotli.decompress(plaintext)
```

Checking `magic` first allows fast rejection of anything that isn't one of this vault's blobs before any crypto work runs. `version[0]` (major) selects which decode path to use. This same encrypt/decrypt pair is used for every blob in the database, at every tier of the hierarchy — only `parent_secret` and whether brotli applies change.

## `txt_metadata` (filename index)

Each user has one `txt_metadata` row: a JSON object `{"<txt_id>": "<name>", ...}` covering every file they can open — their own plus anything shared to them — encrypted with the scheme above under that user's own `txt_metadata_key` (itself wrapped under their `umk`, not used to encrypt content directly). The CLI decrypts a user's row to check for an existing filename by direct dictionary lookup, scoped to that user's own entries, at ingest time, and adds one entry to the recipient's row at share time. See [data_model.md](data_model.md).

## Sharing

Sharing grants another user read access to a file without ever exposing the owner's `umk`. It's a CLI-mediated operation (`txt.py --share <file> --to <user>`), run with `root_master_key` present — the same trust tier as ingest — not a self-service action a logged-in browser session can do on its own (that would require asymmetric crypto to let the owner target a recipient's key without holding root; not implemented here).

**Grant** (`--share`):

```
owner_umk     = unwrap(umk_store row for the owner, ikm=root_master_key)
txt_key       = unwrap(txt.txt_key for this file, ikm=owner_umk)
recipient_umk = unwrap(umk_store row for the recipient, ikm=root_master_key)
share_blob    = encrypt(txt_key, ikm=recipient_umk)          # fresh salt
UPSERT txt_shares (txt_id, user_id=recipient, txt_key=share_blob)

recipient_meta_key = unwrap(txt_metadata.txt_metadata_key for the recipient, ikm=recipient_umk)
recipient_meta      = decrypt(txt_metadata.content for the recipient, ikm=recipient_meta_key)
recipient_meta[txt_id] = <filename, read from the owner's txt_metadata>
write back recipient_meta, re-encrypted under recipient_meta_key
```

**Revoke**:

```
DELETE FROM txt_shares WHERE txt_id = ? AND user_id = ?
-- also: remove txt_id from the recipient's txt_metadata, and delete their
-- txt_access/bookmarks rows for this txt_id, since they can no longer decrypt it
```

Revocation is not forward-secure: it stops future decryption through this grant, but a plaintext copy the recipient already retrieved (or the still-valid `txt_key` bytes, if they cached them) is outside this system's control. See [security.md](security.md).

## Bookmark Encryption

```
plaintext = JSON.stringify({part_num, line, txt_preview})
```

Encrypted with a fresh random salt per bookmark, keyed off the file's `txt_key` — unwrapped via `txt.txt_key` if you're the owner, or `txt_shares.txt_key` if you're a grantee (see the table above). The `txt_id`/`user_id` foreign keys are the only plaintext metadata stored; part number, line index, and preview are never visible to the database file.

## Security Properties

| Property | Mechanism |
|----------|-----------|
| Confidentiality | Ascon-Keccak (512-bit key+IV, 512-bit tag) |
| Integrity / authenticity | 64-byte Ascon-Keccak tag |
| Header integrity | Magic + version + salt passed as AD; tag covers all of it, not just salt — tampering with the format identity or version fails authentication, not just tampering with the salt |
| Fast malformed-input rejection | Magic bytes checked before any crypto work; non-vault blobs are rejected immediately |
| Format evolution without downtime | Every blob carries its own version; old and new versions coexist indefinitely, upgraded lazily on next write (see Blob Format above) |
| Per-user key isolation | Each user's own files and filenames are wrapped under that user's own `umk`; possessing one user's `umk` does not unwrap another user's `umk`, un-shared files, or un-shared filenames |
| Per-recipient share isolation | A share re-wraps a file's `txt_key` under one specific recipient's `umk` in `txt_shares`; it does not expose the owner's `umk` or any of the owner's other files |
| No forward secrecy on revoke | Deleting a `txt_shares` grant stops future decryption through it, but doesn't invalidate a plaintext copy the (former) recipient already retrieved |
| Key isolation per blob | HKDF with a unique random salt per blob, at every tier |
| Compression oracle mitigation | Compress before encrypt; no adaptive queries |

See [security.md](security.md) for what this scheme does and does not protect against.
