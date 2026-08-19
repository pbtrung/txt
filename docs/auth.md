# Auth — Design

Firebase authenticates the browser once at `POST /v1/keys`. That response returns the user's wrapped key material and a Worker-signed, 24-hour R2 binding ticket. The browser decrypts its `user_handle`, storage paths, and P-521 private key locally. It then renews short-lived R2 credentials through `POST /v1/r2-token` using the ticket and a fresh P-521 proof, without sending another Firebase token or querying Turso.

The ticket is an integrity-protected certificate, not a bearer credential. It binds the Firebase-provisioned account to the hash of the user's decrypted handle, its signing public key, and its authorized path-pair hash. A caller must possess both the decrypted handle and the matching P-521 private key to use it.

The Worker mints one read-write credential for the exact `db_path` object and one read-only credential for `{db_prefix}/*`. It never creates users or storage prefixes; an administrator provisions both out of band.

---

## 1. Worker configuration and secrets

There is one Turso control database, `ctl` (§2). User data lives as encrypted objects in R2 (docs/data_model.md).

| name | purpose |
|---|---|
| `CTL_DB_URL` | control database URL |
| `CTL_DB_TOKEN` | non-expiring, read-only token for `ctl` |
| `FIREBASE_PROJECT_ID` | expected Firebase token issuer and audience for `/v1/keys` |
| `R2_TICKET_SECRET` | at least 32 random bytes, used only to sign and verify R2 binding tickets |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION` | R2 destination returned with temporary credentials |
| `R2_READ_WRITE_ACCESS_KEY_ID` / `R2_READ_WRITE_SECRET_ACCESS_KEY` | parent credential used to sign path-limited temporary R2 credentials |

`R2_TICKET_SECRET` must not reuse the R2 secret access key. All Worker instances use the same ticket secret. Rotating it invalidates every outstanding ticket and is an emergency global response, not routine per-user revocation.

The Worker Turso token is read-only. A leaked Worker database token can expose ciphertext and control metadata, but cannot alter or delete rows.

---

## 2. Control database

`ctl` holds identity, wrapped key material, the handle binding, and the storage-path binding:

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,       -- Firebase uid
  user_handle     BLOB NOT NULL UNIQUE CHECK (length(user_handle) = 32),
  type            TEXT NOT NULL CHECK (type IN ('admin', 'user')),
  created_at      INTEGER NOT NULL,        -- unix ms
  db_binding_hash BLOB NOT NULL CHECK (length(db_binding_hash) = 64)
);

CREATE TABLE key_store (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  umk            BLOB NOT NULL,  -- wrapped by user_root_key
  pubkey         BLOB,           -- composite KEM public key; admin only
  privkey        BLOB,           -- wrapped composite KEM private key; admin only
  sign_version   INTEGER NOT NULL CHECK (sign_version >= 1),
  sign_algorithm TEXT NOT NULL,
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

`user_handle` is 32 random bytes. The identical bytes are base64-encoded as `cred_store.content.user_handle` before that JSON payload is encrypted under the owner's `umk`. The Worker reads the plaintext database column while creating a ticket, but `/v1/keys` never returns that column separately. The browser obtains the handle only from the credential store it decrypts locally.

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

`users.db_binding_hash` stores `SHA-512(UTF-8(db_path) || UTF-8(db_prefix))`. Both inputs have fixed validated lengths, so the concatenation is unambiguous. The ticket carries this digest rather than either raw path.

Signing-suite version 1 is `ECDSA-P521-SHA512`. `sign_pubkey` is SPKI DER. `sign_privkey` is PKCS#8 DER wrapped with the account's `umk` using docs/crypto.md. The signing-suite version is separate from the R2 proof protocol version.

The Worker's `/v1/keys` lookup is by Firebase uid:

```sql
SELECT u.type, u.user_handle, u.db_binding_hash,
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
4. Insert `users` with the Firebase uid, raw `user_handle`, and `db_binding_hash`.
5. Generate the version-1 P-521 key pair. Store its public key and wrap its private key with `umk`.
6. Encrypt the credential payload, including the same base64-encoded `user_handle`, into the account's self-owned `cred_store` row.
7. For an ordinary user, wrap the same complete payload into the administrator-owned backup row.

Re-running provisioning migrates missing control-plane columns and fills missing handle values. `--update-db` remains responsible only for schemas inside users' encrypted SQLCipher databases in R2; it does not migrate the Turso control schema.

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
  "v": 1,
  "aud": "r2-token",
  "sub": "<Firebase uid>",
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

`exp` is exactly 24 hours after `iat`. The ticket is returned outside `cred_store` because it does not contain plaintext handles, paths, or private keys. The client keeps it only in memory and discards it when the vault locks.

| status | condition |
|---|---|
| 200 | wrapped key material and ticket returned |
| 401 | Firebase token missing or invalid |
| 403 | account not provisioned |
| 429 | per-uid rate limit exceeded |
| 503 | `ctl` unavailable |

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

`db_path` receives exact-object read-write scope. `{db_prefix}/*` receives prefix read-only scope. Administrators receive the same scopes for their own browser sessions; an administrator's backup rows do not authorize other users' paths in the browser.

| status | condition |
|---|---|
| 200 | credential pair minted |
| 400 | malformed handle, path, ticket envelope, or proof |
| 401 | ticket invalid, expired, or for another audience |
| 403 | handle, path binding, signing suite, or signature mismatch |
| 429 | per-account R2-token rate limit exceeded |
| 503 | R2 signing unavailable |

---

## 5. End-to-end flow

1. The browser signs in to Firebase and sends the ID token only to `/v1/keys`.
2. The Worker verifies Firebase, loads the uid's account through its KV cache or `ctl`, creates a 24-hour signed ticket, and returns the ticket with wrapped key material.
3. The browser unwraps `umk`, `cred_store.content`, and the P-521 private key. It obtains the raw `user_handle`, paths, and database key locally.
4. The browser signs a version-2 proof bound to the exact ticket, handle, paths, short expiry, and random request id.
5. `/v1/r2-token` verifies the ticket and proof without Firebase, Turso, or an account-cache read, then locally signs two 15-minute R2 credentials.
6. The client renews R2 credentials with the same ticket until the ticket expires. It calls Firebase-authenticated `/v1/keys` again only when a new ticket is required.

Proofs and tickets use fixed expirations, not sliding renewal. `/v1/r2-token` never extends a ticket.

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

KV caches only the account record used by `/v1/keys` and the rate counters. The account cache expires 24 hours after each write:

```ts
const KEYS_TTL_SECONDS = 24 * 60 * 60;

await kv.put(`keys:v3:${uid}`, JSON.stringify(account), {
  expirationTtl: KEYS_TTL_SECONDS,
});
```

Cloudflare KV's `expirationTtl` is a relative number of seconds from the `put`. It is storage expiration, not a value interpreted by application code. A later `put` resets the countdown. Rate-limit counters use the same option with `expirationTtl: 60 * 60`.

| KV key | contents | TTL |
|---|---|---|
| `keys:v3:{uid}` | account type, raw handle, path binding, signing suite/public and wrapped-private key, wrapped `umk`, and `cred_store.content` | 24 hours |
| `ratelimit:v3:keys:{uid}:{window}` | `/v1/keys` count | 1 hour |
| `ratelimit:v3:r2-token:{sub}:{window}` | valid `/v1/r2-token` count | 1 hour |

The R2 endpoint derives its account identity from the verified ticket. It applies the per-account R2 limit only after validating the ticket and proof so someone holding only public ticket metadata cannot spend another user's quota with invalid signatures. Coarse platform protections can reject abusive unauthenticated traffic before cryptographic verification.

Suggested budgets remain 60 `/v1/keys` calls and 30 valid `/v1/r2-token` calls per account per hour.

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
| parent R2 signing credential leaked | replace the parent key and redeploy; already-issued credentials expire naturally |

Purging the account cache affects only future `/v1/keys` calls. It cannot revoke a stateless ticket already held by a client.

---

## 8. Trust boundary

The client and Worker are trusted; Turso and R2 are not trusted with plaintext user data. The Worker holds the Turso token, ticket secret, and parent R2 signing credential, but no `user_root_key` or plaintext `umk`. Turso and R2 store encrypted user material.

The signed ticket moves the R2 authorization record out of Turso for the ticket's lifetime. Turso can corrupt the account fields returned during a Firebase-authenticated `/v1/keys` call, but the resulting ticket is delivered only to that authenticated browser. Substituting a public key, handle, ciphertext, or path binding causes the legitimate client's decrypted handle or private key proof to fail. Without the Firebase token, Turso cannot obtain the replacement signed ticket for itself. This reduces active Turso tampering to denial of service for that account rather than R2 impersonation.

A stolen ticket is insufficient by itself. A caller also needs the raw handle and the P-521 private key. A compromised client holding all decrypted material can access its own provisioned paths, while a compromised Worker can sign arbitrary tickets and R2 credentials and is therefore inside the trusted computing base.

The ticket's `sign_version` selects the signing key suite. The proof's `version` selects the canonical request protocol. Neither is client-negotiated downward. P-521 provides approximately 256-bit classical security but no post-quantum security; a future hybrid suite must require both its classical and post-quantum signatures.

---

## 9. Implementation order

1. Add `users.user_handle`, generate one 32-byte value per account, and place its base64 representation in every corresponding encrypted credential payload and administrator backup.
2. Extend the `/v1/keys` account lookup/cache and response with a 24-hour Worker-signed ticket.
3. Separate signing-suite version 1 from proof-protocol version 2.
4. Change the client proof to bind the exact ticket, raw handle, expiry, request id, and path pair.
5. Remove Firebase and Turso lookup from `/v1/r2-token`; verify only the signed ticket and P-521 proof.
6. Version the KV formats and apply account rate limiting only after successful ticket/proof verification.
7. Add negative tests for expired or altered tickets, wrong handle, wrong ticket audience, ticket/proof substitution, malformed signatures, and path mismatch.
