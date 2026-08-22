# Cryptography and record binding

This design preserves the existing root-key, user-master-key, KEM, P-521,
content-key, share-key, HKDF-SHA3-512, and authenticated blob primitives. It
changes storage granularity and binding, not the user's root of trust.

## Where value encryption is used

| Stored value | Encryption in the Cosmos target |
| --- | --- |
| `vault` book aggregate | SQLCipher VLE over canonical JSON BLOB with row context |
| R2 library snapshot | Brotli first, then SQLCipher VLE over the compressed BLOB with snapshot context |
| R2 administrative Cosmos export | Brotli first, then SQLCipher VLE with the independent export key and export-specific context |
| Wrapped UMK/KEM/signing keys and encrypted owner credentials | Existing key-wrap/blob procedures; returned only through authenticated Northflank bootstrap |
| Owner EPUB and independent shared EPUB | Existing versioned authenticated blob format with per-object content key |
| Cosmos `catalog-head` and routing/version fields | Plaintext operational metadata protected by Cosmos authorization/transport; no user catalog text |

SQLCipher page encryption no longer protects a remote `db_path`, because that
file is removed. VLE is the mandatory end-to-end encryption boundary for each
Cosmos book record and catalog snapshot. Cosmos encryption at rest remains a
separate infrastructure control and never replaces VLE.

## Key hierarchy

- `user_root_key` exists only in the local unlock file and browser memory.
- The wrapped user master key, wrapped KEM private key, wrapped P-521 signing
  private key, and encrypted credential payload are stored in server-only
  `owner_control` and returned through authenticated `/v1/keys`.
- The existing 256-byte `db_master_key` is preserved byte-for-byte and renamed
  `vault_master_key`. It encrypts Cosmos book values and derived library
  snapshots. Do not truncate it; it exceeds the SQLCipher VLE minimum key size.
- Every EPUB retains its independent 128-byte `txt_key`.
- Every public share retains its independent 128-byte `share_content_key` and
  independently encrypted R2 object.
- Northflank stores only public keys, wrapped keys, encrypted payloads, hashes,
  and server secrets. It never receives plaintext owner, vault, content, or
  share keys.

The browser must zero or release plaintext key buffers on lock/logout as far as
the runtime permits. Key material, VLE plaintext, and signed requests must not
be logged or included in crash reporting.

## Cosmos value encryption

Use the SQLCipher WASM value-level encryption functions already shipped by the
project:

```sql
sqlcipher_vle_encrypt(value, vault_master_key, context)
sqlcipher_vle_decrypt(ciphertext, vault_master_key, context)
```

The browser and CLI invoke these through prepared statements on an in-memory
SQLCipher WASM connection, binding all three arguments as BLOB parameters:

```sql
SELECT sqlcipher_vle_encrypt(?1, ?2, ?3);
SELECT sqlcipher_vle_decrypt(?1, ?2, ?3);
```

For Cosmos operations, pass the key explicitly on every call. Do not set a
connection-wide default with `sqlcipher_vle_key`, interpolate key bytes into
SQL text, or use the low-level cipher/KDF/HMAC functions to assemble a custom
envelope. Close the in-memory connection and release its bound buffers on
lock/logout. The 256-byte `vault_master_key` satisfies VLE's 128-byte minimum.

Serialize the book plaintext as RFC 8785 canonical JSON UTF-8 before passing it
as a BLOB to `sqlcipher_vle_encrypt`. Store the returned envelope verbatim as
base64url in the Cosmos `ciphertext` field. Decryption must return a BLOB,
canonical JSON must parse with duplicate-key rejection, and all outer/inner
identity and version fields must match before data is used.

Never call VLE with an empty context for a Cosmos value. Build context bytes as
an unambiguous tuple:

```text
"txt:cosmos-row:v1\0"
u32be(len(container_id)) || UTF-8(container_id)
u32be(len(owner_pk))     || UTF-8(owner_pk)
u32be(len(item_id))      || UTF-8(item_id)
u32be(len(kind))         || UTF-8(kind)
u32be(schema_version)
```

For the current book format, `container_id` is the configured vault container,
`item_id` is the book ID, and `kind` is `book`. Binding container, partition,
ID, kind, and schema prevents a valid ciphertext from being spliced into
another item or reinterpreted under another schema. A context mismatch or any
authentication error is a hard corruption/security failure; do not return
partial plaintext or retry with an empty/legacy context.

`record_version` is authenticated inside the ciphertext and mirrored outside
for diagnostics. VLE prevents undetected modification and cross-row movement,
but it does not prevent deletion or rollback to an older valid ciphertext by a
principal with write permission. Cosmos backups, `_etag` concurrency, audit
telemetry, and encrypted exports address availability and recovery.

### Encrypted virtual tables

SQLCipher encrypted virtual tables are not a remote Cosmos storage adapter and
must not be treated as one. They bind cells to local SQL table/column/row
identity and are useful only if the browser or migration CLI retains a
temporary local SQLite representation. Cosmos persistence always uses the VLE
record envelope and context above. No SQLCipher database file is mounted on
Northflank in the target architecture.

If a temporary encrypted virtual table is used, initialize its connection key
with `sqlcipher_vle_key` before the first row access and rely on the module's
table/column/rowid associated-data binding. Never copy its backing ciphertext
cells into Cosmos: their context is local-table identity, not the Cosmos
container/partition/item tuple.

## Library snapshot encryption

The snapshot is a JSON array as defined in [catalog.md](catalog.md). Publication
uses this exact order:

1. serialize the array as RFC 8785 canonical JSON UTF-8;
2. Brotli-compress it with the pinned cross-platform project settings;
3. encrypt the compressed bytes with `sqlcipher_vle_encrypt`, the complete
   `vault_master_key`, and the snapshot context below;
4. hash the resulting ciphertext with SHA-256; and
5. upload the ciphertext bytes unchanged to the immutable R2 object key.

Snapshot context is:

```text
"txt:catalog-snapshot:v1\0"
u32be(len(vault_id))  || UTF-8(vault_id)
u32be(len(owner_pk))  || UTF-8(owner_pk)
u64be(generation)
u32be(len(object_key)) || UTF-8(object_key)
u32be(snapshot_schema_version)
```

The object key and generation are selected before encryption. On load, compare
the downloaded ciphertext length and SHA-256 with `catalog-head` before VLE
decryption, then validate the context and JSON schema. An object copied to a
different key, generation, owner, or vault fails authentication.

Do not apply the legacy blob format with an empty context to new snapshots.
Migration may decrypt legacy objects with their historical format only inside
the one-off migration path; it must immediately re-encrypt them with the new
context.

## Administrative export encryption

`COSMOS_EXPORT_KEY` is an independent 256-byte random key, satisfying the same
VLE minimum without reusing `vault_master_key` or a server HMAC key. Serialize
and Brotli-compress the canonical export, then encrypt it as a BLOB with:

```text
"txt:cosmos-export:v1\0"
u32be(len(export_id))  || UTF-8(export_id)
u32be(len(object_key)) || UTF-8(object_key)
u64be(created_at_unix_ms)
u32be(export_schema_version)
```

Choose all context fields before encryption and include them in the signed
export manifest. Restore verifies the manifest, object ciphertext hash, exact
context, VLE authentication, and internal item counts before writing anything
to Cosmos.

## Stable vault binding

The old proof and credential binding included `db_path`, which no longer
exists. Protocol version 3 uses a stable vault binding:

```text
vault_binding_input =
  "txt:vault-binding:v1\0" ||
  u32be(len(vault_id)) || UTF-8(vault_id) ||
  u32be(len(owner_pk)) || UTF-8(owner_pk) ||
  u32be(len(db_prefix)) || UTF-8(db_prefix)

vault_binding_hash = SHA-512(vault_binding_input)
```

Northflank stores the hash in `owner_control`. The encrypted credentials contain
all three plaintext values. After local decryption, the browser recomputes and
constant-time compares the hash before requesting data credentials.

## Owner ticket

`/v1/keys` returns an authenticated, opaque version-3 owner ticket using the
existing ticket primitive and `R2_TICKET_SECRET`. Its authenticated claims are:

```json
{
  "version": 3,
  "purpose": "owner-data-session",
  "firebase_uid": "owner uid",
  "user_handle_hash": "base64url",
  "vault_binding_hash": "base64url",
  "ticket_id": "base64url 32 random bytes",
  "issued_at": 1787356800,
  "expires_at": 1787443200
}
```

The default lifetime remains 24 hours. The ticket is authorization state, not
an encryption key. The client keeps it in memory and must reauthenticate with
Firebase after expiry.

## P-521 proof for data credentials

For each `/v1/data-token` request, the browser creates a fresh 32-byte random
`nonce` and includes `requested_at` as Unix seconds. It signs the SHA-512 digest
of this canonical message with the locally unwrapped P-521 private key:

```text
"txt:data-token-proof:v3\0"
u32be(len(ticket_id))         || ticket_id bytes
u32be(len(user_handle))       || user_handle bytes
u32be(len(vault_id))          || UTF-8(vault_id)
u32be(len(owner_pk))          || UTF-8(owner_pk)
u32be(len(db_prefix))         || UTF-8(db_prefix)
u64be(requested_at)
u32be(len(nonce))             || nonce bytes
```

Northflank must:

1. authenticate and validate the ticket and purpose;
2. require `requested_at` within 120 seconds of server time;
3. recompute and compare user-handle and vault-binding hashes;
4. verify the P-521 signature using the `owner_control` public key;
5. create a server-only, TTL-backed replay marker for
   `(ticket_id, SHA-256(nonce))` using create-only semantics; and
6. mint credentials only if all checks succeed.

A duplicate replay marker is a failed authorization, not an idempotent token
response. Replay markers may live in `rate_limit_control` under a dedicated
`proof-replay` partition and expire after five minutes.

The version-2 proof that binds `db_path` must not authorize target Cosmos or R2
credentials. During cutover, version 2 is accepted only by the explicitly
legacy endpoint and is disabled when rollback data becomes read-only.

## Share grants

The current XChaCha20-Poly1305 share-grant format and `SHARE_GRANT_KEY` remain.
The authenticated payload binds the raw share ID to one normalized exact R2
object key. As today, `share_control` stores only SHA-256 hashes of those
high-entropy values. A fresh
grant may be issued idempotently for an active owner share; a deleting or
absent share never receives one.

Share URLs must keep decryption secrets in the URL fragment. Server logs,
analytics, referrers, and API bodies must not receive the share content key.

## Randomness and encoding

- Use the browser or operating system cryptographic RNG only.
- Generate new opaque Cosmos IDs with at least 128 bits of entropy.
- Continue using 32-byte random share IDs, prefixes, paths, and proof nonces.
- Use unpadded base64url at JSON/API boundaries and reject non-canonical input.
- Compare hashes, binding values, tags, and fixed-length identifiers in
  constant time where the runtime exposes a safe primitive.
- Pin serialization, compression, VLE envelope, and proof versions in test
  vectors shared by the browser, CLI, and Northflank verifier.
