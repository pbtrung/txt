# Auth — Design

Firebase identity, exchanged at a Cloudflare Worker for a short-lived Turso token scoped to one user's database.

The client authenticates with Firebase, sends its ID token to the Worker, and receives a 60-minute Turso token valid for its own database only. The Worker mints tokens; it does not create users or databases. Both are provisioned by an administrator out of band.

The Worker is the only component holding Turso credentials, and it holds no encryption key: database page content and the library index are encrypted client-side, so a compromised Worker exposes database metadata and nothing else.

---

## 1. Which Turso token does what

Three token types exist and only one of them can mint:

| token | scope | can mint database tokens | used here |
|---|---|---|---|
| **Platform API token** — `turso auth api-tokens mint <name>` | the whole organization: create, delete, and issue tokens for every database | **yes** | **the Worker secret** |
| **group token** — `turso group tokens create <group>` | data access to every database in the group | no | not used |
| **database token** — minted per request by the Worker, or once by an admin for `ctl` | data access to one database | no | returned to the client; also the Worker's `ctl` credential |

**The Worker secret is the Platform API token.** A group token is a data-plane credential, not an API credential: it cannot mint anything, and it grants access to *every* database in the group, so one leak exposes every user. The Platform API token is the only credential that can issue a token scoped to a single database.

Worker secrets:

| secret | value |
|---|---|
| `TURSO_ORG_TOKEN` | Platform API token, minted under a dedicated name so it can be revoked independently |
| `TURSO_ORG` | organization slug; also the `account_name` in database URLs |
| `CTL_DB_URL` | the control database's URL (§2) |
| `CTL_DB_TOKEN` | a non-expiring `read-only` database token for `ctl` |
| `FIREBASE_PROJECT_ID` | expected `iss` and `aud` of incoming ID tokens |

---

## 2. The control database

`ctl` is an ordinary Turso database in the same organization, created by an administrator and holding one table. It is not special to Turso in any way; it is simply the database the Worker consults to map a Firebase uid to a user's database.

```sql
CREATE TABLE users (
  id         TEXT PRIMARY KEY,       -- Firebase uid (the ID token's sub claim)
  db_path    TEXT UNIQUE,            -- 32 random bytes, 52 chars base32-Crockford; NULL until the database is created (§3.2)
  type       TEXT NOT NULL CHECK (type IN ('admin', 'user')),
  created_at INTEGER NOT NULL        -- unix ms
);
```

`type` distinguishes the one administrator account from every ordinary user. It decides which tables exist in that account's own database: `key_store` only for `admin`, and the shape of `cred_store` (data_model.md §3.6–3.7).

A row can exist with `db_path` still `NULL`: registering an account (creating its `users` row) and creating its database are two separate steps (§3.2), so an account can be registered well before its database is actually provisioned.

How the Worker reaches it, and where each half comes from:

| secret | how the administrator produces it | value |
|---|---|---|
| `CTL_DB_URL` | fixed at creation | `libsql://ctl-{account_name}.aws-us-east-1.turso.io` |
| `CTL_DB_TOKEN` | minted once with the Platform API token: `POST /v1/organizations/{org}/databases/ctl/auth/tokens?authorization=read-only` (no `expiration`, so it does not expire) | the returned `jwt` |

The token is `read-only` because the Worker only ever reads `users`. That is the whole reason this is a separate secret rather than a reuse of the Platform API token: a Worker bug or injection cannot write or drop the mapping table.

Both secrets are set on the Worker at deploy time and rotated by minting a replacement and redeploying.

The Worker queries `ctl` over the libsql HTTP API, so no driver and no connection pool is involved:

```
POST {CTL_DB_URL over https}/v2/pipeline
Authorization: Bearer {CTL_DB_TOKEN}

{ "requests": [
    { "type": "execute",
      "stmt": { "sql": "SELECT db_path FROM users WHERE id = ?", "args": [ { "type": "text", "value": "{uid}" } ] } },
    { "type": "close" } ] }
```

`db_path` is both the Turso database name and the host label of a user's database URL. It is 32 random bytes rendered as 52 lowercase base32-Crockford characters, the same recipe as every object key in the store.

The host label is `{db_path}-{account_name}` and a DNS label is limited to 63 bytes. Account names are capped at 10 characters, so the label is at most 52 + 1 + 10 = 63 bytes — within the limit, with no slack. This is a hard constraint on the account name: an eleven-character account name produces a hostname that does not resolve.

Nothing else lives in `users`. No email, no display name, no Firebase claims — Firebase owns identity, `ctl` owns only the mapping.

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

Done by an administrator, never by the Worker, in two independent phases:

**Register** — creates the mapping row, `db_path` left `NULL`:

1. `INSERT INTO users (id, type, created_at) VALUES (?, ?, ?)` in `ctl`, with the uid from §3.1.

**Create the database** — whenever the account actually needs one, which can be well after registration:

2. Generate `db_path`: 32 random bytes, base32-Crockford.
3. `POST /v1/organizations/{org}/databases` with `{ "name": "{db_path}", "group": "{group}" }` using the Platform API token.
4. `UPDATE users SET db_path = ? WHERE id = ?`.

Order matters within the create phase: create the database before setting `db_path` on the row. A row whose `db_path` points at a database that doesn't exist yet yields 503s for that user; a database with no row referencing it is inert and costs storage only.

The database's own schema is applied by the client on first connect, guarded by a schema-version row.

A Firebase account with no `users` row, or a `users` row whose `db_path` is still `NULL`, is authenticated but not (fully) provisioned, and the endpoint returns 403 either way. The Worker never creates the row or the database, so a valid Firebase signup grants no access on its own.

---

## 4. Endpoint

```
POST /v1/db-token
Authorization: Bearer <Firebase ID token>
```

```json
{
  "db_token": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9…",
  "db_url": "libsql://{db_path}-{account_name}.aws-us-east-1.turso.io"
}
```

| status | condition |
|---|---|
| 200 | token minted |
| 401 | ID token missing, malformed, expired, or wrong issuer or audience |
| 403 | no `users` row for this uid, or its `db_path` is `NULL` — the account has no database yet |
| 429 | per-uid rate limit exceeded |
| 503 | `ctl` or the Turso Platform API unavailable, or the user's database does not exist |

---

## 5. Flow

**1. Verify the Firebase ID token.** RS256 signature against Google's published keys for `securetoken@system.gserviceaccount.com`, fetched with WebCrypto and cached in the Worker for the lifetime given by the response's `Cache-Control`. Assert `iss = https://securetoken.google.com/{FIREBASE_PROJECT_ID}`, `aud = {FIREBASE_PROJECT_ID}`, `exp` in the future, `iat` and `auth_time` not in the future, and `sub` non-empty. `uid = sub`.

**2. Look up the user.** `SELECT db_path FROM users WHERE id = ?` against `ctl` (§2). No row, or a row with `db_path IS NULL` → 403, and nothing is created.

**3. Mint the database token**, scoped to that one database, valid for 60 minutes:

```
POST https://api.turso.tech/v1/organizations/{TURSO_ORG}/databases/{db_path}/auth/tokens
     ?expiration=60m&authorization=full-access
Authorization: Bearer {TURSO_ORG_TOKEN}
Content-Type: application/json

{ }
```

The response is `{ "jwt": "…" }`. `authorization=full-access` grants read and write on that database and nothing else; the empty body grants no `read_attach` permission, so the token cannot attach any other database. A 404 here means the `users` row points at a database that does not exist — return 503 and alert, since it is a provisioning error, not a client error.

**4. Return** `db_token` and `db_url`. The uid appears nowhere in the response — it is the request's identity, not the reply's. The client reads `exp` from the JWT and re-calls this endpoint at `exp − 5 minutes`, and immediately on a `401` from Turso.

---

## 6. Caching and rate limits

Minting is a Platform API round trip and the Platform API is rate-limited per organization, so the Worker does not mint per request.

| key | contents | TTL |
|---|---|---|
| `token:{uid}` | the minted JWT | 55 minutes |
| `user:{uid}` | `db_path` | 24 hours |

Steady state is one KV read. A cache miss is one `ctl` query plus one Platform API call.

`user:{uid}` is cached rather than read every time because the mapping changes only when an administrator changes it; the 24-hour TTL bounds how long a deprovisioned user keeps being served, and revocation (§7) purges the key explicitly.

Rate-limit per `uid` — ten requests per hour is generous for a client that refreshes hourly — so a looping client cannot exhaust the organization's Platform API quota for every other user. Rate-limit 403s per uid too: an unprovisioned client retrying in a loop otherwise hits `ctl` on every request.

---

## 7. Revocation

| event | action |
|---|---|
| a user's token leaks | `POST /v1/organizations/{TURSO_ORG}/databases/{db_path}/auth/rotate`, which invalidates every token for that database; delete `token:{uid}` from KV |
| the Worker's Platform API token leaks | `DELETE /v1/auth/api-tokens/{name}`, mint a replacement, redeploy; database tokens already issued keep working until they expire |
| a user is deprovisioned | delete the `users` row, purge `token:{uid}` and `user:{uid}` from KV, rotate the database's tokens, then delete the Turso database and the user's object-storage prefix |

Individual database tokens cannot be revoked — only expired or rotated wholesale per database. The 60-minute lifetime is what bounds exposure in the ordinary case; deleting the `users` row stops new tokens but does not invalidate outstanding ones, which is why deprovisioning rotates as well.

---

## 8. Trust boundary

The Worker holds an organization-wide credential and can therefore read and write any user's database. That is the boundary, and it is placed here deliberately: a user's database holds page numbers, version numbers, random object keys, sizes, and timestamps. It holds no page content, no SQLCipher key, and no library-index key. Those are derived on the client from the user's own secret and never transmitted, so the Worker — and Turso, and the object store — cannot decrypt anything the user stores.

The database URL is not a secret. `db_path` is unguessable, but access control rests entirely on the token, and every token expires in 60 minutes.

---

## 9. Build order

1. Firebase ID token verification with cached signing keys, including the negative cases: expired, wrong audience, wrong issuer, tampered signature.
2. The `ctl` query and the mint call, against an administrator-created user row.
3. The unprovisioned path: valid Firebase token, no `users` row or a `NULL` `db_path`, 403, and nothing written anywhere.
4. KV caching and the per-uid rate limits.
5. Rotation and deprovisioning runbooks.
