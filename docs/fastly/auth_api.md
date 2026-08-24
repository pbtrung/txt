# Fastly Compute authentication and API contract

Fastly Compute is the only public API origin and the only runtime component
that reads or writes KV Store. Owner requests follow one path:

```text
Firebase ID token -> Fastly Compute route -> KV Store (native binding)
```

Fastly exposes application operations, not KV Store operations. There is no
route that accepts an arbitrary store, key, or KV Store method.

## Firebase ID-token validation

Every owner route requires `Authorization: Bearer <Firebase ID token>`. Fastly
must verify the token before reading a secret or calling KV Store/R2:

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

Fastly does not issue an owner ticket, application session, or refresh token.
The Firebase client SDK refreshes the ID token, and the browser retries one
idempotent request after refresh on a Fastly 401.

## Possession proof

A valid Firebase token proves who is asking; it does not prove the caller
currently holds the unwrapped signing key that only exists after a correct
`user_root_key` unlock. Every route in the following table additionally
requires the per-request P-521 possession proof defined in
[cryptography.md](cryptography.md):

| Route                                 | Proof required |
| -------------------------------------- | --------------- |
| `POST /v1/keys`                       | no |
| `GET /v1/vault/head`                  | no |
| `GET /v1/vault/books/{book_id}`       | no |
| `GET /v1/vault/reading/{book_id}`     | no |
| `GET /v1/vault/reading-index`         | no |
| `PUT /v1/vault/reading/{book_id}`     | no — see note below |
| `GET /v1/vault/books?cursor=...`      | no |
| `POST /v1/vault/commit`               | yes |
| `PUT /v1/vault/books/{book_id}`       | yes |
| `POST /v1/r2-token`                   | yes |
| `POST /v1/shares`                     | yes |
| `DELETE /v1/shares`                   | yes |
| `POST /v1/shared-url`                 | no (unauthenticated; capability is the authorization) |

Reads are exempt because they return ciphertext only — a bearer-token-only
compromise cannot recover plaintext through them. `PUT /v1/vault/reading/{book_id}`
is exempt for a different reason: it can only ever corrupt or flood one
book's reading position and bookmarks, never delete a book, revoke a share,
corrupt `catalog-head`, or obtain raw storage credentials, and any damage it
causes is repairable exactly as a missing or corrupt reading entry already is
in [catalog.md](catalog.md). Every other mutating or credential-minting route
requires the proof, because those operations do not depend on breaking
encryption to cause damage and are not confined the same way, so a stolen
bearer token alone must not be sufficient. A request missing, failing, or
replaying a required proof is rejected before any KV Store or R2 work; see the
error contract below.

## Common requirements

- Accept HTTPS only and allow only the configured exact UI origin in CORS. Do
  not use `*` with credential-bearing requests.
- Allow only the documented methods, paths, content types, and headers. Reject
  encoded path separators and normalize route parameters before validation.
- Limit JSON body size, reject duplicate keys, validate canonical base64url,
  validate `generation` syntax as an opaque bounded string, and reject unknown
  fields.
- Construct `owner_pk`, `vault_id`, and `db_prefix` inputs from the single
  `owner_control` entry. A body copy, if a versioned legacy client sends one,
  is rejected as an unknown field rather than used for routing or binding.
- Return `Cache-Control: private, no-store` and `Vary: Origin, Authorization` on
  authenticated responses. Never allow Fastly cache lookup or storage for API
  routes, even when a response happens to be cacheable.
- Never put credentials in query strings. Redact authorization headers, request
  bodies, ciphertext, grants, R2 credentials, signatures, and signed URLs from
  logs.
- Apply a subject-independent flood control (normalized client IP or a global
  counter) before spending CPU on Firebase signature verification or any other
  expensive cryptography. Apply the route's owner-subject-keyed rate limit only
  after the Firebase token has been fully verified — never key a rate-limit
  bucket by an unverified token claim, or an attacker holding no valid token
  can exhaust the real owner's budget with forged-signature requests and lock
  them out. Fail closed if a durable slot claim cannot decide; a best-effort
  in-instance limiter failing open is an accepted property of being
  best-effort, not a bug — see Rate limits below.
- Give each outbound fetch (Firebase certificate retrieval, R2 requests) a
  bounded timeout. Retry at most once for a safe point read and only
  according to the operation's idempotency rules.
- Propagate a KV Store or R2 throttling response to the caller as a bounded
  `Retry-After`; do not create an unbounded edge retry loop.

## KV Store access

Fastly reads and writes each of the four KV Stores through the Compute
service's linked resource binding — a platform-level resource link configured
at deploy time, not a network call the service makes to an external origin.
There is no request to sign, no account key, and no endpoint hostname to
configure or leak. For every route, Fastly:

- selects the KV Store binding and key from trusted configuration and
  validated request parameters — never from a client-supplied store name or
  key;
- builds the value it writes itself from allowlisted application fields;
- checks the KV Store response status and required fields; and
- returns only the documented application response and the entry's opaque
  `generation`, never the raw KV Store binding name or an internal key.

The browser must never see a KV Store name, key, or generic lookup response.

## `POST /v1/keys`

Purpose: authenticate the owner and return wrapped bootstrap material.

Request:

```json
{
  "protocol_version": 1
}
```

Fastly validates Firebase, consumes `owner-keys`, then reads the `owner` entry
from `owner_control`. It checks the stored UID and supported schema before
returning:

```json
{
  "protocol_version": 1,
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
values from one read of the `owner` entry and exposes neither its
`generation` nor any other KV Store system property.

## Vault read routes

All vault routes require Firebase authentication. Fastly always targets the
`vault` KV Store.

### `GET /v1/vault/head`

Read the `catalog-head` entry. Return the allowlisted head fields from
[data_model.md](data_model.md) plus:

```json
{
  "generation": "opaque KV Store generation marker"
}
```

### `GET /v1/vault/books/{book_id}`

Validate the opaque ID and read the `book_{book_id}` entry. Require
`kind = book`, the supported schema, and the correct `owner_pk` binding
inside the decrypted envelope. Return the outer encrypted entry plus its
`generation`; do not inspect or transform the ciphertext.

### `GET /v1/vault/reading/{book_id}`

Validate the opaque ID and read the `reading_{book_id}` entry. An absent entry
is not an error — it means the book has never been opened — and returns
`{"present": false}` rather than a 404, since a missing reading entry is an
expected steady state, not a fault. Otherwise return the outer encrypted
entry plus its `generation`.

### `GET /v1/vault/reading-index`

Read the `reading-index` entry. An absent entry means the owner has no
reading history yet and returns `{"present": false}`, not a 404. Otherwise
return the outer encrypted entry plus its `generation`.

### `GET /v1/vault/books?cursor=...`

This fixed, owner-only scan exists solely for snapshot repair and administrative
verification. Fastly lists `vault` keys under the `book_` prefix using KV
Store's native list operation, enforces a page-size and total-item ceiling,
and wraps the KV Store list cursor in an authenticated opaque cursor. It never
accepts query text, a client-supplied prefix, or a raw KV Store cursor. This
route consumes the dedicated `owner-vault-scan` budget below, not
`owner-vault-read`: it is a store-wide list operation, not a point read, and
is materially more expensive per call.

## Vault write routes

Fastly validates only the outer encrypted record, version, identifier, sizes,
and transition shape; it cannot validate encrypted user fields. All accepted
writes must use a current `generation` unless they are create-only. These
routes require the possession proof described above.

### `POST /v1/vault/commit`

Purpose: create, replace, or delete a book — its content locator, catalog
metadata, and shares together — and advance `catalog-head` in the same call,
after the new immutable R2 snapshot has been uploaded. A book operation and a
head operation are always both present: because catalog metadata and shares
are projected into the snapshot, every create/replace/delete of a book's
merged entry changes what the snapshot must show.

Request shape:

```json
{
  "protocol_version": 1,
  "possession_proof": {
    "route": "vault-commit",
    "nonce": "base64url 32 bytes",
    "expires_at": 0,
    "signature": "base64url raw P-521 signature"
  },
  "book": {
    "operation": "create | replace | delete",
    "id": "book_K7c3...",
    "generation": "required for replace/delete",
    "entry": "required for create/replace; exact encrypted outer entry"
  },
  "head": {
    "generation": "current head generation",
    "entry": "next catalog-head outer entry, with ciphertext already wrapped client-side",
    "object_key": "plaintext R2 key, used once for verification, never persisted"
  }
}
```

Fastly rejects unexpected outer fields, overwrites neither identity nor
version silently, and requires:

- the possession proof verifies for `route: "vault-commit"` and has not been
  seen before (see [cryptography.md](cryptography.md));
- the path/body book IDs agree, `owner_pk` equals the configured owner
  identity, kind/schema/size satisfy [data_model.md](data_model.md), create
  has no `generation` and uses a create-only write, and replace/delete carry
  the previous `generation`;
- the new head `generation` field inside the entry is exactly one greater than
  the current one, head kind/schema are exact, `head.object_key` matches the
  required R2 key grammar, **and a direct R2 `HEAD` on `head.object_key`
  returns 200** — Fastly must not advance the pointer on the strength of
  client-supplied metadata alone, so this existence check runs against R2
  itself, not against anything the client merely claims.

`head.object_key` is used for that one check and discarded; only
`head.entry` (carrying the already-wrapped `ciphertext`) is written to KV
Store. Fastly cannot verify that the plaintext `object_key` it checked and
the object key encrypted inside `head.entry.ciphertext` agree, since it
cannot decrypt the latter — that agreement is the browser's own
responsibility, the same way
the browser is responsible for every other field it encrypts before sending.
A self-inconsistent commit from a malfunctioning client is not a security
issue (no other principal's data or access is at risk), only a correctness
one: the next load fails Decrypt or fetches a nonexistent object, and repair
in [catalog.md](catalog.md) rebuilds a fresh, consistent pointer.

Fastly then performs, in this fixed order:

1. the book operation (create-only write, or a conditional replace/delete
   against the supplied `generation`);
2. the R2 existence check against `head.object_key`; and
3. the conditional write of the `catalog-head` entry against its supplied
   `generation`.

A KV Store has no cross-key transaction, so steps 1 and 3 are not atomic with
each other. If step 1 succeeds and step 2 or 3 fails, the book entry is ahead
of `catalog-head` — the book's `record_version` will no longer match the
version projected in the last published snapshot. This is not a corruption:
[catalog.md](catalog.md) already treats a `record_version` mismatch between a
live entry and the snapshot projection as "the live entry is authoritative,
schedule a repair," and the same retry that produced the mismatch (a fresh
`/v1/vault/commit` with the current head `generation`) is exactly how it
self-heals. Fastly returns the actual step that failed inside the standard
conflict response so the caller retries from the right place rather than
reapplying step 1. If the R2 existence check fails, Fastly returns
`409 conflict` without attempting the head write at all.

Replacing a book's content (a new EPUB superseding an existing entry) is
**not** expressed as a `replace` on the existing `book_id`: doing so would let
a new, unrelated document silently reuse CFIs and bookmarks that were computed
against the old content. It is instead a `delete` of the old
`book_id`/reading entry (blocked, as always, while `shares` is non-empty)
followed by an ordinary `create` of a new `book_id`, as two independent
`/v1/vault/commit` calls, each with its own head generation bump. A crash
between the two calls leaves the library either missing that title or, if
delete did not commit, still showing the old content; neither state loses
data (the failed step is simply retried) and neither needs special repair
handling.

### `PUT /v1/vault/books/{book_id}`

Purpose: replace one encrypted book entry for a content-locator-only change —
for example, re-keying or relocating a book's underlying content — that does
not touch catalog metadata or shares and therefore does not affect the
snapshot projection, so no `catalog-head` step is needed. The request contains
`protocol_version`, the possession proof, the previous `generation`, and the
complete next encrypted outer entry. Fastly applies the same identity/schema/
size checks and a conditional replace. It cannot be used to create, delete,
change catalog metadata or shares, or write `catalog-head`.

There is no general create/delete/upsert endpoint outside `/v1/vault/commit`.

### `PUT /v1/vault/reading/{book_id}`

Purpose: write a book's reading position and bookmarks. The request contains
`protocol_version`, the previous `generation` (omitted for the first write),
the complete next encrypted outer entry, and — only when this call is the
session's qualifying read or changes `bookmarks`, per
[data_model.md](data_model.md)'s `reading-index` entry — an optional
`reading_index` sub-object carrying the updated index entry and its previous
`generation`. A routine CFI-only debounce write omits it entirely. No
possession proof is required — see the table above. Fastly:

1. validates the opaque book ID, entry kind/schema/size, and that
   `owner_pk`/`vault_id` (checked only as authenticated opaque values; Fastly
   does not decrypt) are present;
2. performs a create-only write, or a conditional replace against the
   supplied `generation`; and
3. only if `reading_index` is present in the request, separately updates the
   `reading-index` entry the caller supplies (also conditional on its own
   `generation`), as its own independent KV write — a reading-index conflict
   is reported and retried independently of the reading-state write.

A `409` on either write means another tab or device wrote first: fetch the
current entry through `GET /v1/vault/reading/{book_id}` (and, if updating
the index, `GET /v1/vault/reading-index`), reapply the same semantic
mutation, and retry.

## `POST /v1/r2-token`

Purpose: return short-lived direct R2 access for owner object reads —
including EPUB content and the catalog snapshot — plus immutable uploads and
cleanup, all under one prefix. The request contains `protocol_version`, the
possession proof, and the locally decrypted `vault_id`, `owner_pk`, and
`db_prefix` binding.

Fastly validates Firebase, verifies the possession proof for
`route: "r2-token"`, consumes `owner-r2-token`, reads the `owner` entry,
hashes and compares the binding, and asks R2 for a 900-second temporary
credential limited to the configured bucket and normalized `{db_prefix}/`. It
returns only:

```json
{
  "protocol_version": 1,
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

No KV Store field or credential is present. The browser hard-codes the
expected R2 endpoint/bucket/prefix, keeps the response in memory, and
refreshes at most once near expiry or after one authorization failure.
Cloudflare documents the credential mechanism at
[R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).

Reading state and bookmarks never use this credential: they are written and
read entirely through the `PUT`/`GET /v1/vault/reading/{book_id}` routes
above, which touch only KV Store.

## `POST /v1/shares`

Purpose: register an uploaded independent share object or return a fresh grant
for an identical active registration.

The Firebase-authenticated request carries protocol version, the possession
proof (`route: "share-create"`), owner/vault binding, the owning `book_id`,
raw share ID, and rendered share prefix/path. Fastly consumes
`owner-share-write`, validates the binding against `owner_control`, constructs
and normalizes exactly:

```text
{db_prefix}/shared/{share_prefix}/{share_path}
```

It hashes the identifiers, checks that the immutable R2 object exists, and
creates the path reservation followed by the share entry — which stores
`book_id` in plaintext alongside the hashes, per
[data_model.md](data_model.md) — in `share_control`, both as create-only
writes. If the share create fails because
`share_{share_id_hash}` already exists, Fastly reads the existing share and
reservation entries: identical `object_path_hash` on both is the
idempotent-retry case (return a fresh grant, no write); anything else is
`409`. See [data_model.md](data_model.md) for the exact reconciliation rule.

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
3. deletes the share entry, then the path-reservation entry.

An already absent matching share is an idempotent 204. A mismatched identity or
path is not treated as absent. A `deleting` entry never authorizes a new URL.

## `POST /v1/shared-url`

Purpose: exchange an anonymous capability for a 60-second exact-object R2 GET
URL. No Firebase authentication or possession proof is used — a public
recipient has neither. The bounded request carries only protocol version, raw
share ID, and current encrypted grant. Fastly:

1. consumes `public-share-url` by privacy-preserving client-IP hash;
2. verifies and decrypts the grant;
3. reads the share entry by ID hash from `share_control`;
4. requires `active`, a matching object-path hash, and normalized path; and
5. creates a 60-second URL allowing GET for exactly that object.

The response is `Cache-Control: private, no-store` and contains no owner prefix
or R2 list permission. Revocation affects the next exchange; an issued URL
remains usable only for its short lifetime.

## Health endpoints

- `/health/live` confirms that the deployed Compute package can serve requests.
- `/health/ready` reads required config/secret entries and reads the
  fixed `schema_...` marker key from all four KV Stores (see
  [data_model.md](data_model.md)). It must not write, read user data, or mint
  R2 credentials.
- Health responses reveal no owner, KV Store, key, generation, or schema
  values.

Readiness fails if a required KV Store binding is missing, or a
client-supplied value can influence which store or key a route targets.

## Rate limits

Durable, KV-backed admission limits apply to routes whose abuse is not
self-contained. They use the create-only slot ledger in
[data_model.md](data_model.md), not a mutable counter:

| Scope                | Limit            | Subject              |
| --------------------- | ---------------- | --------------------- |
| `owner-keys`          | 60 per hour      | owner UID            |
| `owner-r2-token`      | 30 per hour      | owner UID            |
| `owner-vault-scan`    | 12 per hour      | owner UID            |
| `owner-vault-write`   | 100 per 10 min   | owner UID            |
| `owner-share-write`   | 20 per 10 min    | owner UID            |
| `public-share-url`    | 120 per minute   | normalized client IP |

`owner-vault-scan` covers `GET /v1/vault/books?cursor=...` only — the
administrative repair/verification scan — deliberately far tighter than
ordinary reads, since each call lists across the whole `book_` key prefix and
repeatedly triggering it is a realistic way to burn the Class A/B budget
documented in [README.md](README.md).

Two routes are deliberately **not** covered by a durable slot ledger, and instead
rely on a best-effort, in-instance request counter that resets whenever a
Compute instance is recycled and is not shared across Fastly points of
presence:

- `owner-vault-read` (`GET /v1/vault/head`, `GET /v1/vault/books/{book_id}`,
  `GET /v1/vault/reading/{book_id}`), because it returns ciphertext only; and
- `owner-reading-write` (`PUT /v1/vault/reading/{book_id}`), because its
  damage is confined to one book's reading state and always repairable, per
  the possession-proof table above.

Treat both as flood control, not a security boundary: a determined caller
distributed across many points of presence can exceed the intended ceiling
before any single instance notices. That is an accepted tradeoff for these
two routes specifically, in exchange for not spending a KV Store write on
every point read and every 15-second reading-position debounce; every other
route's abuse potential is high enough that this tradeoff is not offered.

Subject identifiers for durable limits are HMAC-SHA-256 with `RATE_LIMIT_KEY`;
store only the digest in `rate_limit_control`, and only ever compute it from a
**verified** Firebase subject or, after capability validation, a normalized
client IP. Each accepted call consumes one create-only slot. Start probing at
a CSPRNG-random slot and walk at most the configured `N` slots; cache a known
full ring in the current instance until the fixed window ends. An existing
slot is an ordinary collision, but a provider error is 503. The configured
maximum is 120 slots per ring so an attacker cannot force an unbounded scan.
This free-tier mechanism requires no Fastly Edge Rate Limiting product.

## Error contract

| HTTP | Code                  | Meaning                                                                            |
| ---- | --------------------- | ---------------------------------------------------------------------------------- |
| 400  | `invalid_request`     | Invalid route shape, encoding, entry, or protocol version                         |
| 401  | `unauthorized`        | Missing, invalid, expired, or wrong-owner Firebase token; invalid share capability; missing, invalid, expired, wrong-route, or replayed possession proof |
| 403  | `binding_mismatch`    | Authenticated identity does not match owner/vault binding                          |
| 404  | `not_found`           | Entry absent, or public share absent/inactive without state disclosure             |
| 409  | `conflict`            | `generation` mismatch, share/path collision, incompatible state transition, or a `/v1/vault/commit` head whose R2 object failed the existence check |
| 413  | `too_large`           | Request, ciphertext entry, or page exceeds its fixed limit                         |
| 429  | `rate_limited`        | A durable slot ring or best-effort limit was exceeded; include bounded `Retry-After` |
| 502  | `upstream_invalid`    | KV Store or R2 returned an invalid or unsupported response                         |
| 503  | `control_unavailable` | Firebase keys, KV Store, limiter, secret, or R2 broker unavailable                  |

Detailed causes belong only in redacted structured telemetry. Never reflect a
Firebase-certificate, Secret Store, KV Store, or R2 provider response body.

## Fastly resource configuration

Store nonsecret routing/configuration in a linked Fastly Config Store:

```text
FIREBASE_PROJECT_ID
OWNER_FIREBASE_UID
UI_ORIGIN
KV_STORE_OWNER_CONTROL
KV_STORE_VAULT
KV_STORE_SHARE_CONTROL
KV_STORE_RATE_LIMIT_CONTROL
R2_ENDPOINT
R2_BUCKET
```

The four `KV_STORE_*` values name the KV Store resources linked to this
Compute service; they select a binding, not a network address. Store secret
values only in a linked Fastly Secret Store:

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
SHARE_GRANT_KEY
RATE_LIMIT_KEY
```

There is no KV Store account key or signing secret to store — reading and
writing KV Store needs no secret at all. `sign_public_key` used to verify
possession proofs is not a secret — it is read directly from the `owner`
entry, not from Secret Store.

Read only the secrets needed by the selected route and stay within Fastly
Secret Store per-request limits.

Config and Secret Stores are versionless: an entry update affects linked
active services without a Compute deploy. Keep reviewed desired values in
deployment configuration and use named replacement entries plus smoke tests
for sensitive changes. See Fastly's
[Config Store guide](https://www.fastly.com/documentation/guides/compute/edge-data-storage/working-with-config-stores/).
