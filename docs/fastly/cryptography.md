# Cryptography and record validation

[The project cryptography contract](../crypto.md) is authoritative for every
primitive, key size, blob byte layout, version rule, Encrypt/Decrypt step, and
failure behavior used by this design. This document defines only how KV
Store entries and R2 objects use that existing contract. It does not define a
second encryption format.

This design uses the canonical versioned authenticated blob based on
Ascon-Keccak AEAD and HKDF-SHA3-512 everywhere — for every KV Store entry and
every R2 object, with no other encryption mechanism anywhere in the system.

## Encryption map

| Stored value                                     | Encryption                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `vault` key `book_{book_id}`                     | Canonical structured-payload blob from [docs/crypto.md](../crypto.md), using `vault_master_key` as IKM |
| `vault` key `reading_{book_id}`                  | Canonical structured-payload blob using `vault_master_key` as IKM                                       |
| `vault` key `reading-index`                      | Canonical structured-payload blob using `vault_master_key` as IKM                                       |
| R2 library snapshot                              | Canonical structured-payload blob using `vault_master_key` as IKM                                       |
| R2 administrative export                         | Canonical structured-payload blob using independent `EXPORT_KEY` as IKM                                 |
| Wrapped UMK/KEM/signing keys and credentials     | Existing wrapping/blob procedures in [docs/crypto.md](../crypto.md)                                     |
| Owner EPUB and independently encrypted share     | Existing canonical blob with the per-object content key                                                 |
| KV Store routing, version, and `catalog-head` data | Plaintext operational metadata protected by authorization and transport; no catalog text              |

Every KV Store entry and R2 object listed above is an independent canonical
authenticated blob providing its own confidentiality and integrity; there is
no page-level database encryption anywhere in this design. KV Store and R2
encryption at rest remain separate infrastructure controls and never replace
client-side blob encryption.

## Key hierarchy

- `user_root_key` exists only in the local unlock file and browser/CLI memory.
- The wrapped user master key, wrapped composite KEM private key, wrapped
  P-521 signing private key, and encrypted credential payload remain in the
  server-only `owner_control` entry and are returned through authenticated
  `/v1/keys`.
- `vault_master_key` is 128 bytes of key material, the IKM for every encrypted
  book, reading-state, reading-index, and catalog-snapshot value.
- The P-521 request-signing keypair from [docs/crypto.md](../crypto.md) is
  used for the per-request possession proof below. Its public half is stored
  in plaintext in the `owner_control` entry (public keys are not secret); its
  private half is wrapped by the user master key.
- Every EPUB retains its independent 128-byte `txt_key`.
- Every public share retains its independent 128-byte `share_content_key` and
  independently encrypted R2 object.
- Fastly and KV Store receive only wrapped keys, encrypted payloads, hashes,
  and operational metadata. They never receive plaintext root, vault,
  content, or share keys, and never receive the unwrapped signing private
  key — Fastly verifies signatures with the public key only.

Release plaintext key buffers on lock/logout as far as the runtime permits.
Keys, decrypted payloads, Firebase tokens, signatures, and signed requests must
not enter logs, analytics, metrics, or crash reports.

## Canonical blob usage

Call the exact Encrypt and Decrypt procedures from [docs/crypto.md](../crypto.md)
without changing their header, salt, HKDF inputs, AEAD parameters, tag, or
version handling. Structured JSON is Brotli-compressed by that procedure before
encryption. Store the resulting blob:

- as canonical unpadded base64url in a KV Store JSON `ciphertext` field; or
- as the raw blob bytes in an immutable R2 object.

Never prepend another private header, remove the canonical header, truncate
the tag, or feed a precompressed structured JSON payload into a path that
would compress it a second time.

The canonical blob format has no caller-supplied associated-data context. Its
HKDF `info` is empty and its AEAD additional data is the stored blob header,
exactly as documented in [docs/crypto.md](../crypto.md). Therefore a valid blob
is not cryptographically tied to a KV Store, key, kind, or R2 object key. The
application must enforce those bindings with authenticated inner envelope
fields and strict comparisons after decryption.

## Vault entry envelope

Every `vault`-store entry's `ciphertext` field
([data_model.md](data_model.md) shows the complete nested shape for each one)
decrypts to exactly the same eight-field envelope:

```json
{
  "purpose": "txt:<kind>",
  "envelope_version": 1,
  "container_role": "vault",
  "owner_pk": "own_opaqueRandomValue",
  "vault_id": "vault_opaqueRandomValue",
  "item_id": "<the outer entry's own identifier>",
  "kind": "<the outer entry's kind>",
  "record": { "...": "the entry-specific fields, defined in data_model.md" }
}
```

| `kind`                 | `purpose`                  | `item_id`       |
| ---------------------- | --------------------------- | ---------------- |
| `book`                 | `txt:book`                 | the book ID      |
| `reading`              | `txt:reading-state`        | the book ID      |
| `reading-index`        | `txt:reading-index`        | `reading-index`  |
| `catalog-head-pointer` | `txt:catalog-head-pointer` | `catalog-head`   |

Encrypt the canonical bytes with `vault_master_key` via the structured-payload
Encrypt procedure, then store its unpadded base64url encoding in `ciphertext`.

After Decrypt, reject the entire entry unless:

- `purpose` and `envelope_version` are exactly supported;
- `container_role`, `owner_pk`, `vault_id`, `item_id`, and `kind` equal the
  trusted outer route/entry values;
- for `book` and `reading`, `record.book_id` equals `item_id`; and
- canonical JSON parsing, duplicate-key rejection, and the full record schema
  all succeed.

These comparisons detect a blob copied to another key after it is decrypted;
the blob format itself does not prevent that copy. An authentication or
binding failure is a hard corruption/security error. Never return partial
plaintext, or retry a failed authentication with a different key or decoder,
on a target entry.

`catalog-head-pointer` is the one kind worth calling out specially: its
`record` is just `{ "object_key": "..." }`, Fastly stores the whole ciphertext
opaquely and never decrypts it, and it only ever sees the plaintext
`object_key` transiently, as a non-persisted request field, to perform the R2
existence check in `/v1/vault/commit` ([auth_api.md](auth_api.md)). Keeping
it wrapped at rest means a KV Store leak or mishandled administrative export
cannot reveal `db_prefix` or the snapshot object-naming pattern.

## Library snapshot envelope

The library snapshot uses the same canonical structured-payload blob. Its
decrypted canonical JSON object is:

```json
{
  "purpose": "txt:catalog",
  "envelope_version": 1,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "generation": 184,
  "object_key": "{db_prefix}/catalog/random",
  "snapshot_schema_version": 1,
  "books": []
}
```

Publication performs this exact sequence:

1. choose `generation` and the immutable `object_key`;
2. build and canonical-JSON serialize the complete envelope;
3. Encrypt it as a structured payload with `vault_master_key` according to
   [docs/crypto.md](../crypto.md); and
4. upload those bytes unchanged to the selected R2 key.

Then, separately, wrap `object_key` alone in the `catalog-head-pointer`
envelope (see Vault entry envelope above) for the `catalog-head` entry
Fastly is about to write.

On load, decrypt that wrapped pointer to obtain `object_key`, download that
object, and Decrypt it directly — there is no separate length or hash to
check first; the canonical blob's AEAD authentication is the integrity check,
and a failure here is treated as corruption requiring repair
([catalog.md](catalog.md)), the same as any other authentication failure in
this document. Then require all envelope identity fields to agree with the
authenticated owner bootstrap and head before accepting `books`. Validate the
snapshot schema, sort, unique IDs, and every projected record as defined in
[catalog.md](catalog.md). Reading state and bookmarks are not part of this
envelope — they live in the `reading` and `reading-index` vault entries
instead.

Every book, reading, and snapshot entry/object is encrypted in this one
canonical blob format from the moment it is written; no runtime route ever
falls back to any other decoder.

## Administrative export envelope

`EXPORT_KEY` is an independent 256-byte random IKM. It is never derived from
or reused as `vault_master_key`, an R2 key, or an application HMAC key. The
canonical export payload includes:

```json
{
  "purpose": "txt:export",
  "envelope_version": 1,
  "export_id": "export_opaqueRandomValue",
  "object_key": "{db_prefix}/exports/1787356800000-random.blob",
  "created_at": 1787356800000,
  "export_schema_version": 1,
  "stores": {}
}
```

Canonical-JSON serialize and Encrypt the structured payload with
`EXPORT_KEY`, hash the raw blob, and upload it immutably. The signed manifest
includes the envelope identity, object hash/length, entry counts, and
software/schema versions. Restore verifies the manifest, blob authentication,
inner identity, and counts before writing anything to KV Store.

## Stable vault binding

```text
vault_binding_input =
  UTF8("txt:vault-binding:v1") || 0x00 ||
  u32be(len(vault_id)) || UTF-8(vault_id) ||
  u32be(len(owner_pk)) || UTF-8(owner_pk) ||
  u32be(len(db_prefix)) || UTF-8(db_prefix)

vault_binding_hash = SHA-512(vault_binding_input)
```

Fastly reads `vault_id`, `owner_pk`, `db_prefix`, and the hash from the same
`owner_control` entry. The encrypted credentials contain all three plaintext
values. After local decryption, the browser recomputes and constant-time
compares the hash before accepting bootstrap data. Fastly constructs every R2
path and every proof input from its stored values; it never asks the client to
supply an authoritative binding triple. This equality check is deliberately
not treated as a freshness or possession proof by itself — see the next
section for that.

## Possession proof

`vault_binding_hash` and the Firebase bearer token together prove *identity*
and that the caller once saw the decrypted credential payload; neither is
bound to the current request or requires holding any secret key material.
Every route whose abuse is not self-contained — `/v1/vault/commit`,
`PUT /v1/vault/books/{book_id}`, `POST /v1/r2-token`, `POST /v1/shares`,
`DELETE /v1/shares` — additionally requires a fresh, per-request signature
proving the caller currently holds the unwrapped P-521 signing private key,
i.e. that it completed a correct `user_root_key` unlock in this session, not
merely that it possesses a bearer token or a previously observed binding
triple. Reads (`/v1/keys`, `GET /v1/vault/*`) do not require it: they return
ciphertext only, so a bearer-token-only compromise cannot read plaintext
through them. Reading-state mutation (`PUT /v1/vault/reading/{book_id}`) does
not require it either, for the reason given in [architecture.md](architecture.md)
invariant 11: its damage is confined to one book's reading position/bookmarks
and is always repairable.

Fastly verifies the signature with `sign_public_key` from `owner_control` — a
public key, so this adds no new secret custody requirement for Fastly, unlike
a shared-secret HMAC would.

For proof version 1, the browser and Fastly construct these bytes exactly:

```text
UTF8("txt:possession-proof:v1") || 0x00 ||
UTF8(route_name) || 0x00 ||
u32be(len(owner_pk)) || UTF-8(owner_pk) ||
u32be(len(vault_id)) || UTF-8(vault_id) ||
u32be(len(db_prefix)) || UTF-8(db_prefix) ||
nonce_32 ||
U64BE(expires_at_unix_seconds)
```

`route_name` is one of `r2-token`, `vault-commit`, `vault-book-put`,
`share-create`, `share-delete` — fixed short ASCII strings — so a signature
minted for one route can never authorize another. `nonce_32` is 32 bytes
(256 bits) from a cryptographic RNG, unique per proof. `expires_at` is at most
60 seconds after Fastly's current time. Fastly reconstructs the same bytes
using **its own** configured/stored `owner_pk`, `vault_id`, and `db_prefix` —
never the client-supplied copies — so a forged binding cannot be smuggled in
through the signed message.

The browser signs with:

```js
crypto.subtle.sign({ name: "ECDSA", hash: "SHA-512" }, privateKey, canonicalProof);
```

raw IEEE P1363 `r || s`, 66 bytes each, 132 bytes total, not ASN.1 DER. Fastly
verifies with `sign_public_key` imported as P-521 SPKI, checks `expires_at`
against current time, and then — to prevent exact replay inside the validity
window — attempts a create-only write of a `kind: "nonce"` entry keyed by
`nonce_32` in `rate_limit_control`, with a TTL just past `expires_at`. If that
create fails because the nonce already exists, the proof is rejected as a
replay regardless of whether the signature itself still verifies.

KV Store is eventually consistent for reads but evaluates every conditional
and create-only write against the entry's true current state, so this
create-only nonce write is the operative anti-replay check — not a read
Fastly performs beforehand. Validate that write-time guarantee in staging
before cutover, since the proof's entire replay defense rests on it; the
proof's own short (≤60 second) expiry window bounds the exposure of any gap
between that assumption and reality.

A missing, malformed, expired, wrong-route, replayed, or invalid-signature
proof on a route that requires one is `401 unauthorized`, not `403`, so it is
indistinguishable at the HTTP layer from a missing Firebase token — never
reveal which check failed beyond the shared error contract in
[auth_api.md](auth_api.md).

## Firebase and KV Store access

Firebase authenticates the owner to Fastly; it is neither an encryption key
nor a KV Store credential. Fastly validates the Firebase JWT as specified in
[auth_api.md](auth_api.md), then reads or writes the fixed KV Store entry
through its native resource binding — there is no request to sign and no
credential to construct, unlike the R2 access this design still brokers with
short-lived credentials.

This design issues no owner ticket. The possession proof above is a
per-request signature, not a session artifact, and Fastly never mints or
stores one on the caller's behalf.

## Shared content

Owner EPUBs and independent shared EPUB copies use the canonical blob procedure
and their independent content keys exactly as defined in
[docs/crypto.md](../crypto.md). A shared EPUB always has a fresh 128-byte
`share_content_key`; never reuse or wrap the owner's `txt_key` for a recipient.

## Share grants

Share grants use the XChaCha20-Poly1305 capability format. This is an
explicit exception to the canonical owner-content blob format: a grant
encrypts only an exact R2 object path for the API and never encrypts EPUB
bytes, book records, snapshots, or exports.

Let `id_hash = SHA-256(raw_share_id)`. For every freshly minted grant, Fastly:

1. generates a random 32-byte salt and random 24-byte XChaCha20 nonce (the
   nonce is exempt from the 256-bit floor stated at the top of
   [data_model.md](data_model.md): XChaCha20's extended nonce is fixed at 24
   bytes by construction, and 192 bits of random nonce space is not a
   collision concern for this cipher);
2. derives a per-grant key from the independent 32-byte `SHARE_GRANT_KEY` using
   HKDF-SHA-256 with the salt and
   `info = "txt:share-grant-key:v1" || id_hash`;
3. encrypts the normalized exact R2 object path with XChaCha20-Poly1305 and
   associated data `"txt:share-grant:v1" || id_hash`; and
4. returns the canonical unpadded base64url encoding of:

```text
0x01 || salt_32 || nonce_24 || XChaCha20-Poly1305(ciphertext || tag)
```

Decryption requires the same raw share ID, so a grant cannot be replayed for a
different capability. Fastly re-hashes the decrypted normalized path and
requires equality with the active `share_control` entry's `object_path_hash`
before signing an exact-object R2 URL. A deleting, absent, malformed, or
mismatched share never produces a URL.

Only Fastly and the offline recovery environment hold `SHARE_GRANT_KEY`. A new
grant for the same active share uses fresh salt and nonce. Key rotation uses a
versioned read keyring while new grants use only the current write key.

Use a libsodium-compatible XChaCha20-Poly1305 implementation. Do not substitute
the 12-byte-nonce ChaCha20-Poly1305 variant. Reject an unknown version byte,
noncanonical base64url, wrong salt/nonce/tag length, failed associated-data
check, invalid normalized path, or an encoded grant over 512 bytes.

Share URLs keep the `share_id`, grant, and `share_content_key` in the URL
fragment. Logs, analytics, referrers, API bodies, and KV Store entries must
never receive the content key. The owner may send the raw share ID and
encrypted grant only to the bounded share endpoints defined in
[auth_api.md](auth_api.md).

## Randomness and encoding

- Use only browser or operating-system cryptographic RNGs.
- Generate book IDs, possession-proof nonces, and every other opaque
  identifier with at least 256 bits of entropy — see the floor stated at the
  top of [data_model.md](data_model.md).
- Continue using 32-byte random share IDs, prefixes, and paths.
- Use canonical unpadded base64url at JSON/API boundaries.
- Constant-time compare fixed-length hashes, bindings, and tags where the
  runtime exposes a safe primitive.
- Pin canonical blob, JSON, compression, Firebase-claim, possession-proof, and
  grant versions in cross-runtime test vectors.
