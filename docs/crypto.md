# Crypto

## Primitives

| Primitive | leancrypto API | Parameters |
|---|---|---|
| AEAD | Ascon-Keccak (`lc_ak_alloc_taglen`) | 64-byte key, 64-byte IV, 64-byte tag |
| KDF | HKDF-SHA3-512 (`lc_hkdf_*`) | produces 128 or 160 bytes of OKM |

## Blob Format

```
magic (2) || version (2) || salt (64) || ciphertext (var) || tag (64)
```

| Field | Size | Value |
|---|---|---|
| magic | 2 bytes | `0x54 0x58` ("TX") |
| version | 2 bytes | major · minor (e.g. `0x01 0x00` = v1.0) |
| salt | 64 bytes | random per blob, HKDF input salt |
| ciphertext | variable | AEAD-encrypted (and, for structured payloads, brotli-compressed) payload bytes |
| tag | 64 bytes | Ascon-Keccak authentication tag covering AD + ciphertext |

Minimum valid blob length: 2 + 2 + 64 + 0 + 64 = 132 bytes.

## Version Numbering

| Version bytes | Meaning |
|---|---|
| `0x01 0x00` | v1.0, current format |

Bump minor for additive, backward-compatible changes (e.g. new optional fields in a plaintext JSON payload, a brotli parameter change) — an older decoder can still decode a newer-minor blob by ignoring unknown fields.

Bump major for breaking changes (different cipher/KDF, different field sizes/ordering, different magic bytes) — a decoder must refuse a blob whose major version it doesn't recognize rather than attempt to decode it.

## Additional Data (AD)

```
AD = magic (2) || version (2) || salt (64)   -> 68 bytes total
```

The AEAD tag covers the blob header as well as the ciphertext: any single-bit modification to the magic, version, salt, ciphertext, or tag causes authentication failure before any plaintext is returned — this binds the blob's format identity and version to its authenticity, not just its salt.
