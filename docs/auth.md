# Auth — Design

Firebase identity, exchanged at a Cloudflare Worker for two things a client needs to open its own data: wrapped key material from the control database (`ctl`), and a short-lived R2 credential scoped to its own storage prefix.

The client authenticates with Firebase, sends its ID token to the Worker, and gets back its own wrapped `umk` and wrapped `cred_store` backup (§4.1). It decrypts both locally to recover `db_path`, `db_master_key`, and `db_prefix` (docs/data_model.md), then calls the Worker a second time with `db_path` and `db_prefix` to receive a short-lived R2 credential scoped to both (§4.2). The Worker mints credentials; it does not create users or storage prefixes. Both are provisioned by an administrator out of band.

The Worker is the only component holding Turso credentials, and it holds no encryption key: `umk`, `cred_store.content`, and every object in R2 are encrypted client-side, so a compromised Worker exposes only ciphertext and the metadata described in §8.

---

## 1. Worker secrets

There is exactly one Turso database, `ctl` (§2), holding the three tables that make up the whole control plane: `users`, `key_store`, `cred_store`. Every user's actual data lives as objects in R2 (docs/data_model.md), so there is no per-user Turso database and no step where the Worker mints a Turso token scoped to one; its only Turso credential is a single token against `ctl` itself.

| secret | value |
|---|---|
| `CTL_DB_URL` | the control database's URL (§2) |
| `CTL_DB_TOKEN` | a non-expiring `read-only` database token for `ctl` |
| `FIREBASE_PROJECT_ID` | expected `iss` and `aud` of incoming ID tokens |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION` | the object store the R2 credential in §4.2 is scoped into |
| `R2_READ_WRITE_ACCESS_KEY_ID` / `R2_READ_WRITE_SECRET_ACCESS_KEY` | parent credential the admin's bucket-wide, read-write temporary credential is signed from |
| `R2_READ_ONLY_ACCESS_KEY_ID` / `R2_READ_ONLY_SECRET_ACCESS_KEY` | parent credential an ordinary user's prefix-scoped, read-only temporary credential is signed from |

---

## 2. The control database

`ctl` is an ordinary Turso database in the same organization, created by an administrator and holding three tables. Its actual name is a generated value, same recipe as `db_path` below, recorded as `turso_ctl_db_name`/`turso_ctl_db_url` in the administrator's own backend config when it's created; `ctl` is only this document's shorthand for it. It is not special to Turso in any way; it is simply the database the Worker consults for identity and key material.

```sql
CREATE TABLE users (
  id         TEXT PRIMARY KEY,       -- Firebase uid (the ID token's sub claim)
  type       TEXT NOT NULL,          -- admin or user
  created_at INTEGER NOT NULL        -- unix ms
);

CREATE TABLE key_store (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  umk     BLOB NOT NULL,      -- 128 random bytes, wrapped by user_root_key
  pubkey  BLOB,                -- composite KEM public key (docs/crypto.md), raw; admin row only
  privkey BLOB                 -- composite KEM private key, wrapped by umk (docs/crypto.md); admin row only
);

CREATE TABLE cred_store (
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  for_user_id  TEXT NOT NULL REFERENCES users(id),   -- ctl users.id: this account's own id, or another user's
  -- owner_id = for_user_id is an account's own row; every account, admin or not, has exactly one
  -- owner_id = the admin's id and for_user_id = a user's id is the admin's backup of that user's creds; both wrapped under the admin's own umk
  content      BLOB NOT NULL,          -- wrapped by owner_id's umk; { display_name, db_master_key, db_path, db_prefix }
  PRIMARY KEY (owner_id, for_user_id)
);
```

`db_path` and `db_prefix` are each 32 random bytes rendered as 52 lowercase base32-Crockford characters, the same recipe as every object key in the store (docs/data_model.md): `db_path` addresses a user's own SQLCipher database file in R2, `db_prefix` the R2 prefix its documents live under. `db_master_key` is 256 random bytes, base64-encoded — the SQLCipher key for that database file. None of the three is a column on `users` — all three live only inside the encrypted `content` blob, so the Worker itself never learns them; it forwards ciphertext and lets the client decrypt.

How the Worker reaches `ctl`, and where each half comes from:

| secret | how the administrator produces it | value |
|---|---|---|
| `CTL_DB_URL` | generated when the control database is created, recorded as `turso_ctl_db_url` in the administrator's own backend config | `libsql://{turso_ctl_db_name}-{account_name}.aws-us-east-1.turso.io` |
| `CTL_DB_TOKEN` | minted once with the Platform API token: `POST /v1/organizations/{org}/databases/{turso_ctl_db_name}/auth/tokens?authorization=read-only` (no `expiration`, so it does not expire) | the returned `jwt` |

The token is `read-only` because the Worker only ever reads `users`, `key_store`, and `cred_store`. That is the whole reason this is a separate secret rather than a reuse of the Platform API token: a Worker bug or injection cannot write or drop any of the three tables.

Both secrets are set on the Worker at deploy time and rotated by minting a replacement and redeploying.

The Worker queries `ctl` over the libsql HTTP API, so no driver and no connection pool is involved:

```
POST {CTL_DB_URL over https}/v2/pipeline
Authorization: Bearer {CTL_DB_TOKEN}

{ "requests": [
    { "type": "execute",
      "stmt": { "sql": "SELECT u.type, k.umk, k.pubkey, k.privkey, c.content FROM users u JOIN key_store k ON k.user_id = u.id JOIN cred_store c ON c.owner_id = u.id AND c.for_user_id = u.id WHERE u.id = ?",
                "args": [ { "type": "text", "value": "{uid}" } ] } },
    { "type": "close" } ] }
```

Nothing else lives in `users` beyond identity and `type`. No email, no display name, no Firebase claims — Firebase owns identity, `ctl` owns only the mapping and the wrapped key material.

---

## 3. Provisioning

### 3.1 Where the uid comes from

`uid` is Firebase's user identifier: the `sub` claim of an ID token, and the primary key of `users`. Nothing in this system generates it, and it does not exist until the user has signed in to Firebase at least once.

So provisioning is necessarily second. The order is:

1. The user signs up and signs in through Firebase. Firebase assigns the uid.
2. The administrator reads that uid from Firebase — the Authentication tab in the Firebase console, or the Admin SDK (`getUserByEmail`, `listUsers`) — keyed by whatever the user identified themselves with.
3. The administrator provisions (§3.2).

Between steps 1 and 3 the user is authenticated but not provisioned: the endpoint returns 403 and the client shows a pending state. That window is however long the administrator takes, so the client must treat 403 as "not yet", not as an error to retry tightly — back off to minutes, and stop after a bounded number of attempts.

An administrator who wants provisioning to feel immediate needs the uid earlier, which means a signup hook rather than a console lookup. That is out of scope here: this design has no automatic path from a Firebase account to a database.

### 3.2 Steps

Done by an administrator, never by the Worker, in one step — unlike a database, an R2 prefix needs no separate creation phase, so there is nothing left to do lazily on first use:

1. Generate `db_path` and `db_prefix`: 32 random bytes each, base32-Crockford.
2. Generate `umk`: 128 random bytes.
3. `INSERT INTO users (id, type, created_at) VALUES (?, 'user', ?)` in `ctl`, with the uid from §3.1.
4. `INSERT INTO key_store (user_id, umk) VALUES (?, ?)`, `umk` wrapped by a `user_root_key` generated for this account.
5. `INSERT INTO cred_store (owner_id, for_user_id, content) VALUES (?, ?, ?)` with `owner_id = for_user_id` = the uid, `content` wrapped by `umk` and holding `{ display_name, db_master_key, db_path, db_prefix }`.

The administrator packages `user_root_key`, and whatever else the client needs to reach the Worker, into that user's own creds.json — the same way the administrator's own backend config carries its own `user_root_key`.

A Firebase account with no `users` row is authenticated but not provisioned, and the endpoint returns 403. The Worker never creates the row, so a valid Firebase signup grants no access on its own.

---

## 4. Endpoints

### 4.1 `POST /v1/keys`

```
POST /v1/keys
Authorization: Bearer <Firebase ID token>
```

```json
{
  "type": "user",
  "umk": "<base64 ciphertext>",
  "cred_store": "<base64 ciphertext>"
}
```

| status | condition |
|---|---|
| 200 | key material returned |
| 401 | ID token missing, malformed, expired, or wrong issuer or audience |
| 403 | no `users` row for this uid — the account is not provisioned |
| 429 | per-uid rate limit exceeded |
| 503 | `ctl` unavailable |

### 4.2 `POST /v1/r2-token`

```
POST /v1/r2-token
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{
  "db_path": "<the path the client just decrypted from cred_store>",
  "db_prefix": "<the prefix the client just decrypted from cred_store>"
}
```

```json
{
  "access_key_id": "...",
  "secret_access_key": "...",
  "session_token": "...",
  "expiration": "..."
}
```

Scoped read-only to the single object at `db_path` and to `{db_prefix}/*` for an ordinary user (`type = 'user'`) — both need their own authorization, since `db_path` addresses one object rather than a prefix and isn't covered by a `db_prefix`-scoped grant; bucket-wide read-write for the admin's own uid (`type = 'admin'`), since the admin also holds every provisioned user's backup. The Worker does not independently verify that the supplied `db_path`/`db_prefix` belong to the caller — see §8.

| status | condition |
|---|---|
| 200 | credential minted |
| 401 | ID token missing, malformed, expired, or wrong issuer or audience |
| 403 | no `users` row for this uid |
| 429 | per-uid rate limit exceeded |
| 503 | `ctl`, or the R2 signing step, unavailable |

---

## 5. Flow

**1. Verify the Firebase ID token.** RS256 signature against Google's published keys for `securetoken@system.gserviceaccount.com`, fetched with WebCrypto and cached in the Worker for the lifetime given by the response's `Cache-Control`. Assert `iss = https://securetoken.google.com/{FIREBASE_PROJECT_ID}`, `aud = {FIREBASE_PROJECT_ID}`, `exp` in the future, `iat` and `auth_time` not in the future, and `sub` non-empty. `uid = sub`.

**2. Look up the user.** The join in §2 against `ctl`. No row → 403, and nothing is created.

**3. Return `type`, `umk`, and `cred_store.content`**, still wrapped — the Worker never sees plaintext key material. The client unwraps `umk` with its own `user_root_key`, then unwraps `cred_store.content` with `umk` to recover `display_name`, `db_master_key`, `db_path`, and `db_prefix`.

**4. Mint the R2 credential.** The client calls `/v1/r2-token` with the `db_path` and `db_prefix` it just recovered; the Worker signs a short-lived credential scoped to both (§4.2) and returns it. The client reads its `expiration` and re-calls this endpoint before it lapses, and immediately on a rejected R2 request.

---

## 6. Caching and rate limits

The `ctl` join is a round trip, so the Worker does not repeat it per request; minting the R2 credential is a local signing operation, not a round trip, and is not cached.

| key | contents | TTL |
|---|---|---|
| `keys:{uid}` | `type`, `umk`, `cred_store.content` as returned by the §2 join | 24 hours |

Steady state is one KV read for `/v1/keys`. A cache miss is one `ctl` query.

`keys:{uid}` is cached rather than read every time because the underlying rows change only when an administrator changes them; the 24-hour TTL bounds how long a deprovisioned user keeps being served, and revocation (§7) purges the key explicitly.

Rate-limit per `uid` on both endpoints — generous for a client that refreshes on its own credential's expiry — so a looping client cannot exhaust the Worker's capacity for every other user. Rate-limit 403s per uid too: an unprovisioned client retrying in a loop otherwise hits `ctl` on every request.

---

## 7. Revocation

| event | action |
|---|---|
| a user's `umk` or `cred_store` content leaks | purge `keys:{uid}` from KV so the next `/v1/keys` call re-reads `ctl`; rotate that account's `user_root_key`/`umk` if the leak exposed plaintext |
| an R2 credential leaks | nothing to revoke early — it is bounded by its own short expiration (§4.2) |
| the Worker's R2 signing credential leaks | mint a replacement parent key pair, redeploy; credentials already issued keep working until they expire |
| the administrator's Platform API token leaks | `DELETE /v1/auth/api-tokens/{name}`, mint a replacement — used only for out-of-band provisioning, never held by the Worker |
| a user is deprovisioned | delete the `users`, `key_store`, and `cred_store` rows, purge `keys:{uid}` from KV, then delete the user's R2 objects (`db_path` and everything under `db_prefix`) |

Individual R2 credentials cannot be revoked — only left to expire. The short TTL in §4.2 is what bounds exposure in the ordinary case.

---

## 8. Trust boundary

The Worker holds `ctl` credentials and R2 signing credentials, and can therefore read every user's wrapped key material and mint an R2 credential for any prefix a caller supplies. It holds no encryption key: `umk` and `cred_store.content` decrypt only client-side, so the Worker — and Turso, and R2 — cannot decrypt anything a user stores.

`/v1/r2-token` scopes its credential to whatever `db_path`/`db_prefix` the caller supplies (§4.2), with no independent check that either is actually that uid's own. Soundness rests on the client only ever asking for its own `db_path`/`db_prefix`; a malicious or compromised client could ask for another account's. Because everything at `db_path` and under `db_prefix` is client-side encrypted, the confidentiality of that data still holds regardless — but its availability does not, since a read-write-scoped credential could still overwrite or delete it.

`db_path` and `db_prefix` are not secrets in the sense of being load-bearing for access control; they are unguessable, but the actual gate is the token, and every token is short-lived.

---

## 9. Build order

1. Firebase ID token verification with cached signing keys, including the negative cases: expired, wrong audience, wrong issuer, tampered signature.
2. The `ctl` join and `/v1/keys`, against an administrator-created row.
3. The unprovisioned path: valid Firebase token, no `users` row, 403, and nothing written anywhere.
4. `/v1/r2-token`, scoped by the caller-supplied `db_path` and `db_prefix`.
5. KV caching and the per-uid rate limits, on both endpoints.
6. Revocation and deprovisioning runbooks.
