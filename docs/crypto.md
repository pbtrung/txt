# Crypto

## Primitives

| Primitive | leancrypto API | Parameters |
|---|---|---|
| AEAD | Ascon-Keccak (`lc_ak_alloc_taglen`) | 64-byte key, 64-byte IV, 64-byte tag |
| KDF | HKDF-SHA3-512 (`lc_hkdf_*`) | produces 128 bytes of OKM (64-byte AEAD key + 64-byte IV) |
| KEM | ML-KEM-1024 composite with X448 (Curve448) (`lc_kem_*`) | see Composite KEM Key Sizes below |

### Composite KEM Key Sizes

Each `key_store` keypair concatenates an ML-KEM-1024 keypair with an X448 keypair:

| Component | pub_key | priv_key |
|---|---|---|
| ML-KEM-1024 | 1568 bytes | 3168 bytes |
| X448 | 56 bytes | 56 bytes |
| **Composite (concatenated)** | **1624 bytes** | **3224 bytes** |

`key_store.pub_key` stores the raw 1624-byte composite public key. `key_store.priv_key` wraps the raw 3224-byte composite private key using the standard Encrypt procedure below (IKM = owner's `umk`), so the stored blob is 3224 + 132 = 3356 bytes.

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

## Encapsulate / Decapsulate (Asymmetric Wrap)

Used wherever key material must be wrapped under a *recipient's* public key rather than a key the wrapper already holds (e.g. sharing a document's `txt_key` with another user via their `key_store.pub_key`) — the standard Encrypt/Decrypt above requires holding the same IKM on both ends, which doesn't work when the wrapper isn't the recipient.

**Encapsulate** (sender, holding the recipient's composite `pub_key`):

1. Run ML-KEM-1024 encapsulation against the ML-KEM component of `pub_key`, producing a KEM ciphertext (`kem_ct`, 1568 bytes) and a 32-byte KEM shared secret (`ss_kem`).
2. Generate an ephemeral X448 keypair and perform an X448 exchange against the X448 component of `pub_key`, producing a 56-byte X448 shared secret (`ss_x448`). The ephemeral public key (`eph_x448_pub`, 56 bytes) is public and travels alongside `kem_ct`.
3. Combine the two shared secrets into a combined key via HKDF-SHA3-512's Extract step alone: `PRK = HKDF-Extract(salt=none, IKM=ss_kem || ss_x448)`. HKDF-Extract's output length is fixed to the underlying hash's digest size regardless of input length, so `PRK` is always 64 bytes (SHA3-512's digest size) — unlike the 128-byte OKM the *full* HKDF-SHA3-512(IKM, salt) produces in Encrypt/Decrypt, which runs Extract-then-Expand.
4. Run the standard Encrypt procedure using `PRK` as its IKM to wrap the key material being shared — that call performs its own fresh Extract-then-Expand with a new random salt, so `PRK` is combined with entropy the recipient doesn't need to separately transmit.
5. The recipient needs `kem_ct` and `eph_x448_pub` (in addition to the resulting blob) to decapsulate — e.g. `txt_shares.kem_ct`/`txt_shares.eph_x448_pub` in data_model.md.

**Decapsulate** (recipient, holding their composite `priv_key`):

1. Run ML-KEM-1024 decapsulation on `kem_ct` using the ML-KEM component of `priv_key`, recovering `ss_kem`.
2. Perform an X448 exchange between the X448 component of `priv_key` and `eph_x448_pub`, recovering `ss_x448`.
3. Recompute `PRK = HKDF-Extract(salt=none, IKM=ss_kem || ss_x448)`, identical to Encapsulate step 3.
4. Run the standard Decrypt procedure using `PRK` as its IKM to unwrap the key material.

The combiner (step 3) is concatenate-then-Extract: `HKDF-Extract(none, ss_kem || ss_x448)`. This is a standard robust combiner — the combined key stays secure as long as at least one of ML-KEM-1024 or X448 remains unbroken — but it does not bind `kem_ct` or either party's public key into the derivation, only the two raw shared secrets. Hybrid-KEM designs such as X-Wing additionally fold `kem_ct`, `eph_x448_pub`, and the recipient's static X448 `pub_key` into the derivation (e.g. as HKDF `info`) for domain separation and cross-protocol safety; worth adopting the same refinement here.
