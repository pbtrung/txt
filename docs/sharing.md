# Sharing — Design

Only the account whose Firebase uid equals the Worker's trusted `ADMIN_UID` can create or delete a public share. Sharing re-encrypts one document under an independent content key and registers an opaque capability in a small D1 registry so an anonymous reader can fetch and decrypt it without ever authenticating, touching Turso, or receiving R2 credentials. Normal share deletion goes through the trusted Worker and its D1 registry; D1 is trusted for authorization integrity and deletion ordering, but receives no plaintext object paths or content keys.

---

## 1. Worker configuration

| name | purpose |
|---|---|
| `SHARE_GRANT_KEY` | standard padded base64 encoding of exactly 32 random bytes; AES-256-GCM key for opaque shared-object grants |
| `SHARE_REGISTRY` | D1 binding containing 32-byte capability/path hash BLOBs for live shares; it never stores a raw capability or object path |
| `SHARE_RATE_LIMITER` | native Workers rate-limit binding for anonymous shared-content requests; configured in `wrangler.jsonc` at 120 requests per source address per minute per Cloudflare location |

`SHARE_GRANT_KEY` is independent from `R2_TICKET_SECRET`, R2 credentials, and all user keys (docs/auth.md §1). Grants do not carry a key identifier, so replacing this secret immediately invalidates every existing share URL. After rotation, copy and distribute new URLs; uninterrupted rotation would require multi-key verification, which is not implemented. Apply `worker/migrations/0001_share_registry.sql` to the configured `SHARE_REGISTRY` binding before enabling shares.

---

## 2. Schema

The owner-side `txt_shares` table (docs/data_model.md §2) records one row per share: its 32-byte `share_id`, its independent 128-byte `share_content_key`, its `share_prefix`/`share_path` object-key segments, and a `creating`/`active`/`deleting` lifecycle state. The D1 `SHARE_REGISTRY` binding (`worker/migrations/0001_share_registry.sql`) is a separate, minimal registry: `share_id_hash` and `object_path_hash`, each a 32-byte `SHA-256` BLOB, plus a creation timestamp. It never stores a raw capability, object path, or content key.

---

## 3. Endpoints

The administrator endpoints use a Firebase bearer token and accept the same path-bound body:

```json
{
  "db_path": "<administrator database path>",
  "db_prefix": "<administrator content prefix>",
  "share_prefix": "<52-character shared-object segment>",
  "share_path": "<52-character shared-object segment>",
  "share_id": "<standard-base64 32 random bytes>"
}
```

`POST /v1/share-grant` validates the Firebase uid against `ADMIN_UID`, verifies the `db_path`/`db_prefix` binding through the administrator's control record, inserts the capability/path hashes into D1 when absent, and returns `{ "grant": "<base64url envelope>" }`. Re-registering the same id and path is idempotent; reusing an id for a different path returns 409.

`DELETE /v1/share` performs the same identity and path checks, rejects a registered id/path mismatch, deletes the exact R2 object with the Worker's parent credential, and then deletes the D1 row. A missing R2 object is treated as already deleted. The success response is 204.

`POST /v1/shared-content` is anonymous. It accepts `{ "share_id": "<base64url id>", "grant": "<base64url envelope>" }`, requires a matching live D1 row, authenticates and decrypts the object path, fetches the ciphertext with the Worker's parent credential, and streams it without caching. It never receives the fragment's content key.

The endpoint accepts at most 1 KiB of JSON, requires canonical base64url with exactly 32 decoded capability bytes and 226 decoded grant bytes, and applies the `SHARE_RATE_LIMITER` budget before its D1 lookup. Cloudflare's native counter is a permissive abuse control local to each edge location, not an accounting or authorization mechanism.

---

## 4. Grant cryptography

Public-share grants are a separate Worker-side envelope because the Worker does not load the leancrypto WASM used by user-data blobs (docs/crypto.md). The Worker decodes the dedicated 32-byte `SHARE_GRANT_KEY`, generates an independent 32-byte salt and 12-byte nonce, and derives a separate AES-256-GCM key for every grant:

```text
id_hash   = SHA-256(raw 32-byte share_id)
grant_key = HKDF-SHA-256(
  IKM  = SHARE_GRANT_KEY,
  salt = random salt_32,
  info = UTF8("txt:share-grant-key:v1") || id_hash,
  len  = 32
)
plaintext = UTF8(exact shared-object path)
AAD       = UTF8("txt:share-grant:v1") || id_hash
grant     = 0x01 || salt_32 || nonce_12 || AES-GCM-ciphertext-and-tag
```

Salt and nonce are public, independently generated, and carried inside the grant; neither is reused as the other. The per-grant derivation isolates grants and makes a nonce collision across different salts harmless. The grant is base64url encoded without padding. On decryption the Worker validates the path grammar and requires `SHA-256(path)` to equal the D1 row's registered 32-byte BLOB. D1 therefore authorizes anonymous reads without learning the path, while cross-capability substitution and database row substitution fail authentication or the path-hash comparison. The EPUB continues to use the standard Ascon-Keccak blob format and its independent 128-byte `share_content_key`.

---

## 5. End-to-end flow

Only a Firebase identity equal to `ADMIN_UID` may call `POST /v1/share-grant` or `DELETE /v1/share`. Grant creation validates the administrator's `db_path`/`db_prefix` binding, computes `SHA-256(share_id)` and `SHA-256(object_path)`, stores both 32-byte hashes as BLOBs in D1, and returns an encrypted-path grant. Registering an existing share id is idempotent only when its path hash matches. The browser generates a grant when it copies a share URL; the complete URL is never stored in SQLCipher, D1, Turso, or R2.

The returned grant derives a per-grant AES-256-GCM key from `SHARE_GRANT_KEY`, a random 32-byte salt, and the capability hash using HKDF-SHA-256, then encrypts the exact object path with an independent random 12-byte nonce. Associated data is `UTF8("txt:share-grant:v1") || SHA-256(share_id)`, preventing a grant from being moved to another capability. The URL fragment carries the raw 32-byte share id, opaque grant, and content key, so none appears in the initial navigation request.

An anonymous reader posts the id and grant to `POST /v1/shared-content`. The Worker requires the corresponding D1 row, decrypts and validates the path, compares its SHA-256 hash with the registered BLOB, fetches the encrypted object using the server-held R2 credential, and streams it with `Cache-Control: no-store`. Anonymous clients never receive R2 credentials. The Worker never receives the fragment's content key; decryption remains in the browser.

Deletion sends the bound object path to the trusted Worker, which validates the administrator and path binding, deletes the R2 object with its server-held credential, and only then removes the D1 row. The browser removes the owner's SQLCipher row only after the Worker succeeds. A failed object deletion therefore remains visible and retryable, while a stale or rolled-back R2 object cannot be read after the registry row is gone. A request authorized before deletion may finish, just as a viewer may retain plaintext already downloaded. Because deletion leaves no tombstone, the same random share id can be registered again; clients generate a fresh 32-byte id for every new share. Since the share URL fragment is itself a bearer capability, it can persist in a recipient's browser history or clipboard after a share is deleted; only the registry-backed fetch is actually revoked, not copies already saved by a viewer.

---

## 6. Client behavior

Only the account whose Firebase uid equals the Worker's trusted `ADMIN_UID` can create or delete shares. Creation generates a 32-byte `share_id`, a fresh 128-byte `share_content_key`, and independent 32-byte `share_prefix` and `share_path` values. The browser decrypts the owner object locally, re-encrypts the EPUB under `share_content_key`, and uploads it immutably with `If-None-Match: *` to `{db_prefix}/shared/{share_prefix}/{share_path}`.

The `creating` state is committed before upload and a completed upload becomes `active`. Copying the URL registers the share in D1. Deletion changes the local row to `deleting`; the Worker validates the bound path, deletes the R2 object, removes the D1 row, and then the browser removes the local row. Share registration, deletion, and anonymous content transfer use bounded request timeouts and retry only network failures; content transfer remains covered until the response body has been consumed. A failed Worker deletion leaves the local entry retryable. There is no revoked state, registry tombstone, or `object_etag`: share paths are immutable, never reused, and deletion is unconditional. `ON DELETE RESTRICT` prevents deleting the source book before its shares are removed.

`--clean-bucket` never deletes objects below a reachable account's `{db_prefix}/shared/` namespace. Only the authenticated Worker deletion flow may remove them: the generic cleaner cannot establish that a shared object is absent from D1, and an R2 rollback could hide an otherwise-live `txt_shares` row from its allowlist scan.

The Library exposes Shares below Recent only for the administrator. Shares shows the source book's normal row metadata with Copy and Delete actions. Browse/All Books adds a Share action beside search; selecting books creates independent shares. Copy asks the Worker to register the live D1 row and creates a fresh opaque grant; the resulting URL is returned to the clipboard and is not stored. Its fragment contains the random share capability, opaque encrypted-path grant, and client-side decryption key. D1 stores only 32-byte SHA-256 capability and object-path BLOBs plus the creation timestamp; deleting a share removes that row. Anonymous reading state and bookmarks remain browser-local under a local-storage key containing the base64url share id and never mutate the owner's `db_path`. EPUB scripts are disabled, and the sandboxed section frames inherit a CSP that permits only same-origin, `blob:`, and `data:` styles, images, fonts, media, and nested frames, preventing remote resource beacons embedded in a book.
