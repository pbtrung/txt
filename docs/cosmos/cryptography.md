# Cryptography and record validation

[The project cryptography contract](../crypto.md) is authoritative for every
primitive, key size, blob byte layout, version rule, Encrypt/Decrypt step, and
failure behavior used by the Cosmos target. This document defines only how
Cosmos records and R2 projections use that existing contract. It does not
define a second encryption format.

In particular, the Cosmos target uses the canonical versioned authenticated
blob based on Ascon-Keccak AEAD and HKDF-SHA3-512. It does **not** use SQLCipher
value-level-encryption functions or encrypted virtual tables.

## Encryption map

| Stored value                                     | Cosmos target encryption                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `vault` book aggregate                           | Canonical structured-payload blob from [docs/crypto.md](../crypto.md), using `vault_master_key` as IKM |
| R2 library snapshot                              | Canonical structured-payload blob using `vault_master_key` as IKM                                      |
| R2 administrative Cosmos export                  | Canonical structured-payload blob using independent `COSMOS_EXPORT_KEY` as IKM                         |
| Wrapped UMK/KEM keys and encrypted credentials   | Existing wrapping/blob procedures in [docs/crypto.md](../crypto.md)                                    |
| Owner EPUB and independently encrypted share     | Existing canonical blob with the per-object content key                                                |
| Cosmos routing, version, and `catalog-head` data | Plaintext operational metadata protected by authorization and transport; no catalog text               |

The remote SQLCipher `db_path` is removed, so SQLCipher page encryption no
longer protects owner data at rest. Each book aggregate and catalog snapshot is
instead an independent canonical authenticated blob. Cosmos encryption at rest
remains a separate infrastructure control and never replaces client-side blob
encryption.

## Key hierarchy

- `user_root_key` exists only in the local unlock file and browser/CLI memory.
- The wrapped user master key, wrapped composite KEM private key, and encrypted
  credential payload remain in server-only `owner_control` and are returned
  through authenticated `/v1/keys`.
- The existing 256-byte `db_master_key` is preserved byte-for-byte and renamed
  `vault_master_key`. It is the IKM for encrypted book records and catalog
  snapshots; do not truncate or reinterpret it.
- Every EPUB retains its independent 128-byte `txt_key`.
- Every public share retains its independent 128-byte `share_content_key` and
  independently encrypted R2 object.
- Fastly and Cosmos receive only wrapped keys, encrypted payloads, hashes, and
  operational metadata. They never receive plaintext root, vault, content, or
  share keys.

Release plaintext key buffers on lock/logout as far as the runtime permits.
Keys, decrypted payloads, Firebase tokens, and signed requests must not enter
logs, analytics, metrics, or crash reports.

## Canonical blob usage

Call the exact Encrypt and Decrypt procedures from [docs/crypto.md](../crypto.md)
without changing their header, salt, HKDF inputs, AEAD parameters, tag, or
version handling. Structured JSON is Brotli-compressed by that procedure before
encryption. Store the resulting blob:

- as canonical unpadded base64url in a Cosmos JSON `ciphertext` field; or
- as the raw blob bytes in an immutable R2 object.

Never prepend another private header, remove the canonical header, truncate the
tag, substitute a SQLCipher envelope, or feed a precompressed structured JSON
payload into a path that would compress it a second time.

The canonical blob format has no caller-supplied associated-data context. Its
HKDF `info` is empty and its AEAD additional data is the stored blob header,
exactly as documented in [docs/crypto.md](../crypto.md). Therefore a valid blob
is not cryptographically tied to a Cosmos container, partition, item ID, kind,
or R2 object key. The application must enforce those bindings with authenticated
inner envelope fields and strict comparisons after decryption.

## Book payload envelope

Before Encrypt, serialize this object as canonical JSON UTF-8:

```json
{
  "purpose": "txt:cosmos-book",
  "envelope_version": 1,
  "container_role": "vault",
  "owner_pk": "own_opaqueRandomValue",
  "item_id": "book_K7c3...",
  "kind": "book",
  "record": {
    "schema_version": 1,
    "record_version": 37,
    "book_id": "book_K7c3..."
  }
}
```

`record` is the complete decrypted book aggregate defined in
[data_model.md](data_model.md), not only the abbreviated fields shown above.
Encrypt the canonical bytes with `vault_master_key` via the structured-payload
Encrypt procedure, then store its unpadded base64url encoding in `ciphertext`.

After Decrypt, reject the entire item unless:

- `purpose` and `envelope_version` are exactly supported;
- `container_role`, `owner_pk`, `item_id`, and `kind` equal the trusted outer
  route/item values;
- `record.book_id` equals both `item_id` and the outer item ID;
- inner and outer schema/record versions agree; and
- canonical JSON parsing, duplicate-key rejection, and the full record schema
  all succeed.

These comparisons detect a blob copied to another row after it is decrypted;
the blob format itself does not prevent that copy. An authentication or binding
failure is a hard corruption/security error. Never return partial plaintext or
retry with a different key or legacy decoder on a target item.

## Library snapshot envelope

The library snapshot uses the same canonical structured-payload blob. Its
decrypted canonical JSON object is:

```json
{
  "purpose": "txt:cosmos-catalog",
  "envelope_version": 1,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "generation": 184,
  "object_key": "{db_prefix}/catalog/184-random.blob",
  "snapshot_schema_version": 1,
  "books": []
}
```

Publication performs this exact sequence:

1. choose `generation` and the immutable `object_key`;
2. build and canonical-JSON serialize the complete envelope;
3. Encrypt it as a structured payload with `vault_master_key` according to
   [docs/crypto.md](../crypto.md);
4. SHA-256 hash the resulting raw blob bytes; and
5. upload those bytes unchanged to the selected R2 key.

On load, compare object length and SHA-256 with `catalog-head` before Decrypt.
Then require all envelope identity fields to agree with the authenticated owner
bootstrap and head before accepting `books`. Validate the snapshot schema,
sort, unique IDs, count, and every projected record as defined in
[catalog.md](catalog.md).

Migration may decrypt the legacy SQLCipher database and historical R2 blobs
only inside the offline migration path. Every new book and snapshot is
immediately encrypted in the canonical blob format; target runtime routes never
fall back to a legacy decoder.

## Administrative export envelope

`COSMOS_EXPORT_KEY` is an independent 256-byte random IKM. It is never derived
from or reused as `vault_master_key`, a Cosmos key, an R2 key, or an application
HMAC key. The canonical export payload includes:

```json
{
  "purpose": "txt:cosmos-export",
  "envelope_version": 1,
  "export_id": "export_opaqueRandomValue",
  "object_key": "{db_prefix}/exports/1787356800000-random.blob",
  "created_at": 1787356800000,
  "export_schema_version": 1,
  "containers": {}
}
```

Canonical-JSON serialize and Encrypt the structured payload with
`COSMOS_EXPORT_KEY`, hash the raw blob, and upload it immutably. The signed
manifest includes the envelope identity, object hash/length, item counts, and
software/schema versions. Restore verifies the manifest, blob authentication,
inner identity, and counts before writing anything to Cosmos.

## Stable vault binding

The old credential binding included removed `db_path`. Protocol version 3 uses:

```text
vault_binding_input =
  "txt:vault-binding:v1\0" ||
  u32be(len(vault_id)) || UTF-8(vault_id) ||
  u32be(len(owner_pk)) || UTF-8(owner_pk) ||
  u32be(len(db_prefix)) || UTF-8(db_prefix)

vault_binding_hash = SHA-512(vault_binding_input)
```

Fastly reads the hash from `owner_control`. The encrypted credentials contain
all three plaintext values. After local decryption, the browser recomputes and
constant-time compares the hash before accepting bootstrap data or requesting
R2 credentials. Fastly independently checks the supplied binding before
`/v1/r2-token` succeeds.

## Firebase and Cosmos authentication

Firebase authenticates the owner to Fastly; it is neither an encryption key nor
a Cosmos credential. Fastly validates the Firebase JWT as specified in
[auth_api.md](auth_api.md), then signs the exact allowlisted Cosmos REST request
with HMAC-SHA-256 and the account key in Fastly Secret Store. That signature is
never returned to the browser.

Protocol version 3 issues no owner ticket or Cosmos resource token. Legacy
P-521 proof/ticket handling from [docs/crypto.md](../crypto.md) remains relevant
only to rollback endpoints during their retention window and must not authorize
a Fastly target route.

## Shared content

Owner EPUBs and independent shared EPUB copies use the canonical blob procedure
and their independent content keys exactly as defined in
[docs/crypto.md](../crypto.md). A shared EPUB always has a fresh 128-byte
`share_content_key`; never reuse or wrap the owner's `txt_key` for a recipient.

## Share grants

Share grants preserve the existing XChaCha20-Poly1305 capability format. This
is an explicit exception to the canonical owner-content blob format: a grant
encrypts only an exact R2 object path for the API and never encrypts EPUB bytes,
book records, snapshots, or exports.

Let `id_hash = SHA-256(raw_share_id)`. For every freshly minted grant, Fastly:

1. generates a random 32-byte salt and random 24-byte XChaCha20 nonce;
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
requires equality with the active `share_control.object_path_hash` before
signing an exact-object R2 URL. A deleting, absent, malformed, or mismatched
share never produces a URL.

Only Fastly and the offline recovery environment hold `SHARE_GRANT_KEY`. Keep
the current envelope byte format and grant decoder so existing distributed
links continue to work. A new grant for the same active share uses fresh salt
and nonce. Key rotation uses a versioned read keyring while new grants use only
the current write key.

Use a libsodium-compatible XChaCha20-Poly1305 implementation. Do not substitute
the 12-byte-nonce ChaCha20-Poly1305 variant. Reject an unknown version byte,
noncanonical base64url, wrong salt/nonce/tag length, failed associated-data
check, invalid normalized path, or an encoded grant over 512 bytes.

Share URLs keep the `share_id`, grant, and `share_content_key` in the URL
fragment. Logs, analytics, referrers, API bodies, and Cosmos records must never
receive the content key. The owner may send the raw share ID and encrypted grant
only to the bounded share endpoints defined in [auth_api.md](auth_api.md).

## Randomness and encoding

- Use only browser or operating-system cryptographic RNGs.
- Generate Cosmos IDs with at least 128 bits of entropy.
- Continue using 32-byte random share IDs, prefixes, and paths.
- Use canonical unpadded base64url at JSON/API boundaries.
- Constant-time compare fixed-length hashes, bindings, and tags where the
  runtime exposes a safe primitive.
- Pin canonical blob, JSON, compression, Firebase-claim, Cosmos-signing, and
  grant versions in cross-runtime test vectors.
