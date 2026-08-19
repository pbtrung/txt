# Auth — Design

Firebase authenticates the browser once at `POST /v1/keys`. That response returns the user's wrapped key material and a Worker-signed, 24-hour R2 binding ticket. The browser decrypts its `user_handle`, storage paths, and P-521 private key locally. It then renews short-lived R2 credentials through `POST /v1/r2-token` using the ticket and a fresh P-521 proof, without sending another Firebase token or querying Turso.

The ticket is an integrity-protected certificate, not a bearer credential. It binds the Firebase-provisioned account to the hash of the user's decrypted handle, its signing public key, and its authorized path-pair hash. A caller must possess both the decrypted handle and the matching P-521 private key to use it.

The Worker mints one read-write credential for the exact `db_path` object. An ordinary account receives read-only scope for `{db_prefix}/*`; the configured administrator receives read-write scope so the browser can upload immutable objects under `{db_prefix}/shared/*`. Normal share deletion goes through the trusted Worker and its D1 registry. The Worker never creates users or storage prefixes; an administrator provisions both out of band.

---

## 1. Worker configuration and secrets

There is one Turso control database, `ctl` (§2). User data lives as encrypted objects in R2 (docs/data_model.md).

| name | purpose |
|---|---|
| `CTL_DB_URL` | control database URL |
| `CTL_DB_TOKEN` | non-expiring, read-only token for `ctl` |
| `FIREBASE_PROJECT_ID` | expected Firebase token issuer and audience for `/v1/keys` |
| `ADMIN_UID` | the one Firebase uid authorized as administrator; this trusted value, not Turso's mutable `users.type`, controls elevated R2 scope and sharing |
| `R2_TICKET_SECRET` | standard padded base64 encoding of at least 32 random bytes, used only to sign and verify R2 binding tickets |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION` | R2 destination returned with temporary credentials |
| `R2_READ_WRITE_ACCESS_KEY_ID` / `R2_READ_WRITE_SECRET_ACCESS_KEY` | parent credential used to sign path-limited temporary R2 credentials and to fetch/delete exact shared objects inside the Worker |
| `SHARE_GRANT_KEY` | standard padded base64 encoding of exactly 32 random bytes; AES-256-GCM key for opaque shared-object grants |
| `SHARE_REGISTRY` | D1 binding containing 32-byte capability/path hash BLOBs for live shares; it never stores a raw capability or object path |
| `SHARE_RATE_LIMITER` | native Workers rate-limit binding for anonymous shared-content requests; configured in `wrangler.jsonc` at 120 requests per source address per minute per Cloudflare location |

`R2_TICKET_SECRET` must not reuse the R2 secret access key. All Worker instances use the same ticket secret. Rotating it invalidates every outstanding ticket and is an emergency global response, not routine per-user revocation.

`SHARE_GRANT_KEY` is independent from `R2_TICKET_SECRET`, R2 credentials, and all user keys. Grants do not carry a key identifier, so replacing this secret immediately invalidates every existing share URL. After rotation, copy and distribute new URLs; uninterrupted rotation would require multi-key verification, which is not implemented. D1 is trusted for authorization integrity and deletion ordering, but receives no plaintext object paths or content keys. Apply `worker/migrations/0001_share_registry.sql` to the configured `SHARE_REGISTRY` binding before enabling shares.

The Worker Turso token is read-only. A leaked Worker database token can expose ciphertext and control metadata, but cannot alter or delete rows.

---

## 2. Control database

`ctl` holds identity, wrapped key material, the handle binding, and the storage-path binding:

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,       -- Firebase uid
  user_handle_hash BLOB NOT NULL CHECK (length(user_handle_hash) = 32),
  type            TEXT NOT NULL CHECK (type IN ('admin', 'user')),
  created_at      INTEGER NOT NULL,        -- unix ms
  db_binding_hash BLOB NOT NULL CHECK (length(db_binding_hash) = 64)
);
CREATE UNIQUE INDEX users_user_handle_hash_unique
ON users(user_handle_hash);

CREATE TABLE key_store (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  umk            BLOB NOT NULL,  -- wrapped by user_root_key
  pubkey         BLOB,           -- composite KEM public key; admin only
  privkey        BLOB,           -- wrapped composite KEM private key; admin only
  sign_version   INTEGER NOT NULL CHECK (sign_version = 1),
  sign_algorithm TEXT NOT NULL CHECK (sign_algorithm = 'ECDSA-P521-SHA512'),
  sign_pubkey    BLOB NOT NULL,  -- v1: P-521 SPKI DER
  sign_privkey   BLOB NOT NULL   -- v1: wrapped P-521 PKCS#8 DER
);

CREATE TABLE cred_store (
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  for_user_id TEXT NOT NULL REFERENCES users(id),
  content     BLOB NOT NULL,
  PRIMARY KEY (owner_id, for_user_id)
);
```

`user_handle` is 32 random bytes, but Turso never stores it in plaintext. Turso stores only `users.user_handle_hash = SHA-256(user_handle)`. The raw bytes are standard-base64 encoded as `cred_store.content.user_handle` before that JSON payload is encrypted under the owner's `umk`. The browser obtains the raw handle only by decrypting its credential store; the Worker obtains only the hash when creating a ticket.

`db_path` and `db_prefix` are independent 32-byte random values rendered as 52 lowercase base32-Crockford characters. `db_master_key` is 256 random bytes encoded as base64. Their plaintext forms live inside encrypted `cred_store.content`:

```json
{
  "user_handle": "<base64 32 bytes>",
  "display_name": "...",
  "db_master_key": "<base64 256 bytes>",
  "db_path": "<52-character token>",
  "db_prefix": "<52-character token>"
}
```

An ordinary user's administrator-owned backup contains the same fields plus:

```json
{
  "user_root_key": "<base64 256 bytes>"
}
```

That backup is encrypted under the administrator's `umk`. It lets an administrator run whole-control-plane migrations with only the administrator `creds.json`: the administrator decrypts the backup, obtains the user's root key, unwraps that user's `umk`, and verifies the self-owned credential payload. Neither a user's self-owned payload nor the administrator's own self-owned payload contains `user_root_key`.

`users.db_binding_hash` stores `SHA-512(UTF-8(db_path) || UTF-8(db_prefix))`. Both inputs have fixed validated lengths, so the concatenation is unambiguous. The ticket carries this digest rather than either raw path.

Signing-suite version 1 is `ECDSA-P521-SHA512`. `sign_pubkey` is SPKI DER. `sign_privkey` is PKCS#8 DER wrapped with the account's `umk` using docs/crypto.md. The signing-suite version is separate from the R2 proof protocol version.

The Worker's `/v1/keys` lookup is by Firebase uid:

```sql
SELECT u.type, u.user_handle_hash, u.db_binding_hash,
       k.umk, k.sign_version, k.sign_algorithm,
       k.sign_pubkey, k.sign_privkey, c.content
FROM users u
JOIN key_store k ON k.user_id = u.id
JOIN cred_store c ON c.owner_id = u.id AND c.for_user_id = u.id
WHERE u.id = ?;
```

`/v1/r2-token` does not query `ctl`; all fields it needs are authenticated by the signed ticket.

---

## 3. Provisioning

Firebase assigns the uid before provisioning. An administrator obtains that uid and runs `--init-admin` or `--init-user`. A valid Firebase account without a `users` row is authenticated but not provisioned, so `/v1/keys` returns 403.

Provisioning performs these idempotent operations:

1. Generate one 32-byte `user_handle`.
2. Generate `db_path` and `db_prefix` as independent 32-byte random values encoded as base32-Crockford.
3. Generate the 128-byte `umk` and 256-byte `db_master_key`.
4. Insert `users` with the Firebase uid, `SHA-256(user_handle)`, and `db_binding_hash`; do not store the raw handle in Turso.
5. Generate the version-1 P-521 key pair. Store its public key and wrap its private key with `umk`.
6. Encrypt the credential payload, including the same base64-encoded `user_handle`, into the account's self-owned `cred_store` row.
7. For an ordinary user, add that user's `user_root_key` to the administrator copy and encrypt it into the administrator-owned backup row. Do not add a root key to either self-owned row.

For an existing control database, re-run `--init-admin` once and `--init-user` for every ordinary account. Those idempotent provisioning commands add the current compatibility columns, install or verify each account's path binding and signing key, and ensure every administrator backup contains the ordinary user's `user_root_key`. Each `--init-user` run still requires that user's credentials file.

Then run `txt --update-ctl admin_creds.json --verbose --dry-run`, inspect the complete plan, and repeat without `--dry-run`. This command needs only the administrator credentials and administrator-owned backups. It adds `users.user_handle_hash` when absent, creates or verifies one raw handle in the encrypted self/admin payloads, stores its SHA-256 hash, and installs the unique index. It does not install signing keys or path bindings. A missing backup/root or any self/backup/hash mismatch aborts the run. Re-running every step is idempotent.

`--update-db` remains responsible only for schemas inside users' encrypted SQLCipher databases in R2; it never migrates the Turso control schema.

---

## 4. Endpoints

### 4.1 `POST /v1/keys`

```http
POST /v1/keys
Authorization: Bearer <Firebase ID token>
```

```json
{
  "type": "user",
  "uid": "<verified Firebase uid>",
  "umk": "<base64 ciphertext>",
  "signing": {
    "version": 1,
    "algorithm": "ECDSA-P521-SHA512",
    "private_key": "<base64 ciphertext>"
  },
  "cred_store": "<base64 ciphertext>",
  "r2_ticket": "<compact Worker-signed JWS>"
}
```

The Worker verifies the Firebase ID token, loads the account by the verified `sub`, and signs a ticket with `R2_TICKET_SECRET`. The compact JWS uses `HS256`, header `typ = JWT`, and these claims:

```json
{
  "v": 2,
  "aud": "r2-token",
  "sub": "<Firebase uid>",
  "account_type": "user",
  "jti": "<base64 32 random bytes>",
  "user_handle_hash": "<base64url SHA-256(raw user_handle)>",
  "sign_version": 1,
  "sign_algorithm": "ECDSA-P521-SHA512",
  "sign_public_key": "<base64url SPKI DER>",
  "db_binding_hash": "<base64url SHA-512(path pair)>",
  "iat": 0,
  "exp": 0
}
```

`exp` is exactly 24 hours after `iat`. The ticket is returned outside `cred_store` because it does not contain plaintext handles, paths, or private keys. The client keeps it only in memory and discards it when the vault locks. The Worker derives `account_type` from `sub === ADMIN_UID`; it never copies the authorization role from Turso.

| status | condition |
|---|---|
| 200 | wrapped key material and ticket returned |
| 401 | Firebase token missing or invalid |
| 403 | account not provisioned |
| 429 | per-uid rate limit exceeded |
| 503 | `ctl` or ticket signing unavailable |

### 4.2 `POST /v1/r2-token`

This endpoint has no Firebase Authorization header:

```http
POST /v1/r2-token
Content-Type: application/json

{
  "ticket": "<the exact compact JWS returned by /v1/keys>",
  "user_handle": "<base64 32 bytes decrypted from cred_store>",
  "db_path": "<decrypted path>",
  "db_prefix": "<decrypted prefix>",
  "proof": {
    "version": 2,
    "expires_at": 0,
    "request_id": "<base64 32 random bytes>",
    "signature": "<base64 P-521 signature>"
  }
}
```

The Worker:

1. Verifies the ticket signature, `v`, `aud`, `iat`, and `exp` using `R2_TICKET_SECRET`.
2. Requires `user_handle` to decode to exactly 32 bytes and compares its SHA-256 digest with `ticket.user_handle_hash`.
3. Validates both paths and compares their SHA-512 binding with `ticket.db_binding_hash`.
4. Requires proof protocol version 2 and a proof expiry no more than 60 seconds in the future.
5. Rebuilds the canonical proof from the exact ticket bytes, raw handle, expiry, request id, and path binding (docs/crypto.md).
6. Verifies the 132-byte raw P-521 signature using the signing suite and public key authenticated by the ticket.
7. Mints the two 15-minute R2 credentials.

Hashing the exact compact ticket into the proof prevents moving a proof between tickets. The handle comparison binds the client's decrypted credential store to the ticket. The P-521 signature proves possession of the matching decrypted private key. The path-pair digest authorizes only the provisioned storage paths.

The response contains exactly one credential of each type:

```json
{
  "credentials": [
    {
      "type": "db_path",
      "access_key_id": "...",
      "secret_access_key": "...",
      "session_token": "...",
      "expiration": "..."
    },
    {
      "type": "db_prefix",
      "access_key_id": "...",
      "secret_access_key": "...",
      "session_token": "...",
      "expiration": "..."
    }
  ],
  "endpoint": "...",
  "bucket": "...",
  "region": "..."
}
```

`db_path` receives exact-object read-write scope. `{db_prefix}/*` receives prefix read-only scope for ordinary accounts and prefix read-write scope only when the verified ticket has `account_type = "admin"` and `sub = ADMIN_UID`. The JWS signature authenticates the role claim, and the P-521 proof hashes the exact compact JWS, so the proof is bound to that role without a second role field in its canonical message. An administrator's backup rows do not authorize other users' paths in the browser.

| status | condition |
|---|---|
| 200 | credential pair minted |
| 400 | malformed handle, path, ticket envelope, or proof |
| 401 | ticket invalid, expired, or for another audience |
| 403 | handle, path binding, signing suite, or signature mismatch |
| 429 | per-account R2-token rate limit exceeded |
| 503 | R2 signing unavailable |

### 4.3 Public-share endpoints

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

## 5. End-to-end flow

1. The browser signs in to Firebase and sends the ID token only to `/v1/keys`.
2. The Worker verifies Firebase, loads the uid's account through its KV cache or `ctl`, creates a 24-hour signed ticket, and returns the ticket with wrapped key material.
3. The browser unwraps `umk`, `cred_store.content`, and the P-521 private key. It obtains the raw `user_handle`, paths, and database key locally.
4. The browser signs a version-2 proof bound to the exact ticket, handle, paths, short expiry, and random request id.
5. `/v1/r2-token` verifies the ticket and proof without Firebase, Turso, or an account-cache read, then locally signs two 15-minute R2 credentials.
6. The client renews R2 credentials with the same ticket until the ticket expires. It calls Firebase-authenticated `/v1/keys` again only when a new ticket is required.

Proofs and tickets use fixed expirations, not sliding renewal. `/v1/r2-token` never extends a ticket.

### 5.1 Public-share authorization

Only a Firebase identity equal to `ADMIN_UID` may call `POST /v1/share-grant` or `DELETE /v1/share`. Grant creation validates the administrator's `db_path`/`db_prefix` binding, computes `SHA-256(share_id)` and `SHA-256(object_path)`, stores both 32-byte hashes as BLOBs in D1, and returns an encrypted-path grant. Registering an existing share id is idempotent only when its path hash matches. The browser generates a grant when it copies a share URL; the complete URL is never stored in SQLCipher, D1, Turso, or R2.

The returned grant derives a per-grant AES-256-GCM key from `SHARE_GRANT_KEY`, a random 32-byte salt, and the capability hash using HKDF-SHA-256, then encrypts the exact object path with an independent random 12-byte nonce. Associated data is `UTF8("txt:share-grant:v1") || SHA-256(share_id)`, preventing a grant from being moved to another capability. The URL fragment carries the raw 32-byte share id, opaque grant, and content key, so none appears in the initial navigation request.

An anonymous reader posts the id and grant to `POST /v1/shared-content`. The Worker requires the corresponding D1 row, decrypts and validates the path, compares its SHA-256 hash with the registered BLOB, fetches the encrypted object using the server-held R2 credential, and streams it with `Cache-Control: no-store`. Anonymous clients never receive R2 credentials. The Worker never receives the fragment's content key; decryption remains in the browser.

Deletion sends the bound object path to the trusted Worker, which validates the administrator and path binding, deletes the R2 object with its server-held credential, and only then removes the D1 row. The browser removes the owner's SQLCipher row only after the Worker succeeds. A failed object deletion therefore remains visible and retryable, while a stale or rolled-back R2 object cannot be read after the registry row is gone. A request authorized before deletion may finish, just as a viewer may retain plaintext already downloaded. Because deletion leaves no tombstone, the same random share id can be registered again; clients generate a fresh 32-byte id for every new share.

---

## 6. Expiration, KV caching, and rate limits

### 6.1 Ticket expiration

The signed ticket is stateless and is not stored in KV. Its JWS `exp` claim is set in code when it is issued:

```ts
const TICKET_TTL_SECONDS = 24 * 60 * 60;

const ticket = await new SignJWT(claims)
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuedAt()
  .setExpirationTime(`${TICKET_TTL_SECONDS}s`)
  .sign(ticketSecret);
```

Verification rejects the ticket after `exp`. There is no per-ticket denylist, active-revocation KV entry, or sliding expiration.

An outstanding ticket can mint R2 credentials until its final second. Because a minted credential lasts 15 minutes, the maximum passive deprovisioning/key-rotation delay is approximately 24 hours and 15 minutes from ticket issuance.

### 6.2 KV expiration

KV caches the account record used by `/v1/keys` and the authenticated share-management endpoints, plus rate counters. The account cache expires 24 hours after each write:

```ts
const KEYS_TTL_SECONDS = 24 * 60 * 60;

await kv.put(`keys:v3:${uid}`, JSON.stringify(account), {
  expirationTtl: KEYS_TTL_SECONDS,
});
```

Cloudflare KV's `expirationTtl` is a relative number of seconds from the `put`. It is storage expiration, not a value interpreted by application code. A later `put` resets the countdown. Rate-limit counters use the same option with `expirationTtl: 60 * 60`.

| KV key | contents | TTL |
|---|---|---|
| `keys:v3:{uid}` | account type, handle hash, path binding, signing suite/public and wrapped-private key, wrapped `umk`, and encrypted `cred_store.content` | 24 hours |
| `ratelimit:v3:keys:{uid}:{window}` | account resolutions for `/v1/keys`, `/v1/share-grant`, and `DELETE /v1/share` | 1 hour |
| `ratelimit:v3:r2-token:{sub}:{window}` | valid `/v1/r2-token` count | 1 hour |

The R2 endpoint derives its account identity from the verified ticket. It applies the per-account R2 limit only after validating the ticket and proof so someone holding only public ticket metadata cannot spend another user's quota with invalid signatures. Coarse platform protections can reject abusive unauthenticated traffic before cryptographic verification.

The implemented budgets are 60 account resolutions (keys and administrator share management combined) and 30 valid `/v1/r2-token` calls per account per hour. The keys limit is checked before the account-cache lookup; a cache hit still consumes the budget.

---

## 7. Expiration and operational response

There is no active per-user ticket revocation. Normal changes take effect as follows:

| event | action and remaining exposure |
|---|---|
| wrapped `umk` or credential store changed | update `ctl` and purge `keys:v3:{uid}` so the next `/v1/keys` sees it; existing tickets expire naturally |
| signing key rotated | update the key row and purge the account cache; existing tickets retain the old public key for at most their remaining 24-hour lifetime |
| user deprovisioned | delete their rows, purge the account cache, and delete their R2 objects; an existing ticket can still mint credentials until expiry |
| temporary R2 credential leaked | no early revocation; it expires after 15 minutes |
| ticket and P-521 private key leaked together | rotate the signing key and accept the remaining ticket lifetime, or rotate `R2_TICKET_SECRET` to invalidate all tickets in an emergency |
| Worker ticket secret leaked | replace `R2_TICKET_SECRET` and redeploy; all tickets stop verifying |
| share-grant key leaked or rotated | replace `SHARE_GRANT_KEY`, redeploy, and issue new URLs; every grant made with the prior key stops decrypting |
| parent R2 credential leaked | replace the parent key and redeploy; already-issued credentials expire naturally |

Purging the account cache affects only future `/v1/keys` calls. It cannot revoke a stateless ticket already held by a client.

---

## 8. Trust boundary

The client, administrator, Worker, and D1 authorization state are trusted; Turso and R2 are not trusted with plaintext user data or authorization integrity. The Worker holds the Turso token, ticket secret, share-grant key, parent R2 credential, trusted `ADMIN_UID`, and D1 binding, but no `user_root_key`, raw `user_handle`, plaintext `umk`, or share content key. Turso sees the handle hash and encrypted user material. D1 sees only capability/path hashes and creation times. `users.type` is descriptive and may be checked for provisioning consistency, but it never grants administrator scope. The administrator can decrypt ordinary-user backup roots by design so that admin-only migrations remain possible.

The signed ticket moves the R2 authorization record out of Turso for the ticket's lifetime. Turso can corrupt the hash, public key, ciphertext, or path binding returned during a Firebase-authenticated `/v1/keys` call, but the resulting ticket is delivered only to that authenticated browser. Turso cannot replace the encrypted raw handle or private key with chosen plaintext without the account's `umk`; substitutions therefore make decryption, handle comparison, path comparison, or signature verification fail. Without the Firebase token and decrypted client material, Turso cannot use the replacement ticket itself. This reduces active Turso tampering to denial of service for that account rather than R2 impersonation.

A stolen ticket is insufficient by itself. A caller also needs the raw handle and the P-521 private key. A compromised client holding all decrypted material can access its own provisioned paths, while a compromised Worker can sign arbitrary tickets and R2 credentials and is therefore inside the trusted computing base.

The ticket's `sign_version` selects the signing key suite. The proof's `version` selects the canonical request protocol. Neither is client-negotiated downward. The only accepted signing suite is P-521, which provides approximately 256-bit classical security but no post-quantum security.

---

## 9. Rollout order

1. Back up `ctl` and R2. Re-run `--init-admin`, then re-run `--init-user` for every ordinary account so path bindings, signing keys, and administrator backups are current.
2. Run `txt --update-ctl admin_creds.json --verbose --dry-run`; resolve every reported backup or handle problem before running it without `--dry-run`.
3. Run `--update-db` for every reachable encrypted database.
4. Configure `KEYS_CACHE` and `SHARE_REGISTRY`, then apply the registry schema with `npx wrangler d1 execute SHARE_REGISTRY --remote --file worker/migrations/0001_share_registry.sql`.
5. Generate separate values with `openssl rand -base64 32` and install them as `R2_TICKET_SECRET` and `SHARE_GRANT_KEY`; also configure the remaining §1 values, especially `ADMIN_UID`.
6. Apply the R2 CORS policy and deploy the Worker and browser together.
7. Confirm `/v1/keys`, automatic ticket renewal after a 401, exact-path read/write, ordinary/admin prefix scope, share copy/read/delete, and negative handle/path/signature/grant cases.
