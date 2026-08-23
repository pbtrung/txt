# Fastly Compute authentication and API contract

Fastly Compute is the only public API origin and the only runtime component
that calls Cosmos DB. Owner requests follow one path:

```text
Firebase ID token -> Fastly Compute route -> signed Cosmos REST request
```

Fastly exposes application operations, not Cosmos operations. There is no route
that accepts an arbitrary database, container, partition, resource link, query,
method, or Cosmos authorization value.

## Firebase ID-token validation

Every owner route requires `Authorization: Bearer <Firebase ID token>`. Fastly
must verify the token before reading a secret or calling Cosmos/R2:

1. require a compact JWT of bounded length and `alg = RS256`;
2. select `kid` only from Google's current Firebase signing certificates;
3. verify the signature;
4. require `aud = FIREBASE_PROJECT_ID`;
5. require `iss = https://securetoken.google.com/{FIREBASE_PROJECT_ID}`;
6. validate `exp`, `iat`, and nonempty `sub` against current time with a small,
   documented clock-skew allowance; and
7. constant-time compare `sub` with `OWNER_FIREBASE_UID`.

Cache Google's signing keys only according to the upstream `Cache-Control`
response and refetch once for an unknown `kid`; never accept a stale key beyond
its allowed lifetime merely because the fetch failed. Reject custom Firebase
tokens: the API accepts only ID tokens produced after Firebase sign-in. The
claim rules and certificate endpoint are defined in Firebase's official
[ID-token verification guide](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

Fastly does not issue an owner ticket, application session, Cosmos resource
token, or refresh token. The Firebase client SDK refreshes the ID token, and the
browser retries one idempotent request after refresh on a Fastly 401.

## Possession proof

A valid Firebase token proves who is asking; it does not prove the caller
currently holds the unwrapped signing key that only exists after a correct
`user_root_key` unlock. Every route in the following table additionally
requires the per-request P-521 possession proof defined in
[cryptography.md](cryptography.md):

| Route                          | Proof required |
| ------------------------------- | --------------- |
| `POST /v1/keys`                 | no |
| `GET /v1/vault/head`            | no |
| `GET /v1/vault/books/{book_id}` | no |
| `GET /v1/vault/books?cursor=...`| no |
| `POST /v1/vault/commit`         | yes |
| `PUT /v1/vault/books/{book_id}` | yes |
| `POST /v1/r2-token`             | yes |
| `POST /v1/shares`               | yes |
| `DELETE /v1/shares`             | yes |
| `POST /v1/shared-url`           | no (unauthenticated; capability is the authorization) |

Reads are exempt because they return ciphertext only — a bearer-token-only
compromise cannot recover plaintext through them. Every route that mutates
durable owner state or hands out direct R2 access requires the proof, because
those operations do not depend on breaking encryption to cause damage (book
deletion, share revocation, catalog-head corruption, raw-storage credential
minting), so a stolen bearer token alone must not be sufficient. A request
missing, failing, or replaying a required proof is rejected before any Cosmos
or R2 work; see the error contract below.

## Common requirements

- Accept HTTPS only and allow only the configured exact UI origin in CORS. Do
  not use `*` with credential-bearing requests.
- Allow only the documented methods, paths, content types, and headers. Reject
  encoded path separators and normalize route parameters before validation.
- Limit JSON body size, reject duplicate keys, validate canonical base64url,
  validate `_etag` syntax as an opaque bounded string, and reject unknown fields.
- Return `Cache-Control: private, no-store` and `Vary: Origin, Authorization` on
  authenticated responses. Never allow Fastly cache lookup or storage for API
  routes, even when a Cosmos response happens to be cacheable.
- Never put credentials in query strings. Redact authorization headers, request
  bodies, Cosmos authorization/date headers, ciphertext, grants, R2
  credentials, signatures, and signed URLs from logs.
- Apply a subject-independent flood control (normalized client IP or a global
  counter) before spending CPU on Firebase signature verification or any other
  expensive cryptography. Apply the route's durable, **owner-subject-keyed**
  rate limit only after the Firebase token has been fully verified — never key
  a rate-limit bucket by an unverified token claim, or an attacker holding no
  valid token can exhaust the real owner's budget with forged-signature
  requests and lock them out. Fail closed if either limiter cannot decide.
- Give each outbound fetch a bounded timeout. Retry at most once for a safe
  point read and only according to the operation's idempotency rules.
- Pass Cosmos 429 `x-ms-retry-after-ms` semantics to the caller as a bounded
  `Retry-After`; do not create an unbounded edge retry loop.

## Cosmos REST signing and containment

Fastly reads `COSMOS_ACCOUNT_KEY` from a linked Secret Store and constructs the
Cosmos master-key authorization signature from the lowercase verb, resource
type, trusted resource link, and lowercase RFC 1123 `x-ms-date`. The signature
is HMAC-SHA-256 with the base64-decoded account key and is percent-encoded in
the `Authorization` header. Follow Azure's
[Cosmos REST access-control contract](https://learn.microsoft.com/en-us/rest/api/cosmos-db/access-control-on-cosmosdb-resources)
exactly and pin a supported `x-ms-version` in configuration and tests.

For every route, Fastly:

- selects the backend, database ID, container ID, and resource link from trusted
  configuration;
- injects the configured `OWNER_PK` or fixed control partition;
- builds the method and request body itself from allowlisted application fields;
- strips all client `x-ms-*`, `Authorization`, `Host`, forwarding, and backend
  selection headers before the origin request;
- checks Cosmos status, content type, response size, and required fields; and
- returns only the documented application response and selected concurrency or
  throttling metadata.

The browser must never see the Cosmos endpoint, authorization signature,
request charge, activity ID, resource link, account key, or raw error body.

## `POST /v1/keys`

Purpose: authenticate the owner and return wrapped bootstrap material.

Request:

```json
{
  "protocol_version": 3
}
```

Fastly validates Firebase, consumes `owner-keys`, then point-reads ID `owner`
with configured partition `OWNER_PK` from `owner_control`. It checks the stored
UID and supported schema before returning:

```json
{
  "protocol_version": 3,
  "uid": "Firebase subject",
  "owner_pk": "own_opaqueRandomValue",
  "vault_id": "vault_opaqueRandomValue",
  "user_handle_hash": "base64url",
  "vault_binding_hash": "base64url",
  "wrapped_user_master_key": "base64url",
  "kem_public_key": "base64url",
  "wrapped_kem_private_key": "base64url",
  "sign_version": 1,
  "sign_algorithm": "ECDSA-P521-SHA512",
  "sign_public_key": "base64url",
  "wrapped_sign_private_key": "base64url",
  "encrypted_credentials": "base64url"
}
```

The browser requires equality among the Firebase UID, response UID, decrypted
credential binding, and unlock identity before accepting a key. Fastly returns
values from one `_etag`-consistent point read and exposes neither the control
item `_etag` nor any Cosmos system property.

## Vault read routes

All vault routes require Firebase authentication. Fastly always injects
`OWNER_PK` and the configured `vault` container.

### `GET /v1/vault/head`

Point-read `catalog-head`. Return the allowlisted head fields from
[data_model.md](data_model.md) plus:

```json
{
  "etag": "opaque Cosmos _etag"
}
```

### `GET /v1/vault/books/{book_id}`

Validate the opaque ID and point-read that book item and its paired catalog
item (`catalog_` + the book ID's opaque suffix) as one logical read. Require
`kind = book`/`kind = catalog` respectively, the supported schema, and the
configured owner partition on each. Return both outer encrypted items plus
their `etag`s; do not inspect or transform either ciphertext.

### `GET /v1/vault/books?cursor=...`

This fixed, owner-only scan exists solely for snapshot repair and administrative
verification. Fastly issues the predefined `kind IN ("book", "catalog")` query
scoped to `OWNER_PK`, enforces a page-size and total-item ceiling, and wraps
Cosmos continuation state in an authenticated opaque cursor. It never accepts
query text, query parameters other than that cursor, cross-partition mode, or
an index-policy override from the client. This route consumes the dedicated
`owner-vault-scan` budget below, not `owner-vault-read`: it is a container
query, not a point read, and is materially more expensive per call.

## Vault write routes

Fastly validates only the outer encrypted record, version, identifier, sizes,
and transition shape; it cannot validate encrypted user fields. All accepted
writes must use a current `_etag` unless they are create-only. These routes
require the possession proof described above.

### `POST /v1/vault/commit`

Purpose: atomically update a book's identity (content/shares via its `book`
item, catalog via its paired `catalog` item) and `catalog-head` after the new
immutable R2 snapshot has been uploaded.

Request shape:

```json
{
  "protocol_version": 3,
  "possession_proof": {
    "route": "vault-commit",
    "nonce": "base64url 32 bytes",
    "expires_at": 0,
    "signature": "base64url raw P-521 signature"
  },
  "book": {
    "operation": "create | replace | delete",
    "id": "book_K7c3...",
    "etag": "required for replace/delete",
    "item": "required for create/replace; exact encrypted outer item"
  },
  "catalog": {
    "operation": "create | replace | delete",
    "id": "catalog_K7c3...",
    "etag": "required for replace/delete",
    "item": "required for create/replace; exact encrypted outer item"
  },
  "head": {
    "etag": "current head etag",
    "item": "next catalog-head outer item"
  }
}
```

`book` and `catalog` operations are independent — a catalog metadata edit
sends only a `catalog` replace, no `book` operation at all, and vice versa for
a share create/delete or content-locator change. `head` is optional: it is
included only when the mutation changes anything the snapshot projects
(ingest, catalog edit, delete, share state change), and omitted for
book-only content-locator changes, which never touch the snapshot. Fastly
rejects unexpected outer fields, overwrites neither identity nor version
silently, and requires:

- the possession proof verifies for `route: "vault-commit"` and has not been
  seen before (see [cryptography.md](cryptography.md));
- for each of `book`/`catalog` present: the path/body IDs agree, `owner_pk`
  equals configured `OWNER_PK`, kind/schema/size satisfy
  [data_model.md](data_model.md), create has no `_etag` and uses create-only
  semantics, and replace/delete carry the previous `_etag`;
- when both `book` and `catalog` are present, their IDs correlate (`catalog_`
  + the book ID's opaque suffix) and their operations agree (both `create`,
  or both `delete` — a book cannot be created without its catalog pairing, or
  deleted while its catalog pairing survives);
- when `head` is present: the new generation is exactly one greater than the
  current generation, head owner/kind/schema and R2 object-key grammar are
  exact, **and a direct R2 `HEAD` on `head.item.object_key` returns a
  `Content-Length` equal to `ciphertext_bytes` and (where the object carries a
  server-side checksum) a checksum equal to `ciphertext_sha256`** — Fastly
  must not advance the pointer on the strength of client-supplied metadata
  alone; and
- every book/catalog/head operation present targets the same owner partition.

Fastly sends one atomic Cosmos REST transactional batch covering every
`book`/`catalog`/`head` operation present (at most three operations, well
within Cosmos batch limits). Cosmos supports atomic batches for operations
sharing a logical partition; see the official
[transactional batch REST contract](https://learn.microsoft.com/en-us/rest/api/cosmos-db/transactional-batch).
On success Fastly returns the new allowlisted book/catalog/head `_etag` values.
A failed precondition returns the stable conflict response and no partial
success. If the R2 `HEAD` check fails, Fastly returns `409 conflict` without
attempting the Cosmos batch at all — from the browser's perspective this looks
like any other precondition failure, and the standard conflict-replay flow in
[catalog.md](catalog.md) applies (re-verify the upload landed, or re-upload,
then retry).

Replacing a book's content (a new EPUB superseding an existing catalog entry)
is **not** expressed as a `replace` on the existing `book_id`: doing so would
let a new, unrelated document silently reuse CFIs and bookmarks that were
computed against the old content. It is instead a `delete` of the old
`book_id`/`catalog_id`/reading-state/index-entry (blocked, as always, while
`shares` is non-empty) followed by an ordinary `create` of a new `book_id`.
These are two independent `/v1/vault/commit` calls, each with its own
generation bump, not one atomic operation — Cosmos transactional batches are
scoped to one partition's items in one request, but the pair of book+catalog
"identities" being fully replaced (not merely mutated) is a two-step,
non-atomic sequence by construction. A crash between the two calls leaves the
library either missing that title or, if delete failed to commit, still
showing the old content; neither state loses data (the failed step is simply
retried) and neither needs special repair handling, unlike an R2 upload that
raced ahead of its Cosmos commit.

### `PUT /v1/vault/books/{book_id}`

Purpose: replace one encrypted `book` item — for example, a content-locator or
share-state change that does not affect the paired catalog item or the
snapshot. The request contains `protocol_version`, the possession proof,
previous `etag`, and the complete next encrypted outer book item. Fastly
applies the same identity/schema/size checks and a conditional replace. It
cannot be used to create, delete, change owner partition, touch the catalog
item, or write `catalog-head`.

There is no general create/delete/upsert endpoint. Book/catalog create/delete
occurs only through `/v1/vault/commit`, preserving their atomicity.

## `POST /v1/r2-token`

Purpose: return short-lived direct R2 access for owner object reads —
including EPUB content, the catalog snapshot, and the per-book reading-state
and reading-index objects — plus immutable uploads and cleanup, all under one
prefix. The request contains `protocol_version`, the possession proof, and the
locally decrypted `vault_id`, `owner_pk`, and `db_prefix` binding.

Fastly validates Firebase, verifies the possession proof for
`route: "r2-token"`, consumes `owner-r2-token`, point-reads `owner_control`,
hashes and compares the binding, and asks R2 for a 900-second temporary
credential limited to the configured bucket and normalized `{db_prefix}/`. It
returns only:

```json
{
  "protocol_version": 3,
  "expires_at": "2026-08-23T00:15:00.000Z",
  "r2": {
    "endpoint": "https://account.r2.cloudflarestorage.com",
    "bucket": "configured bucket",
    "prefix": "{db_prefix}/",
    "access_key_id": "temporary access key",
    "secret_access_key": "temporary secret",
    "session_token": "temporary session token"
  }
}
```

No Cosmos field or credential is present. The browser hard-codes the expected
R2 endpoint/bucket/prefix, keeps the response in memory, and refreshes at most
once near expiry or after one authorization failure. Cloudflare documents the
credential mechanism at [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).

Reading-state and reading-index reads/writes never go through a Fastly vault
route: they are plain R2 requests against this credential, conditionally
written with `If-Match`/`If-None-Match` exactly like EPUB content. Fastly's
only role in that path is minting the credential above.

## `POST /v1/shares`

Purpose: register an uploaded independent share object or return a fresh grant
for an identical active registration.

The Firebase-authenticated request carries protocol version, the possession
proof (`route: "share-create"`), owner/vault binding, raw share ID, and
rendered share prefix/path. Fastly consumes `owner-share-write`, validates the
binding against `owner_control`, constructs and normalizes exactly:

```text
{db_prefix}/shared/{share_prefix}/{share_path}
```

It hashes the identifiers, checks that the immutable R2 object exists, and
attempts to create the share plus path reservation in one server-only
`share_control` transactional batch using create-only operations. If that
create fails because a `share:{share_id_hash}` item already exists, Fastly
point-reads the existing share and reservation items: identical
`object_path_hash` on both is the idempotent-retry case (return a fresh grant,
no write); anything else is `409`. See [data_model.md](data_model.md) for the
exact reconciliation rule.

```json
{
  "registered": true,
  "grant": "<base64url grant envelope, see cryptography.md>"
}
```

## `DELETE /v1/shares`

Purpose: revoke one owner share and delete its R2 object.

The Firebase-authenticated request contains protocol version, the possession
proof (`route: "share-delete"`), owner/vault binding, raw share ID, and
rendered share prefix/path. Fastly reconstructs the exact key, recomputes
every hash, and requires agreement with the registry. It:

1. conditionally changes `active` to `deleting`;
2. deletes the exact R2 object, treating not-found as success on retry; and
3. transactionally deletes the share and path-reservation items.

An already absent matching share is an idempotent 204. A mismatched identity or
path is not treated as absent. A `deleting` item never authorizes a new URL.

## `POST /v1/shared-url`

Purpose: exchange an anonymous capability for a 60-second exact-object R2 GET
URL. No Firebase authentication or possession proof is used — a public
recipient has neither. The bounded request carries only protocol version, raw
share ID, and current encrypted grant. Fastly:

1. consumes `public-share-url` by privacy-preserving client-IP hash;
2. verifies and decrypts the grant;
3. point-reads the share-ID hash from `share_control`;
4. requires `active`, a matching object-path hash, and normalized path; and
5. creates a 60-second URL allowing GET for exactly that object.

The response is `Cache-Control: private, no-store` and contains no owner prefix,
Cosmos information, or R2 list permission. Revocation affects the next exchange;
an issued URL remains usable only for its short lifetime.

## Health endpoints

- `/health/live` confirms that the deployed Compute package can serve requests.
- `/health/ready` reads required config/secret entries and point-reads the
  `schema:*` marker item from the `system` partition of all four containers
  (see [data_model.md](data_model.md)). It must not write, query user data, or
  mint R2 credentials.
- Health responses reveal no account, container, owner, bucket, key, generation,
  or schema values.

Readiness fails if rqlite/Northflank configuration is still required, the
Cosmos backend TLS identity differs from configuration, or a client-supplied
resource link can influence an origin request.

## Rate limits

| Scope                | Limit            | Subject              |
| --------------------- | ---------------- | --------------------- |
| `owner-keys`          | 60 per hour      | owner UID            |
| `owner-r2-token`      | 30 per hour      | owner UID            |
| `owner-vault-read`    | 1,200 per minute | owner UID            |
| `owner-vault-scan`    | 12 per hour      | owner UID            |
| `owner-vault-write`   | 600 per hour     | owner UID            |
| `owner-share-write`   | 120 per hour     | owner UID            |
| `public-share-url`    | 120 per minute   | normalized client IP |

`owner-vault-scan` covers `GET /v1/vault/books?cursor=...` only — the
administrative repair/verification scan — deliberately far tighter than
`owner-vault-read`'s point-read budget, since each call is a container query
over the whole owner partition and repeatedly triggering it is a realistic way
to burn the shared free-tier RU budget.

Subject identifiers are HMAC-SHA-256 with `RATE_LIMIT_KEY`; store only the
digest in `rate_limit_control`, and only ever compute it from a **verified**
Firebase subject or a normalized client IP, per the ordering rule in Common
requirements above. Preliminary edge rejection may shed obvious floods, but the
Cosmos counter is authoritative across POPs and restarts.

## Error contract

| HTTP | Code                  | Meaning                                                                            |
| ---- | --------------------- | ---------------------------------------------------------------------------------- |
| 400  | `invalid_request`     | Invalid route shape, encoding, item, or protocol version                           |
| 401  | `unauthorized`        | Missing, invalid, expired, or wrong-owner Firebase token; invalid share capability; missing, invalid, expired, wrong-route, or replayed possession proof |
| 403  | `binding_mismatch`    | Authenticated identity does not match owner/vault binding                          |
| 404  | `not_found`           | Item absent, or public share absent/inactive without state disclosure              |
| 409  | `conflict`            | `_etag` mismatch, share/path collision, incompatible state transition, or a `/v1/vault/commit` head whose R2 object failed existence/length/hash verification |
| 413  | `too_large`           | Request, ciphertext item, or page exceeds its fixed limit                          |
| 429  | `rate_limited`        | Fastly/Cosmos limit exceeded; include bounded `Retry-After`                        |
| 502  | `upstream_invalid`    | Cosmos/R2 returned an invalid or unsupported response                              |
| 503  | `control_unavailable` | Firebase keys, Cosmos, limiter, secret, or R2 broker unavailable                   |

Detailed causes belong only in redacted structured telemetry. Never reflect a
Cosmos, Firebase-certificate, Secret Store, or R2 provider response body.

## Fastly resource configuration

Store nonsecret routing/configuration in a linked Fastly Config Store:

```text
FIREBASE_PROJECT_ID
OWNER_FIREBASE_UID
UI_ORIGIN
COSMOS_ENDPOINT_HOST
COSMOS_DATABASE_ID
COSMOS_OWNER_CONTROL_CONTAINER_ID
COSMOS_SHARE_CONTROL_CONTAINER_ID
COSMOS_RATE_LIMIT_CONTROL_CONTAINER_ID
COSMOS_VAULT_CONTAINER_ID
COSMOS_API_VERSION
OWNER_PK
R2_ENDPOINT
R2_BUCKET
```

Store secret values only in a linked Fastly Secret Store:

```text
COSMOS_ACCOUNT_KEY
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
SHARE_GRANT_KEY
RATE_LIMIT_KEY
```

`sign_public_key` used to verify possession proofs is not a secret — it is
read directly from the `owner_control` item, not from Secret Store.

Read only the secrets needed by the selected route and stay within Fastly
Secret Store per-request limits. Remove `RQLITE_*`, Northflank, OpenResty,
operator-proxy, persistent-volume, `COSMOS_BROWSER_*`, owner-ticket, and
resource-token configuration after rollback retention. Never reuse the Cosmos
account key as an application HMAC or encryption key.

Config and Secret Stores are versionless: an item update affects linked active
services without a Compute deploy. Keep reviewed desired values in deployment
configuration and use named replacement entries plus smoke tests for sensitive
changes. See Fastly's [Config Store guide](https://www.fastly.com/documentation/guides/compute/edge-data-storage/working-with-config-stores/).
