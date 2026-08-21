# Crypto

## Primitives

| Primitive | leancrypto API                                                                    | Parameters                                                                            |
| --------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| AEAD      | Ascon-Keccak (`lc_ak_alloc_taglen`)                                               | 64-byte key, 64-byte IV, 64-byte tag                                                  |
| KDF       | HKDF-SHA3-512 (`lc_hkdf_*`)                                                       | produces 128 bytes of OKM (64-byte AEAD key + 64-byte IV)                             |
| KEM       | ML-KEM-1024 + X448 (Curve448) hybrid (`lc_kyber_1024_x448_keypair`/`_enc`/`_dec`) | see Composite KEM Key Sizes below                                                     |
| Signature | Web Crypto ECDSA P-521 with SHA-512                                               | signing-suite v1, request-proof protocol v2; approximately 256-bit classical security |

### Composite KEM Key Sizes

The owner's `owner_control` KEM keypair is leancrypto's
`lc_kyber_1024_x448` hybrid keypair—a single
`lc_kyber_1024_x448_keypair` call, not something this codebase assembles by
hand. Internally it combines an ML-KEM-1024 keypair with an X448 keypair:

| Component     | pubKey         | privKey        |
| ------------- | -------------- | -------------- |
| ML-KEM-1024   | 1568 bytes     | 3168 bytes     |
| X448          | 56 bytes       | 56 bytes       |
| **Composite** | **1624 bytes** | **3224 bytes** |

`owner_control.kem_public_key` stores the raw 1624-byte composite public key.
`owner_control.wrapped_kem_private_key` wraps the raw 3224-byte composite private
key using the standard Encrypt procedure below with the owner's 128-byte `umk`
as IKM, so the stored blob is 3224 + 132 = 3356 bytes.
`owner_control.wrapped_umk` contains that UMK wrapped by the owner's 256-byte
`user_root_key`. Public book sharing does not use this KEM keypair.

### Versioned request signatures

The owner has a separate signing key for proving possession when calling
`/v1/r2-token` (`docs/auth.md`). This key is unrelated to the composite KEM
keypair above. The active signing suite is stored with the key and authenticated
by the API-signed ticket. The proof protocol has its own version because changing
the canonical message does not necessarily require rotating the key suite.

| version | algorithm                | public-key encoding      | private-key encoding         | signature encoding                                                              |
| ------: | ------------------------ | ------------------------ | ---------------------------- | ------------------------------------------------------------------------------- |
|       1 | ECDSA P-521 with SHA-512 | SubjectPublicKeyInfo DER | PKCS#8 DER, wrapped by `umk` | Web Crypto raw signature: 66-byte `r` followed by 66-byte `s` (132 bytes total) |

Signing suite 1 is the only accepted suite. P-521 offers approximately 256-bit classical security but is not post-quantum secure.

For proof protocol version 2 using signing suite 1, the browser and API construct
these bytes exactly:

```
UTF8("txt:r2-ticket-proof") || 0x00 ||
U32BE(proof_version) ||
SHA-256(UTF8(exact_compact_r2_ticket)) ||
user_handle_32_bytes ||
U64BE(expires_at_unix_seconds) ||
request_id_32_bytes ||
SHA-512(UTF8(db_path) || UTF8(db_prefix))
```

The browser signs the hash of the exact compact JWS string it sends, including
its original base64url segments. Re-serializing the ticket payload before hashing
is forbidden. `user_handle` must decode to exactly 32 bytes. `db_path` and
`db_prefix` must each be exactly 52 lowercase base32-Crockford characters,
making their concatenation unambiguous. The fixed domain label prevents
cross-protocol use. Integer encodings are unsigned network byte order. The
request id comes from `crypto.getRandomValues`; expiry is at most 60 seconds
after API time.

The browser signs the canonical bytes with:

```js
crypto.subtle.sign({ name: "ECDSA", hash: "SHA-512" }, privateKey, canonicalProof);
```

Web Crypto returns the P-521 ECDSA signature as two fixed-width integers in order: `r` followed by `s`. Each integer is a 66-byte unsigned big-endian value, left-padded with zero bytes when necessary. The resulting signature is exactly 132 bytes (`r`, 66 bytes, plus `s`, 66 bytes). This is the raw IEEE P1363 form, not an ASN.1 DER sequence.

The API first verifies the ticket and imports its authenticated
`sign_public_key` as P-521 SPKI. It requires the exact 132-byte signature format,
rebuilds the canonical proof independently, and verifies it with the same Web
Crypto parameters. A valid signature proves access to the owner's unwrapped
private key. Path authorization is the separate equality check between the final
SHA-512 value above and the ticket's authenticated `db_binding_hash`; handle
binding is `SHA-256(user_handle) == ticket.user_handle_hash`.

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

Public sharing encrypts the copied EPUB with the same blob format and an
independent 128-byte content key. The API sees neither plaintext nor key; it
returns only a short-lived exact-object R2 URL (`docs/sharing.md`).

## Version Numbering

| Version bytes | Meaning              |
| ------------- | -------------------- |
| `0x01 0x00`   | v1.0, current format |

Bump minor for additive, backward-compatible changes (e.g. new optional fields in a plaintext JSON payload, a brotli parameter change) — an older decoder can still decode a newer-minor blob by ignoring unknown fields.

Bump major for breaking changes (different cipher/KDF, different field sizes/ordering, different magic bytes) — a decoder must refuse a blob whose major version it doesn't recognize rather than attempt to decode it.

## Additional Data and HKDF info

The implemented blob format has no caller-supplied context. HKDF's `info` input is the empty byte string, and AEAD additional data is exactly the stored header:

```
HKDF-info = empty
AD = magic (2) || version (2) || salt (64)
```

The tag therefore authenticates the magic, version, salt, and ciphertext. A blob is bound to its IKM but not to a particular table, column, row, or application purpose; callers must not assume that moving a valid blob between two locations protected by the same IKM will fail authentication.

## Encrypt

Given a plaintext payload and an IKM (input keying material):

1. Generate a random 64-byte `salt`.
2. Derive OKM via `HKDF-SHA3-512(IKM, salt, info=empty)`—128 bytes (64-byte AEAD key + 64-byte IV).
3. Split the OKM into the AEAD key and IV.
4. If the payload is a structured (e.g. JSON) payload, brotli-compress it first; raw binary payloads are used as-is.
5. Set `magic = 0x54 0x58`, `version` to the current format version.
6. Build `AD = magic || version || salt`.
7. Run Ascon-Keccak AEAD encrypt with the derived key, IV, and AD over the (compressed) payload, producing `ciphertext` and a 64-byte `tag`.
8. Assemble the blob: `magic || version || salt || ciphertext || tag`.

## Decrypt

Given a blob and the same IKM used to encrypt it:

1. Reject the blob if it is shorter than 132 bytes.
2. Parse `magic`, `version`, `salt`, `ciphertext`, `tag` from their fixed offsets.
3. Verify `magic == 0x54 0x58`; reject otherwise.
4. Verify `version`'s major byte matches a major version this decoder supports; reject otherwise (see Version Numbering).
5. Rebuild `AD = magic || version || salt`.
6. Derive the same OKM via `HKDF-SHA3-512(IKM, salt, info=empty)` and split it into the AEAD key and IV, exactly as in Encrypt steps 2–3.
7. Run Ascon-Keccak AEAD decrypt with the derived key, IV, AD, `ciphertext`, and `tag`. If tag verification fails, abort; no plaintext is returned.
8. If the payload was brotli-compressed at encrypt time, brotli-decompress the decrypted bytes to recover the original payload.

## Composite KEM support

The Python leancrypto wrapper exposes composite keypair generation for owner
provisioning. It does not currently wrap encapsulation or decapsulation, and no
persisted application record or browser/API flow invokes those operations.
Public sharing instead creates an independent 128-byte symmetric content key and
places it only in the URL fragment and the owner's encrypted SQLCipher database.
