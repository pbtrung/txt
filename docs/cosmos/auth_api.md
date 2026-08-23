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
  credentials, and signed URLs from logs.
- Apply the route's durable rate limit before expensive cryptography, Cosmos
  work, or R2 credential minting. Fail closed if the limiter cannot decide.
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

Validate the opaque ID and point-read exactly that book. Require `kind = book`,
the supported schema, and the configured owner partition. Return the outer
encrypted item plus `etag`; do not inspect or transform ciphertext.

### `GET /v1/vault/books?cursor=...`

This fixed, owner-only scan exists solely for snapshot repair and administrative
verification. Fastly issues the predefined `kind = "book"` query scoped to
`OWNER_PK`, enforces a page-size and total-item ceiling, and wraps Cosmos
continuation state in an authenticated opaque cursor. It never accepts query
text, query parameters other than that cursor, cross-partition mode, or an
index-policy override from the client.

## Vault write routes

Fastly validates only the outer encrypted record, version, identifier, sizes,
and transition shape; it cannot validate encrypted user fields. All accepted
writes must use a current `_etag` unless they are create-only.

### `POST /v1/vault/commit`

Purpose: atomically update one book and `catalog-head` after the new immutable
R2 snapshot has been uploaded.

Request shape:

```json
{
  "protocol_version": 3,
  "book": {
    "operation": "create | replace | delete",
    "id": "book_K7c3...",
    "etag": "required for replace/delete",
    "item": "required for create/replace; exact encrypted outer item"
  },
  "head": {
    "etag": "current head etag",
    "item": "next catalog-head outer item"
  }
}
```

Fastly rejects unexpected outer fields, overwrites neither identity nor version
silently, and requires:

- the path/body book IDs agree;
- `owner_pk` equals configured `OWNER_PK`;
- book kind/schema/size satisfy [data_model.md](data_model.md);
- create has no `_etag` and uses create-only semantics;
- replace/delete carry the previous `_etag`;
- the new head generation is exactly one greater than the current generation;
- head owner/kind/schema and R2 object-key grammar are exact; and
- one book operation and one head replacement target the same owner partition.

Fastly sends one atomic Cosmos REST transactional batch. Cosmos supports atomic
batches for operations sharing a logical partition; see the official
[transactional batch REST contract](https://learn.microsoft.com/en-us/rest/api/cosmos-db/transactional-batch).
On success Fastly returns the new allowlisted book/head `_etag` values. A failed
precondition returns the stable conflict response and no partial success.

### `PUT /v1/vault/books/{book_id}`

Purpose: replace one encrypted book for a mutation such as `last_cfi` that does
not change the snapshot. The request contains `protocol_version`, previous
`etag`, and the complete next encrypted outer book item. Fastly applies the
same identity/schema/size checks and a conditional replace. It cannot be used
to create, delete, change owner partition, or write `catalog-head`.

There is no general create/delete/upsert endpoint. Book create/delete occurs
only through `/v1/vault/commit`, preserving book/head atomicity.

## `POST /v1/r2-token`

Purpose: return short-lived direct R2 access for owner object reads, immutable
uploads, and cleanup under one prefix. The request contains `protocol_version`
and the locally decrypted `vault_id`, `owner_pk`, and `db_prefix` binding.

Fastly validates Firebase, consumes `owner-r2-token`, point-reads
`owner_control`, hashes and compares the binding, and asks R2 for a 900-second
temporary credential limited to the configured bucket and normalized
`{db_prefix}/`. It returns only:

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

## `POST /v1/shares`

Purpose: register an uploaded independent share object or return a fresh grant
for an identical active registration.

The Firebase-authenticated request carries protocol version, owner/vault
binding, raw share ID, and rendered share prefix/path. Fastly consumes
`owner-share-write`, validates the binding against `owner_control`, constructs
and normalizes exactly:

```text
{db_prefix}/shared/{share_prefix}/{share_path}
```

It hashes the identifiers, checks that the immutable R2 object exists, and
creates the share plus path reservation in one server-only `share_control`
transactional batch. An identical active retry is idempotent and returns a
fresh authenticated grant. Any conflicting ID/path pairing returns 409.

## `DELETE /v1/shares`

Purpose: revoke one owner share and delete its R2 object.

The Firebase-authenticated request contains protocol version, owner/vault
binding, raw share ID, and rendered share prefix/path. Fastly reconstructs the
exact key, recomputes every hash, and requires agreement with the registry. It:

1. conditionally changes `active` to `deleting`;
2. deletes the exact R2 object, treating not-found as success on retry; and
3. transactionally deletes the share and path-reservation items.

An already absent matching share is an idempotent 204. A mismatched identity or
path is not treated as absent. A `deleting` item never authorizes a new URL.

## `POST /v1/shared-url`

Purpose: exchange an anonymous capability for a 60-second exact-object R2 GET
URL. No Firebase authentication is used. The bounded request carries only
protocol version, raw share ID, and current encrypted grant. Fastly:

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
- `/health/ready` reads required config/secret entries and point-reads fixed
  schema markers from all four containers. It must not write, query user data,
  or mint R2 credentials.
- Health responses reveal no account, container, owner, bucket, key, generation,
  or schema values.

Readiness fails if rqlite/Northflank configuration is still required, the
Cosmos backend TLS identity differs from configuration, or a client-supplied
resource link can influence an origin request.

## Rate limits

| Scope               | Limit            | Subject              |
| ------------------- | ---------------- | -------------------- |
| `owner-keys`        | 60 per hour      | owner UID            |
| `owner-r2-token`    | 30 per hour      | owner UID            |
| `owner-vault-read`  | 1,200 per minute | owner UID            |
| `owner-vault-write` | 600 per hour     | owner UID            |
| `owner-share-write` | 120 per hour     | owner UID            |
| `public-share-url`  | 120 per minute   | normalized client IP |

Subject identifiers are HMAC-SHA-256 with `RATE_LIMIT_KEY`; store only the
digest in `rate_limit_control`. Preliminary edge rejection may shed obvious
floods, but the Cosmos counter is authoritative across POPs and restarts.

## Error contract

| HTTP | Code                  | Meaning                                                                            |
| ---- | --------------------- | ---------------------------------------------------------------------------------- |
| 400  | `invalid_request`     | Invalid route shape, encoding, item, or protocol version                           |
| 401  | `unauthorized`        | Missing, invalid, expired, or wrong-owner Firebase token; invalid share capability |
| 403  | `binding_mismatch`    | Authenticated identity does not match owner/vault binding                          |
| 404  | `not_found`           | Item absent, or public share absent/inactive without state disclosure              |
| 409  | `conflict`            | `_etag` mismatch, share/path collision, or incompatible state transition           |
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

Read only the secrets needed by the selected route and stay within Fastly
Secret Store per-request limits. Remove `RQLITE_*`, Northflank, OpenResty,
operator-proxy, persistent-volume, `COSMOS_BROWSER_*`, owner-ticket, and
resource-token configuration after rollback retention. Never reuse the Cosmos
account key as an application HMAC or encryption key.

Config and Secret Stores are versionless: an item update affects linked active
services without a Compute deploy. Keep reviewed desired values in deployment
configuration and use named replacement entries plus smoke tests for sensitive
changes. See Fastly's [Config Store guide](https://www.fastly.com/documentation/guides/compute/edge-data-storage/working-with-config-stores/).
