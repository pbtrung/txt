# Authentication and Authorization — Design

There is exactly one authenticated principal: the owner. Firebase proves the
owner's identity, and the API accepts a token only when its verified `sub`
equals `OWNER_FIREBASE_UID`. A valid Firebase token for any other UID receives
`403`; there is no code path that creates a second account.

Anonymous recipients are not accounts. They can only redeem an owner-created
share capability for a short-lived read URL as described in `docs/sharing.md`.

## 1. API configuration

| Name                                                             | Purpose                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `OWNER_FIREBASE_UID`                                             | The only Firebase UID allowed to unlock or mutate the library                               |
| `FIREBASE_PROJECT_ID`                                            | Expected Firebase issuer and audience                                                       |
| `R2_TICKET_SECRET`                                               | At least 32 random bytes in padded standard base64, used only for owner binding tickets     |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION`                          | S3-compatible R2 destination                                                                |
| `R2_READ_WRITE_ACCESS_KEY_ID`, `R2_READ_WRITE_SECRET_ACCESS_KEY` | Server-held parent key used to mint owner credentials and presign exact shared-object reads |
| `RATE_LIMIT_KEY`                                                 | Independent 32-byte secret used to hash rate-limit subjects such as client addresses        |
| `UI_ORIGIN`                                                      | Exact browser origin accepted by the API and operator-proxy CORS                            |

OpenResty and rqlite run in the same container. Lua connects only to
`http://127.0.0.1:14001`, so there is no application-side `RQLITE_URL`,
`RQLITE_USERNAME`, or `RQLITE_PASSWORD`. `RQLITE_ADMIN_USERNAME` and
`RQLITE_ADMIN_PASSWORD` protect the separate operator passthrough used for
migrations, recovery, and the owner UI's wrapped-key read. The Python CLI calls
that passthrough through `rqlite_operator_url`; the UI calls the same route
through its `rqlite_db_url`. Both normally equal
`https://<public-service-domain>/operator/rqlite`.

The operator credentials are high-value owner secrets. They appear in the
owner-only unlock file, stay in browser page memory, and are never persisted by
the application. Exact-origin CORS prevents another browser origin from reading
operator responses, but it does not replace Basic authentication for
non-browser clients.

`R2_TICKET_SECRET`, `RATE_LIMIT_KEY`, and the R2 secret access key are independent
secrets. The API service holds them; the browser never does. Secret rotation is
covered in §7.

The rqlite schema and access rules are in `docs/control_database.md`. The API
never connects directly to rqlite's SQLite file.

## 2. Singleton owner record

The `owner_control` table contains exactly one row with `singleton = 1`. It
stores the configured Firebase UID, wrapped key material, the hash of the
owner's private handle, the binding of the two R2 paths, and the public half of
the P-521 signing key. It contains no role or account-type column.

The encrypted credential payload has this shape:

```json
{
  "user_handle": "<base64 32 bytes>",
  "display_name": "...",
  "db_master_key": "<base64 256 bytes>",
  "db_path": "<52-character token>",
  "db_prefix": "<52-character token>"
}
```

`db_path` and `db_prefix` are independent 32-byte random values rendered as 52
lowercase base32-Crockford characters. rqlite stores only
`SHA-512(UTF8(db_path) || UTF8(db_prefix))`; both source strings have fixed
validated lengths. The raw `user_handle`, paths, database key, unwrapped owner
master key, and unwrapped signing private key exist only in the provisioning
process or unlocked browser memory.

## 3. Provisioning

`txt --init-owner rqlite_creds.json` is idempotent and performs these operations:

1. Sign in to Firebase and use the resulting UID as the singleton owner's
   identity. Deployment verification requires it to equal
   `OWNER_FIREBASE_UID`.
2. Query rqlite through `rqlite_operator_url`; if the database is empty, install
   control schema version 1 in one transaction.
3. Generate a 32-byte `user_handle`, independent `db_path` and `db_prefix`, a
   128-byte owner master key, and a 256-byte SQLCipher `db_master_key`.
4. Generate the P-521 request-signing key pair and the composite KEM key pair
   described in `docs/crypto.md`.
5. Wrap the owner master key with `user_root_key`; wrap both private keys with
   the owner master key; encrypt the credential payload with that same key.
6. Insert the singleton `owner_control` row through
   `/db/execute?transaction` using parameterized statements.

Re-running provisioning verifies the UID, handle/path bindings, KEM sizes, and
P-521 keypair without replacing any owner material. If `owner_control` already
contains a different UID or incompatible material, provisioning aborts.

To preserve an existing Turso library identity, run:

```sh
txt --migrate turso_creds.json rqlite_creds.json --verbose --dry-run
txt --migrate turso_creds.json rqlite_creds.json --verbose
```

The source and destination Firebase logins must resolve to the same UID. The
command validates and decrypts the source owner record, preserves the complete
credential payload—including `db_master_key`, `db_path`, and `db_prefix`—and
encrypts it under the rqlite owner's UMK. With no destination row it performs
owner initialization and generates a fresh UMK, composite KEM keypair, and
P-521 signing keypair. With an existing destination row it preserves that UMK
and those keypairs. The dry run performs authentication and validation but
writes neither rqlite nor the destination credential file.

There is no owner list, invitation, deprovisioning workflow, delegated access,
or recovery copy belonging to another account. Recovery requires the owner's
credential file, its `user_root_key`, the rqlite backup, and the R2 objects.

The browser unlock file contains only these seven fields:

```json
{
  "rqlite_admin_username": "operator",
  "rqlite_admin_password": "...",
  "rqlite_db_url": "https://api.example.com/operator/rqlite",
  "firebase_email": "owner@example.com",
  "firebase_password": "...",
  "firebase_api_key": "...",
  "user_root_key": "<padded standard base64>"
}
```

It contains no R2 parent key, account type, or user-management data. The display
name and private R2 paths come from the encrypted singleton payload.

## 4. Endpoints

OpenResty requires the browser `Origin` to equal `UI_ORIGIN` before any
`/v1/*` Lua handler runs. A missing or different origin receives `403`. The
operator proxy instead uses exact-origin CORS so Basic-authenticated CLI clients
can operate without an `Origin` header.

### 4.1 `POST /v1/keys`

```http
POST /v1/keys
Authorization: Bearer <Firebase ID token>
```

The API verifies the token signature, issuer, audience, expiry, and subject. It
then requires the subject to equal both `OWNER_FIREBASE_UID` and the singleton
row's `firebase_uid`. A parameterized rqlite query returns the wrapped material.

```json
{
  "uid": "<owner Firebase uid>",
  "umk": "<base64 wrapped owner master key>",
  "signing": {
    "version": 1,
    "algorithm": "ECDSA-P521-SHA512",
    "private_key": "<base64 wrapped PKCS#8 private key>"
  },
  "credentials": "<base64 encrypted credential payload>",
  "r2_ticket": "<compact API-signed JWS>"
}
```

The 24-hour HS256 ticket contains:

```json
{
  "v": 2,
  "aud": "r2-token",
  "sub": "<owner Firebase uid>",
  "jti": "<base64url 32 random bytes>",
  "user_handle_hash": "<base64url SHA-256(handle)>",
  "sign_version": 1,
  "sign_algorithm": "ECDSA-P521-SHA512",
  "sign_public_key": "<base64url SPKI DER>",
  "db_binding_hash": "<base64url SHA-512(path pair)>",
  "iat": 0,
  "exp": 0
}
```

There is no role claim: any valid ticket is necessarily for the configured
owner. The current browser uses the response's `uid` and `r2_ticket`; it reads
the wrapped blobs directly through the operator proxy and requires the Firebase
UID, rqlite row UID, and API response UID to be identical. The API response
retains the wrapped fields for protocol completeness. The browser keeps the
ticket only in unlocked memory.

| Status | Condition                                  |
| ------ | ------------------------------------------ |
| `200`  | Wrapped owner material and ticket returned |
| `401`  | Firebase token missing or invalid          |
| `403`  | Verified UID is not the configured owner   |
| `429`  | Owner unlock budget exceeded               |
| `503`  | rqlite or ticket signing unavailable       |

### 4.2 `POST /v1/r2-token`

This endpoint uses the owner binding ticket and a fresh proof instead of a new
Firebase token:

```json
{
  "ticket": "<exact compact JWS returned by /v1/keys>",
  "user_handle": "<base64 32 bytes>",
  "db_path": "<decrypted owner path>",
  "db_prefix": "<decrypted owner prefix>",
  "proof": {
    "version": 2,
    "expires_at": 0,
    "request_id": "<base64 32 random bytes>",
    "signature": "<base64 raw P-521 signature>"
  }
}
```

The API verifies the ticket, exact owner subject, handle hash, path binding,
proof expiry, and P-521 signature. It then mints two 15-minute credentials:

- read-write access to the exact `db_path` object;
- read-write access below `{db_prefix}/`, including owner EPUBs and shared
  copies.

The endpoint does not query rqlite for authorization because the signed ticket
already authenticates the singleton record. It does use rqlite for its durable
rate counter.

| Status | Condition                                            |
| ------ | ---------------------------------------------------- |
| `200`  | Exact-object and prefix credentials returned         |
| `400`  | Malformed ticket envelope, handle, path, or proof    |
| `401`  | Ticket invalid or expired                            |
| `403`  | Owner subject, binding, suite, or signature mismatch |
| `429`  | R2-token budget exceeded                             |
| `503`  | R2 signing or rqlite rate limiting unavailable       |

## 5. Owner session

1. The owner selects the seven-field unlock file. The browser validates that
   `rqlite_db_url` is the HTTPS `/operator/rqlite` route, with localhost HTTP
   allowed for development.
2. The browser signs in to Firebase. In parallel, it queries the singleton
   wrapped-key row through the Basic-auth operator proxy and calls `/v1/keys`
   for an owner binding ticket.
3. Unlock stops unless the Firebase UID, rqlite row UID, and API UID are equal.
4. The browser unwraps the owner master key, credential payload, and P-521
   private key entirely in memory.
5. The browser signs a short-lived proof over the exact ticket, handle, and R2
   paths and calls `/v1/r2-token`.
6. The API returns 15-minute scoped R2 credentials. The browser renews them with
   the same ticket until its fixed expiry, then obtains a new ticket through
   Firebase.
7. Locking or reloading releases the unlock credentials, plaintext keys, paths,
   tickets, and temporary R2 credentials from the application session.

## 6. Rate limits

Rate-limit state is stored in rqlite, not process memory, so restarts do not
reset it. The schema uses `(scope, subject_hash, window_start)` as its key. The
API derives `subject_hash = HMAC-SHA-256(RATE_LIMIT_KEY, canonical subject)` and
never stores a raw client address.

Initial budgets are:

| Scope               |                                     Budget |
| ------------------- | -----------------------------------------: |
| `owner-keys`        |             60 requests per owner per hour |
| `owner-r2-token`    |      120 valid requests per owner per hour |
| `owner-share-write` |            120 requests per owner per hour |
| `public-share-url`  | 120 requests per source address per minute |

An atomic rqlite transaction increments and reads the counter. If rqlite is
unavailable, protected endpoints fail closed with `503`; they do not bypass the
limit. Old windows are deleted opportunistically and by a scheduled maintenance
job.

## 7. Expiration and incident response

| Event                           | Response                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Firebase session revoked        | New `/v1/keys` calls fail; an existing binding ticket remains valid until its fixed expiry    |
| Signing private key exposed     | Re-provision the signing key and rotate `R2_TICKET_SECRET` so existing tickets stop verifying |
| `R2_TICKET_SECRET` exposed      | Rotate it and redeploy; every outstanding ticket becomes invalid                              |
| Temporary R2 credential exposed | It expires after at most 15 minutes                                                           |
| Parent R2 credential exposed    | Rotate it immediately and redeploy; already-issued temporary credentials expire naturally     |
| `RATE_LIMIT_KEY` exposed        | Rotate it; existing counter rows become unreachable and may be deleted                        |
| Owner root key lost             | Restore from the protected owner credential backup; the server cannot reconstruct it          |

## 8. Trust boundary

The unlocked browser and the Northflank API are trusted. rqlite is trusted for
authorization state and durability, but it receives only wrapped or encrypted
owner key material, hashes, object paths for active shares, and counters. R2 is
trusted for object durability but not plaintext confidentiality.

The API holds Firebase verification configuration, signing secrets, and the
parent R2 key. Lua reaches rqlite only through its loopback listener and needs no
rqlite password. The owner browser holds the operator Basic credentials and
`user_root_key` only for the unlocked page session. The API does not hold
`user_root_key`, plaintext EPUB content, the SQLCipher key, the raw private
handle, an unwrapped owner master key, or any share content key. A compromised
API can authorize R2 access and is therefore inside the trusted computing base;
a copied rqlite backup alone cannot decrypt the library.
