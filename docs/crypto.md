# Crypto

## Primitives

| Primitive | leancrypto API                                                                    | Parameters                                                                          |
| --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| AEAD      | Ascon-Keccak (`lc_ak_alloc_taglen`)                                               | 64-byte key, 64-byte IV, 64-byte tag                                                |
| KDF       | HKDF-SHA3-512 (`lc_hkdf_*`)                                                       | produces 128 bytes of OKM (64-byte AEAD key + 64-byte IV)                           |
| KEM       | ML-KEM-1024 + X448 (Curve448) hybrid (`lc_kyber_1024_x448_keypair`/`_enc`/`_dec`) | see Composite KEM Key Sizes below                                                   |
| Signature | Web Crypto ECDSA P-521 with SHA-512                                               | signing-suite v1, owner-proof protocol v1; approximately 256-bit classical security |

### Composite KEM Key Sizes

The owner's `owner` row's KEM keypair is leancrypto's `lc_kyber_1024_x448`
hybrid keypair — a single `lc_kyber_1024_x448_keypair` call, not something
this codebase assembles by hand. Internally it combines an ML-KEM-1024
keypair with an X448 keypair:

| Component     | pubKey         | privKey        |
| ------------- | -------------- | -------------- |
| ML-KEM-1024   | 1568 bytes     | 3168 bytes     |
| X448          | 56 bytes       | 56 bytes       |
| **Composite** | **1624 bytes** | **3224 bytes** |

`owner.kem_public_key` stores the raw 1624-byte composite public key.
`owner.wrapped_kem_private_key` wraps the raw 3224-byte composite private
key using the standard Encrypt procedure below with the owner's 128-byte
`umk` as IKM, so the stored blob is 3224 + 132 = 3356 bytes.
`owner.wrapped_umk` contains that UMK wrapped by the owner's 256-byte
`user_root_key`. Public sharing does not use this KEM keypair.

### Owner-proof signatures

The owner has a signing key for proving possession when calling any
D1-mutating `/v1/*` endpoint or requesting R2 credentials
(`docs/auth.md` §4). This key is unrelated to the composite KEM keypair
above. The active signing suite is stored with the key and authenticated
by the API-signed ticket.

| version | algorithm                | public-key encoding      | private-key encoding         | signature encoding                                                              |
| ------: | ------------------------ | ------------------------ | ---------------------------- | ------------------------------------------------------------------------------- |
|       1 | ECDSA P-521 with SHA-512 | SubjectPublicKeyInfo DER | PKCS#8 DER, wrapped by `umk` | Web Crypto raw signature: 66-byte `r` followed by 66-byte `s` (132 bytes total) |

Signing suite 1 is the only accepted suite. P-521 offers approximately
256-bit classical security but is not post-quantum secure.

For owner-proof protocol version 1 using signing suite 1, the browser and
Worker construct these bytes exactly:

```
UTF8("txt:owner-proof:v1") || 0x00 ||
SHA-256(UTF8(exact_compact_ticket)) ||
user_handle_32_bytes ||
U64BE(expires_at_unix_seconds) ||
request_id_32_bytes ||
SHA-256(UTF8(db_prefix)) ||
SHA-256(UTF8(method) || 0x00 || UTF8(path) || 0x00 || body)
```

The browser signs the hash of the exact compact ticket string it sends,
including its original base64url segments. Re-serializing the ticket
payload before hashing is forbidden. `user_handle` must decode to exactly
32 bytes. `db_prefix` must be exactly 52 lowercase base32-Crockford
characters. `method` and `path` are the exact HTTP method and full request
path of the request the proof authorizes — not just an abstract operation
name — so that a captured proof for one request cannot be replayed against
a different target of the same kind (`docs/auth.md` §4.2). `body` is the
exact request body bytes, or empty for a bodyless request. The fixed
domain label prevents cross-protocol use. Integer encodings are unsigned
network byte order. The request id comes from `crypto.getRandomValues`;
expiry is at most 60 seconds after Worker time.

The browser signs the canonical bytes with:

```js
crypto.subtle.sign({ name: "ECDSA", hash: "SHA-512" }, privateKey, canonicalProof);
```

Web Crypto returns the P-521 ECDSA signature as two fixed-width integers
in order: `r` followed by `s`. Each integer is a 66-byte unsigned
big-endian value, left-padded with zero bytes when necessary. The
resulting signature is exactly 132 bytes. This is the raw IEEE P1363
form, not an ASN.1 DER sequence.

The Worker first verifies the ticket and imports its authenticated
`sign_public_key` as P-521 SPKI. It requires the exact 132-byte signature
format, rebuilds the canonical proof independently for the exact request
it received, and verifies it with the same Web Crypto parameters. A valid
signature proves access to the owner's unwrapped private key. Path
authorization is the separate equality check between
`SHA-256(UTF8(db_prefix))` above and the ticket's authenticated
`db_binding_hash`; handle binding is
`SHA-256(user_handle) == ticket.user_handle_hash`.

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

Bump minor for additive, backward-compatible changes (e.g. new optional
fields in a plaintext JSON payload, a brotli parameter change) — an older
decoder can still decode a newer-minor blob by ignoring unknown fields.

Bump major for breaking changes (different cipher/KDF, different field
sizes/ordering, different magic bytes) — a decoder must refuse a blob
whose major version it doesn't recognize rather than attempt to decode
it.

## Additional Data and HKDF info

The implemented blob format has no caller-supplied context. HKDF's `info`
input is the empty byte string, and AEAD additional data is exactly the
stored header:

```
HKDF-info = empty
AD = magic (2) || version (2) || salt (64)
```

The tag therefore authenticates the magic, version, salt, and ciphertext.
A blob is bound to its IKM but not to a particular table, column, row, or
application purpose; callers must not assume that moving a valid blob
between two locations protected by the same IKM will fail authentication.
Per-row keys (`docs/data_model.md` §1) are what actually give each row's
ciphertext a distinct, non-relocatable identity.

## Encrypt

Given a plaintext payload and an IKM (input keying material):

1. Generate a random 64-byte `salt`.
2. Derive OKM via `HKDF-SHA3-512(IKM, salt, info=empty)`—128 bytes
   (64-byte AEAD key + 64-byte IV).
3. Split the OKM into the AEAD key and IV.
4. If the payload is a structured (e.g. JSON) payload, brotli-compress it
   first; raw binary payloads are used as-is.
5. Set `magic = 0x54 0x58`, `version` to the current format version.
6. Build `AD = magic || version || salt`.
7. Run Ascon-Keccak AEAD encrypt with the derived key, IV, and AD over
   the (compressed) payload, producing `ciphertext` and a 64-byte `tag`.
8. Assemble the blob: `magic || version || salt || ciphertext || tag`.

## Decrypt

Given a blob and the same IKM used to encrypt it:

1. Reject the blob if it is shorter than 132 bytes.
2. Parse `magic`, `version`, `salt`, `ciphertext`, `tag` from their fixed
   offsets.
3. Verify `magic == 0x54 0x58`; reject otherwise.
4. Verify `version`'s major byte matches a major version this decoder
   supports; reject otherwise (see Version Numbering).
5. Rebuild `AD = magic || version || salt`.
6. Derive the same OKM via `HKDF-SHA3-512(IKM, salt, info=empty)` and
   split it into the AEAD key and IV, exactly as in Encrypt steps 2–3.
7. Run Ascon-Keccak AEAD decrypt with the derived key, IV, AD,
   `ciphertext`, and `tag`. If tag verification fails, abort; no
   plaintext is returned.
8. If the payload was brotli-compressed at encrypt time, brotli-decompress
   the decrypted bytes to recover the original payload.

## Composite KEM support

The Python leancrypto wrapper's composite keypair generation is used only
for owner provisioning; encapsulation and decapsulation are intentionally
unwrapped, since no persisted application record or browser/Worker flow
invokes those operations. Public sharing instead creates an independent
128-byte symmetric content key and places it only in the URL fragment and
the owner's D1 database (`docs/data_model.md`); the shared EPUB copy
itself is encrypted with the same Blob Format above, client-side, and
uploaded directly to R2 by the browser — the Worker never receives the
plaintext EPUB or `share_content_key` (`docs/sharing.md`).

## Share grant envelope

The Worker encrypts each share's exact R2 object path with a second,
independent primitive stack — native Web Crypto AES-256-GCM/HKDF-SHA-256,
not the Ascon-Keccak Blob Format above — so the exact path can travel
from the Worker to a share URL and back without ever being written to D1
in the clear. This envelope only ever holds the object path string
(`docs/sharing.md`); it never touches key material, plaintext content, or
the owner's Blob-Format payloads.

```
version (1) || salt (32) || nonce (12) || sealed (var)
```

| Field   | Size     | Value                                    |
| ------- | -------- | ---------------------------------------- |
| version | 1 byte   | `0x01`                                   |
| salt    | 32 bytes | random per grant, HKDF salt              |
| nonce   | 12 bytes | random per grant, AES-GCM IV             |
| sealed  | variable | ciphertext followed by a 16-byte GCM tag |

The envelope is base64url-encoded end to end. Given `SHARE_GRANT_KEY` (a
32-byte secret held only by the Worker, independent of every key in the
Blob Format above) and the share's `id_hash = SHA-256(raw share_id)`:

1. Generate a random 32-byte `salt` and a random 12-byte `nonce`.
2. Derive a 256-bit AES key: `crypto.subtle.deriveKey({ name: "HKDF",
hash: "SHA-256", salt, info: UTF8("txt:share-grant-key:v1") ||
id_hash }, ikmKey, { name: "AES-GCM", length: 256 }, false,
["encrypt"])` — binding the derived key to this specific `share_id`,
   via HKDF's `info`, without needing a separate stored key per share.
3. Seal the object path with AES-256-GCM under that key and nonce, with
   additional data `UTF8("txt:share-grant:v1") || id_hash` (binding the
   ciphertext to that specific share too, so it cannot be replayed
   against a different one).
4. Assemble and base64url-encode `version || salt || nonce || sealed`.

Decryption reverses this exactly and rejects a grant whose version byte,
length, or AEAD tag doesn't match; a grant decrypted under a different
`id_hash` fails tag verification because the additional data no longer
matches.

Only the Worker (holding `SHARE_GRANT_KEY`) can produce or open a grant.
Decrypting it recovers the object path, which the Worker then re-hashes
and compares against the `shares` row's `object_path_hash` before doing
anything with it — the grant proves the caller was handed a real object
path by the Worker, and the hash check proves that path is still the one
currently registered and `active` for this `share_id` (`docs/sharing.md`).
