# Primitives

| Primitive | leancrypto API | Parameters |
|-----------|---------------|------------|
| AEAD | Ascon-Keccak (`lc_ak_alloc_taglen`) | 64-byte key, 64-byte IV, 64-byte tag |
| KDF | HKDF-SHA3-512 (`lc_hkdf_*`) | produces 128 or 160 bytes of OKM |
| MAC | HMAC-SHA3-256 (`lc_hmac_*`) | 32-byte digest (currently unused; kept in case a future blind-index lookup need arises) |

Password verification is Firebase's responsibility entirely, not this app's.

# Blob Format

Every encrypted blob — the small wrapped-key columns (`umkStore.umkBlob`, `txt.txtKeyBlob`, `metadataStore.metadataKeyBlob`) and the bulk content stored as `$files` bytes (a `txt` row's content + history, its read-position, a bookmark's payload, the metadata index's content) — shares one wire format:

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

## Version numbering

| Version bytes | Meaning |
|----------------|---------|
| `0x01 0x00` | v1.0, current format |

Bump minor for additive, backward-compatible changes (e.g. new optional fields in a plaintext JSON payload, a brotli parameter change) — an older decoder can still decode a newer-minor blob by ignoring unknown fields. Bump major for breaking changes (different cipher/KDF, different field sizes/ordering, different magic bytes) — a decoder must refuse a blob whose major version it doesn't recognize rather than attempt to decode it. InstantDB stores these blobs as opaque strings/file bytes, so old and new blob versions can coexist in the same app indefinitely without a coordinated rewrite.

## Additional Data (AD)

```
AD = magic (2) || version (2) || salt (64)   -> 68 bytes total
```

The AEAD tag covers the blob header as well as the ciphertext: any single-bit modification to the magic, version, salt, ciphertext, or tag causes authentication failure before any plaintext is returned — this binds the blob's format identity and version to its authenticity, not just its salt.

## Upgrade handling

A blob is re-encrypted to the current version lazily, on next write. An explicit "re-encrypt all" pass can upgrade eagerly if needed.

# Key Derivation

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
| a `txt` row's content + history (`$files`, via `txtPartFile`) | that `txt` row's decrypted `txtKeyBlob` |
| a `txt` row's read-position (`$files`, via `txtAccessFileEntry`, off `txtAccess`) | that `txt` row's decrypted `txtKeyBlob` |
| a bookmark's content (`$files`, via `bookmarkFileEntry`, off `bookmarks`) | that bookmark's owning `txt` row's decrypted `txtKeyBlob` |
| the metadata index's content (`$files`, via `txtMetadataFile`) | that user's decrypted `metadataKey` |

# Encrypt / Decrypt

Same Ascon-Keccak AEAD scheme and AD as Blob Format above; structured/textual payloads are brotli-compressed before encryption, raw key material never is:

```
plaintext  = raw bytes of the payload
             (umk, txtKeyBlob, metadataKey: raw, no compression;
              a txt row's content + history, its read-position, a bookmark's
              content, the metadata index's content: brotli-compressed)
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