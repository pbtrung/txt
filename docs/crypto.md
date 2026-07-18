# Crypto

## Primitives

| Primitive | leancrypto API | Parameters |
|---|---|---|
| AEAD | Ascon-Keccak (`lc_ak_alloc_taglen`) | 64-byte key, 64-byte IV, 64-byte tag |
| KDF | HKDF-SHA3-512 (`lc_hkdf_*`) | produces 128 bytes of OKM (64-byte AEAD key + 64-byte IV) |

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

## Encrypt

Given a plaintext payload and an IKM (input keying material — the caller's key from the applicable key hierarchy):

1. Generate a random 64-byte `salt`.
2. Derive OKM via `HKDF-SHA3-512(IKM, salt)` — 128 bytes (64-byte AEAD key + 64-byte IV).
3. Split the OKM into the AEAD key and IV.
4. If the payload is a structured (e.g. JSON) payload, brotli-compress it first; raw binary payloads are used as-is.
5. Set `magic = 0x54 0x58`, `version` to the current format version.
6. Build `AD = magic || version || salt` (68 bytes).
7. Run Ascon-Keccak AEAD encrypt with the derived key, IV, and AD over the (compressed) payload, producing `ciphertext` and a 64-byte `tag`.
8. Assemble the blob: `magic || version || salt || ciphertext || tag`.

## Decrypt

Given a blob and the same IKM used to encrypt it:

1. Reject the blob if it is shorter than 132 bytes.
2. Parse `magic`, `version`, `salt`, `ciphertext`, `tag` from their fixed offsets.
3. Verify `magic == 0x54 0x58`; reject otherwise.
4. Verify `version`'s major byte matches a major version this decoder supports; reject otherwise (see Version Numbering).
5. Rebuild `AD = magic || version || salt`.
6. Derive the same OKM via `HKDF-SHA3-512(IKM, salt)` and split it into the AEAD key and IV, exactly as in Encrypt step 2–3.
7. Run Ascon-Keccak AEAD decrypt with the derived key, IV, AD, `ciphertext`, and `tag`. If tag verification fails, abort — no plaintext is returned.
8. If the payload was brotli-compressed at encrypt time, brotli-decompress the decrypted bytes to recover the original payload.
