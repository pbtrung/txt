# Northflank authentication and API contract

Northflank remains the only public API origin. It authenticates the owner,
performs every control-container operation, and delegates only narrowly scoped
data-plane credentials. Endpoint versioning may remain under `/v1` during the
cutover, but request/response `protocol_version` fields are mandatory.

## Common requirements

- Accept HTTPS only and apply the configured exact UI origin to CORS. Do not
  use `*` with credentials.
- Limit JSON body size, reject duplicate keys, validate canonical base64url,
  normalize R2 paths before authorization, and reject unknown fields on signed
  requests.
- Return `Cache-Control: no-store` on all key, token, grant, and signed-URL
  responses.
- Never put credentials in query strings. Redact authorization headers, bodies,
  response tokens, grants, proofs, and signed URLs from access/error logs.
- Compare the Firebase `sub` to `OWNER_FIREBASE_UID`; accepting any valid
  Firebase project user would break the one-owner model.
- Use Northflank's Cosmos account credential for every control operation. No
  API response includes a control-container resource token or resource link.
- Apply the durable rate limit before expensive cryptography or credential
  minting. Fail closed if the durable limiter cannot decide.

## `POST /v1/keys`

Purpose: authenticate the owner and return wrapped bootstrap material through
Northflank.

Authorization header: `Bearer <Firebase ID token>`.

Request:

```json
{
  "protocol_version": 3
}
```

Northflank verifies Firebase issuer, audience, signature, expiry, and owner
subject; consumes `owner-keys`; then point-reads ID `owner` with configured
partition `OWNER_PK` from the server-only `owner_control` container. It also
checks the stored UID and supported schema.

Response:

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
  "signing_public_key": "base64url",
  "wrapped_signing_private_key": "base64url",
  "encrypted_credentials": "base64url",
  "owner_ticket": "opaque authenticated ticket",
  "ticket_expires_at": "2026-08-23T00:00:00.000Z"
}
```

The browser requires equality among the Firebase UID, response UID, decrypted
credential binding, and configured/unlock identity before accepting any key.
Northflank returns values from one `_etag`-consistent point read and never
exposes the Cosmos item `_self`, account key, or a permission token.

## `POST /v1/data-token`

Purpose: after local key unwrapping, mint short-lived direct access to the
encrypted owner data plane.

Authorization is the owner ticket plus the fresh P-521 proof defined in
[cryptography.md](cryptography.md). A Firebase token is not required while the
24-hour ticket remains valid.

Request:

```json
{
  "protocol_version": 3,
  "owner_ticket": "opaque authenticated ticket",
  "user_handle": "base64url 32 bytes",
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "db_prefix": "52-character owner R2 prefix",
  "requested_at": 1787356800,
  "nonce": "base64url 32 bytes",
  "proof": "base64url P-521 signature"
}
```

Northflank validates the ticket, lifetime, owner and vault hashes, P-521 proof,
clock window, replay marker, and `owner-data-token` rate limit. It then obtains
a Cosmos native resource token from the precreated `owner-browser` user and
permission definition:

```text
mode:                  All
resource:              vault container
resourcePartitionKey: [OWNER_PK]
lifetime:              900 seconds
```

It separately asks R2 to create a 900-second temporary credential limited to
the configured bucket and normalized prefix `{db_prefix}/`. The R2 policy must
allow only the exact operations already required by owner reads, immutable
uploads, and cleanup; it does not expose account administration or other
prefixes. Cloudflare's temporary-credential behavior is documented at
[R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).

Response:

```json
{
  "protocol_version": 3,
  "expires_at": "2026-08-22T00:15:00.000Z",
  "cosmos": {
    "endpoint": "https://account.documents.azure.com:443/",
    "database_id": "txt",
    "container_id": "vault",
    "partition_key_path": "/owner_pk",
    "partition_key_value": "own_opaqueRandomValue",
    "permission_mode": "All",
    "resource_token": "opaque Cosmos resource token"
  },
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

Cosmos native resource-token permissions are coarse `Read` or `All`; they do
not express per-operation or RU ceilings. The partition scope, short lifetime,
proof requirement, Cosmos throttling, monitoring, and backups compensate for
that limitation. See the official [Cosmos access-control model](https://learn.microsoft.com/en-us/rest/api/cosmos-db/access-control-on-cosmosdb-resources)
and [permission resource](https://learn.microsoft.com/en-us/rest/api/cosmos-db/permissions)
documentation.

The browser creates a Cosmos client directly from this response but hard-codes
the expected database/container/partition values and rejects substitutions.
It refreshes at most once when less than 60 seconds remain or after one 401/403,
then retries an idempotent operation. It honors Cosmos 429 `Retry-After` and
does not turn throttling into an unbounded retry loop.

For one compatibility release, `/v1/r2-token` may accept version 3 and return
the same combined response while callers move to `/v1/data-token`. Version 2,
which is bound to `db_path`, must remain isolated to rollback code and then be
removed.

## `POST /v1/shares`

Purpose: register an uploaded independent share object or return a fresh grant
for an identical active registration.

Authorization header: `Bearer <Firebase ID token>`.

Request:

```json
{
  "protocol_version": 3,
  "vault_id": "vault_opaqueRandomValue",
  "owner_pk": "own_opaqueRandomValue",
  "db_prefix": "52-character owner R2 prefix",
  "share_id": "base64url 32 bytes",
  "share_prefix": "52-character lowercase base32-Crockford segment",
  "share_path": "52-character lowercase base32-Crockford segment"
}
```

Northflank verifies Firebase owner identity, consumes `owner-share-write`,
point-reads `owner_control`, validates the vault binding, constructs and
normalizes exactly:

```text
{db_prefix}/shared/{share_prefix}/{share_path}
```

It computes SHA-256 hashes, checks the R2 object exists with the expected
immutable-object constraints, and creates the share plus path reservation in
one server-only `share_control` transactional batch. A retry with an identical
active pair is idempotent and returns a newly encrypted grant. Any conflicting
share ID/path pairing returns 409.

Response:

```json
{
  "protocol_version": 3,
  "state": "active",
  "grant": "opaque authenticated share grant"
}
```

## `DELETE /v1/shares`

Purpose: revoke one owner share and delete its R2 object.

Authorization header: `Bearer <Firebase ID token>`.

The request contains protocol version, owner/vault binding fields, raw share
ID, and the rendered share prefix/path. As today, no grant is required because
the owner does not persist grants. Firebase owner authentication plus the
server-verified vault binding authorize the call. Northflank reconstructs the
exact object key, recomputes every hash, and requires agreement with the
registry. It then:

1. conditionally changes the server registry `active` to `deleting`;
2. deletes the exact R2 object (not-found is success during retry); and
3. transactionally deletes the share and path-reservation items.

An already absent matching share is an idempotent 204. A mismatched identity or
path is not treated as absent. A `deleting` item never authorizes a new public
URL.

## `POST /v1/shared-url`

Purpose: exchange an anonymous capability for a 60-second exact-object R2 GET
URL.

No Firebase authentication is used. Request size is tightly bounded and
contains protocol version, raw share ID, and current share grant. Northflank:

1. consumes `public-share-url` by privacy-preserving client-IP hash;
2. verifies and decrypts the grant;
3. point-reads the share-ID hash from server-only `share_control`;
4. requires `active`, matching object-path hash, and a normalized path;
5. creates a 60-second URL allowing GET for exactly that object.

The response is `Cache-Control: no-store`. It contains no owner path prefix,
Cosmos information, or R2 list permission. Revocation takes effect at the next
exchange; a URL already issued may remain usable for its remaining 60 seconds.

## Health endpoints

- `/health/live` confirms only that the OpenResty worker is responsive.
- `/health/ready` confirms configuration parsing, secret presence, supported
  control schema, and point-read access to all three server-only control
  containers plus `vault`. It must not mint a client token or write state.
- Health responses reveal no account, container, owner, bucket, or versioned
  secret values.

Northflank deployment readiness must fail if rqlite configuration is still
required or if any control container can be accessed using the client
permission.

## Rate limits

Preserve the current limits, renaming only the combined data-token scope:

| Scope | Limit | Subject |
| --- | --- | --- |
| `owner-keys` | 60 per hour | owner UID |
| `owner-data-token` | 30 per hour | owner UID |
| `owner-share-write` | 120 per hour | owner UID |
| `public-share-url` | 120 per minute | normalized client IP |

Subject identifiers are HMAC-SHA-256 with `RATE_LIMIT_KEY`. Store only the
digest in `rate_limit_control`. Proof replay markers are separate and do not
consume additional data-token allowance after the request is already rejected
as a replay.

## Error contract

Use stable machine-readable codes while keeping public messages nonspecific:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid shape, encoding, path, or protocol version |
| 401 | `unauthorized` | Missing/invalid Firebase token, ticket, proof, or share capability |
| 403 | `binding_mismatch` | Authenticated identity does not match configured owner/vault binding |
| 404 | `not_found` | Public share absent/inactive; do not distinguish states |
| 409 | `conflict` | Share/path collision or incompatible state transition |
| 429 | `rate_limited` | Durable limit exceeded; include `Retry-After` |
| 503 | `control_unavailable` | Cosmos, Firebase verification, or credential broker unavailable |

Detailed internal error causes belong only in redacted structured telemetry.
Never reflect a Cosmos or R2 credential-provider response body to the browser.

## Northflank secret configuration

Retain existing Firebase, R2, `R2_TICKET_SECRET`, `SHARE_GRANT_KEY`, `RATE_LIMIT_KEY`,
owner UID, bucket, and exact UI-origin secrets/configuration. Add:

```text
COSMOS_ENDPOINT
COSMOS_DATABASE_ID
COSMOS_OWNER_CONTROL_CONTAINER_ID
COSMOS_SHARE_CONTROL_CONTAINER_ID
COSMOS_RATE_LIMIT_CONTROL_CONTAINER_ID
COSMOS_VAULT_CONTAINER_ID
COSMOS_ACCOUNT_KEY
COSMOS_BROWSER_USER_ID
COSMOS_BROWSER_PERMISSION_ID
OWNER_PK
```

Remove all `RQLITE_*`, loopback rqlite, operator-proxy, persistent-volume, and
rqlite-backup configuration after the rollback window closes. Never reuse a
Cosmos account key as any application HMAC or encryption key.
