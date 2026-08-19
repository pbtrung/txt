# Crypto

## Primitives

| Primitive | leancrypto API                                                                    | Parameters                                                |
| --------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| AEAD      | Ascon-Keccak (`lc_ak_alloc_taglen`)                                               | 64-byte key, 64-byte IV, 64-byte tag                      |
| KDF       | HKDF-SHA3-512 (`lc_hkdf_*`)                                                       | produces 128 bytes of OKM (64-byte AEAD key + 64-byte IV) |
| KEM       | ML-KEM-1024 + X448 (Curve448) hybrid (`lc_kyber_1024_x448_keypair`/`_enc`/`_dec`) | see Composite KEM Key Sizes below                         |
| Signature | Web Crypto ECDSA P-521 with SHA-512                                               | signing-suite v1, request-proof protocol v2; approximately 256-bit classical security |

### Composite KEM Key Sizes

Each `keyStore` keypair is leancrypto's `lc_kyber_1024_x448` hybrid keypair — a single `lc_kyber_1024_x448_keypair` call, not something this codebase assembles by hand. Internally it combines an ML-KEM-1024 keypair with an X448 keypair:

| Component     | pubKey         | privKey        |
| ------------- | -------------- | -------------- |
| ML-KEM-1024   | 1568 bytes     | 3168 bytes     |
| X448          | 56 bytes       | 56 bytes       |
| **Composite** | **1624 bytes** | **3224 bytes** |

`keyStore.pubKey` stores the raw 1624-byte composite public key. `keyStore.privKey` wraps the raw 3224-byte composite private key using the standard Encrypt procedure below (IKM = that row's unwrapped `keyStoreKey`), so the stored blob is 3224 + 132 = 3356 bytes. The owner's `umk` wraps `keyStoreKey`, not `privKey` directly.

### Versioned request signatures

Every account has a separate signing key for proving possession when calling `/v1/r2-token` (docs/auth.md). This key is unrelated to the administrator-only composite KEM keypair above. The active signing suite is stored with the key and authenticated by the Worker-signed ticket. The proof protocol has its own version because changing the canonical message does not necessarily require rotating the key suite.

| version | algorithm | public-key encoding | private-key encoding | signature encoding |
|---:|---|---|---|---|
| 1 | ECDSA P-521 with SHA-512 | SubjectPublicKeyInfo DER | PKCS#8 DER, wrapped by `umk` | Web Crypto raw signature: 66-byte `r` followed by 66-byte `s` (132 bytes total) |
| 2 (reserved) | P-521 plus ML-DSA-87 hybrid | versioned composite envelope | versioned composite envelope, wrapped by `umk` | versioned envelope containing both signatures |

Version 2 is reserved as the migration direction, not accepted today. When enabled, the Worker must verify both the P-521 and ML-DSA-87 components over the identical canonical message; accepting either component alone would permit downgrade. Version-specific public/private blobs are opaque to the generic endpoint layer, so adding the hybrid does not change the JSON envelope. P-521 offers approximately 256-bit classical security but is not post-quantum secure.

For proof protocol version 2 using signing suite 1, the client and Worker construct these bytes exactly:

```
UTF8("txt:r2-ticket-proof") || 0x00 ||
U32BE(proof_version) ||
SHA-256(UTF8(exact_compact_r2_ticket)) ||
user_handle_32_bytes ||
U64BE(expires_at_unix_seconds) ||
request_id_32_bytes ||
SHA-512(UTF8(db_path) || UTF8(db_prefix))
```

The client signs the hash of the exact compact JWS string it sends, including its original base64url segments. Re-serializing the ticket payload before hashing is forbidden. `user_handle` must decode to exactly 32 bytes. `db_path` and `db_prefix` must each be exactly 52 lowercase base32-Crockford characters, making their concatenation unambiguous. The fixed domain label prevents cross-protocol use. Integer encodings are unsigned network byte order. The request id comes from `crypto.getRandomValues`; expiry is at most 60 seconds after Worker time.

The browser signs the canonical bytes with:

```js
crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-512" },
  privateKey,
  canonicalProof,
)
```

Web Crypto returns the P-521 ECDSA signature as two fixed-width integers in order: `r` followed by `s`. Each integer is a 66-byte unsigned big-endian value, left-padded with zero bytes when necessary. The resulting signature is exactly 132 bytes (`r`, 66 bytes, plus `s`, 66 bytes). This is the raw IEEE P1363 form, not an ASN.1 DER sequence.

The Worker first verifies the ticket and imports its authenticated `sign_public_key` as P-521 SPKI. It requires the exact 132-byte signature format, rebuilds the canonical proof independently, and verifies it with the same Web Crypto parameters. A valid signature proves access to the unwrapped per-user private key. Path authorization is the separate equality check between the final SHA-512 value above and the ticket's authenticated `db_binding_hash`; handle binding is `SHA-256(user_handle) == ticket.user_handle_hash`.

## Blob Format

```
magic (2) || version (2) || salt (64) || ciphertext (var) || tag (64)
```

| Field      | Size     | Value                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------ |
| magic      | 2 bytes  | `0x54 0x58` ("TX")                                                             |
| version    | 2 bytes  | major · minor (e.g. `0x01 0x00` = v1.0)                                        |
| salt       | 64 bytes | random per blob, HKDF input salt                                               |
| ciphertext | variable | AEAD-encrypted (and, for structured payloads, brotli-compressed) payload bytes |
| tag        | 64 bytes | Ascon-Keccak authentication tag covering AD + ciphertext                       |

Minimum valid blob length: 2 + 2 + 64 + 0 + 64 = 132 bytes.

## Version Numbering

| Version bytes | Meaning              |
| ------------- | -------------------- |
| `0x01 0x00`   | v1.0, current format |

Bump minor for additive, backward-compatible changes (e.g. new optional fields in a plaintext JSON payload, a brotli parameter change) — an older decoder can still decode a newer-minor blob by ignoring unknown fields.

Bump major for breaking changes (different cipher/KDF, different field sizes/ordering, different magic bytes) — a decoder must refuse a blob whose major version it doesn't recognize rather than attempt to decode it.

## Additional Data (AD)

**Not yet implemented.** `txt/crypto.ts`'s `blobEncrypt`/`blobDecrypt` currently build `AD = magic || version || salt` only, with no `context` input, and no caller passes one — everything below describes the intended design for the layer that will consume it (key_hierarchy.md's `<field>Context` columns), not current code.

```
AD = magic (2) || version (2) || salt (64) || context (var)
```

The AEAD tag covers the blob header, `context`, and the ciphertext: any single-bit modification to the magic, version, salt, context, ciphertext, or tag causes authentication failure before any plaintext is returned — this binds the blob's format identity, version, and context to its authenticity, not just its salt.

`context` is an opaque byte string the caller supplies alongside the IKM, for domain separation — it is never stored in the blob and never derived from the blob's own bytes, the same as the IKM itself. Its job: when one IKM protects more than one logically distinct value (the common case throughout this design's key hierarchy — see key_hierarchy.md), each such value is encrypted under its own distinct `context`, so a blob copied from one column or row into another decrypts under the wrong `context` and fails authentication rather than silently succeeding against the wrong value. `context` is not secret — its security value comes entirely from living outside the ciphertext being moved, not from being hidden, so it is typically stored in plaintext next to the column it protects (see key_hierarchy.md's Context columns). This document only defines the mechanism; which columns need one and what value each uses is a question for the layer that actually has a schema (key_hierarchy.md/data_model.md), not this one.

## Encrypt

Given a plaintext payload, an IKM (input keying material — the caller's key from the applicable key hierarchy), and a `context` (see Additional Data above):

1. Generate a random 64-byte `salt`.
2. Derive OKM via `HKDF-SHA3-512(IKM, salt, info=context)` — 128 bytes (64-byte AEAD key + 64-byte IV).
3. Split the OKM into the AEAD key and IV.
4. If the payload is a structured (e.g. JSON) payload, brotli-compress it first; raw binary payloads are used as-is.
5. Set `magic = 0x54 0x58`, `version` to the current format version.
6. Build `AD = magic || version || salt || context`.
7. Run Ascon-Keccak AEAD encrypt with the derived key, IV, and AD over the (compressed) payload, producing `ciphertext` and a 64-byte `tag`.
8. Assemble the blob: `magic || version || salt || ciphertext || tag` — `context` is not part of the assembled blob; the caller must supply the identical `context` again at Decrypt.

## Decrypt

Given a blob, the same IKM used to encrypt it, and the same `context` used to encrypt it:

1. Reject the blob if it is shorter than 132 bytes.
2. Parse `magic`, `version`, `salt`, `ciphertext`, `tag` from their fixed offsets.
3. Verify `magic == 0x54 0x58`; reject otherwise.
4. Verify `version`'s major byte matches a major version this decoder supports; reject otherwise (see Version Numbering).
5. Rebuild `AD = magic || version || salt || context`.
6. Derive the same OKM via `HKDF-SHA3-512(IKM, salt, info=context)` and split it into the AEAD key and IV, exactly as in Encrypt steps 2–3.
7. Run Ascon-Keccak AEAD decrypt with the derived key, IV, AD, `ciphertext`, and `tag`. If tag verification fails — including because the wrong `context` was supplied — abort; no plaintext is returned.
8. If the payload was brotli-compressed at encrypt time, brotli-decompress the decrypted bytes to recover the original payload.

## Encapsulate / Decapsulate (Asymmetric Wrap)

Used wherever key material must be wrapped under a _recipient's_ public key rather than a key the wrapper already holds. Public book sharing does not use this operation: the administrator creates a fresh symmetric content key and puts it only in the capability URL and the administrator's encrypted SQLCipher database. `keyStore`'s composite keypair, and this section, are kept for a future feature that needs an asymmetric recipient wrap.

**Encapsulate** (sender, holding the recipient's composite `pubKey`):

1. Run `lc_kyber_1024_x448_enc` against `pubKey`, producing a KEM ciphertext (`ct`, 1624 bytes) and an 88-byte shared secret (`ss`). Deliberately not `lc_kyber_1024_x448_enc_kdf`: the plain `_enc` call hands back `ss` as leancrypto's `lc_kyber_1024_x448_ss` struct, the raw concatenation of the 32-byte ML-KEM-1024 shared secret and the 56-byte X448 shared secret — uncombined. (`_enc_kdf` would instead run its own internal KMAC256-based combiner and return a caller-chosen-length already-combined secret; using it here would mean trusting/depending on a second KDF construction alongside HKDF-SHA3-512 for no benefit.)
2. Run the standard Encrypt procedure using `ss` as its IKM and a caller-supplied `context` (see key_hierarchy.md for the value this design uses) to wrap the key material being shared. Encrypt generates a random 64-byte `salt`, derives a 128-byte OKM via `HKDF-SHA3-512(ss, salt, info=context)`, and embeds that salt (not `context`) in the standard blob (`magic||version||salt||ciphertext||tag`). This HKDF call is also where the ML-KEM-1024/X448 combining actually happens (see below) — it isn't a separate step.
3. Store `ct` alongside the resulting blob — a `<field>Ct`/`<field>` pair, in whichever entity ends up using this (none does today; see the note above). The KEM ciphertext is sufficient for decapsulation; the recipient obtains the wrapping salt from the wrapped blob itself, and the same `context` from wherever the encrypting side got it (a fixed, non-secret value both sides can compute independently — see key_hierarchy.md).

**Decapsulate** (recipient, holding their composite `privKey`):

1. Read the stored `ct`.
2. Run `lc_kyber_1024_x448_dec` on `ct` using `privKey`, recovering the same raw `ss`.
3. Run the standard Decrypt procedure on the blob using `ss` as its IKM and the same `context` used at Encapsulate time — Decrypt parses the salt from the blob header itself.

The combiner is concatenate-then-HKDF: `ss` is `ML-KEM-1024-SS (32 bytes) || X448-SS (56 bytes)`, uncombined, and `HKDF-SHA3-512(ss, salt, info=context)` in Encapsulate step 2 above is what actually combines them — the same KDF this codebase already uses for every other Encrypt/Decrypt call, rather than a second, separate combiner. This is a standard robust construction: the derived key stays secure as long as at least one of ML-KEM-1024 or X448 remains unbroken. By itself it does not bind `ct` or either party's public key into the derivation, only the two raw shared secrets, `salt`, and whatever `context` happens to be. Hybrid-KEM designs such as X-Wing additionally fold `ct` and the recipient's static X448 `pubKey` into the derivation for domain separation and cross-protocol safety — this design's `context` mechanism is general enough to provide that too, by choosing `context = ct || pubKey` (or that concatenated onto the fixed per-share label from key_hierarchy.md) for this specific call site, rather than needing a second, separate mechanism.
