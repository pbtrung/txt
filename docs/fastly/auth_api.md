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
6. validate `exp`, `iat`, `auth_time`, and a bounded nonempty `sub` against
   current time with a small, documented clock-skew allowance; and
7. constant-time compare `sub` with `OWNER_FIREBASE_UID`.

Firebase ID tokens use **RS256** (RSA PKCS#1 v1.5 with SHA-256). This is
unrelated to the owner's P-521 key: RSA verifies Google's Firebase token;
ECDSA P-521 verifies the separate request-possession proof. Never accept P-521,
another JWT algorithm, or a key selected from an attacker-controlled URL for
the Firebase token.

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
| `PUT /v1/vault/reading/{book_id}`     | first create only |
| `DELETE /v1/vault/reading/{book_id}`  | yes |
| `PUT /v1/vault/reading-index`         | yes |
| `GET /v1/vault/books?cursor=...`      | no |
| `POST /v1/vault/commit`               | yes |
| `PUT /v1/vault/head`                  | yes |
| `POST /v1/r2-url`                     | yes |
| `POST /v1/shares`                     | yes |
| `DELETE /v1/shares`                   | yes |
| `POST /v1/shared-url`                 | no (unauthenticated; capability is the authorization) |

Reads are exempt because they return only ciphertext or nonsensitive catalog
integrity metadata — a bearer-token-only compromise cannot recover user
plaintext through them. Replacing an existing
`reading_{book_id}` entry is also exempt: Fastly first point-reads the matching
book, then requires a current reading generation, so the request can corrupt
only one existing book's rebuildable reading state. The first reading write is
not exempt: it can create a new key and therefore requires proof and a durable
write-admission slot. A `reading-index` write always requires proof because it
changes a library-wide entry. Every other mutating or credential-minting route
requires proof. A request missing, failing, or replaying a required proof is
rejected before any state-changing vault/share KV or R2 work. Verification
necessarily reads the fixed `owner` entry. After signature validation, claim
the proof's create-only replay nonce **before** claiming the route's durable
admission slot; a concurrent replay must fail without burning another rate
slot. See the error contract below.

## Common requirements

- Accept HTTPS only and allow only the configured exact UI origin in CORS. Do
  not use `*` with credential-bearing requests.
- Allow only the documented methods, paths, content types, and headers. Reject
  encoded path separators and normalize route parameters before validation.
- Limit JSON body size, reject duplicate keys, validate canonical base64url,
  validate `generation` syntax as an opaque bounded string, and reject unknown
  fields.
- On proof-bearing JSON routes, validate and canonicalize the body without its
  top-level `possession_proof` exactly as defined in
  [cryptography.md](cryptography.md). The verifier and route handler must use
  the same already-parsed value; do not parse or normalize it a second time.
- Construct `owner_pk`, `vault_id`, and `db_prefix` inputs from the single
  `owner_control` entry. A body copy, if a versioned legacy client sends one,
  is rejected as an unknown field rather than used for routing or binding.
- Return `Cache-Control: private, no-store` and `Vary: Origin, Authorization` on
  authenticated responses. Never allow Fastly cache lookup or storage for API
  routes, even when a response happens to be cacheable.
- Never put Firebase tokens, KV bindings, or R2 API credentials in query
  strings. A presigned R2 URL necessarily carries short-lived SigV4 bearer
  material in its query, so redact the entire URL along with authorization
  headers, request bodies, ciphertext, grants, credentials, and signatures.
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

Validate the opaque ID and read the exact `{book_id}` entry. Require
`kind = book`, the supported outer schema, matching outer `item_id`, and valid
size/encoding. Return the outer encrypted entry plus its `generation`; do not
inspect or transform the ciphertext. Only the browser or CLI can decrypt and
validate the authenticated inner `owner_pk`, `vault_id`, kind, and item ID.

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
and transition shape; it cannot validate encrypted user fields. The browser or
CLI must validate authenticated inner fields after decryption. All accepted
writes must use a current `generation` unless they are create-only. Proof
requirements are route-specific in the table above.

### `POST /v1/vault/commit`

Purpose: create, replace, or delete a book and advance `catalog-head` after the
client has created a new immutable catalog object at a fresh random R2 path. A
book operation and a head operation are always both present: every accepted
change to a book entry republishes the derived projection, including a
content-path, catalog-metadata, or share change. There is no endpoint on which
Fastly tries to distinguish those encrypted semantics.

Request shape for create/replace; delete omits `book.entry` and `book.object`:

```json
{
  "protocol_version": 1,
  "possession_proof": {
    "proof_version": 2,
    "nonce": "base64url 32 bytes",
    "expires_at": 0,
    "signature": "base64url raw P-521 signature"
  },
  "book": {
    "operation": "create | replace | delete",
    "id": "book_K7c3...",
    "generation": "required for replace/delete",
    "entry": "required for create/replace; exact encrypted outer entry",
    "object": {
      "txt_prefix": "base64url 32 bytes",
      "path": "base64url 32 bytes",
      "object_etag": "opaque R2 validator",
      "object_length": 12345,
      "ciphertext_sha256": "base64url SHA-256"
    }
  },
  "head": {
    "generation": "current head generation",
    "entry": "complete next catalog-head outer entry",
    "object_key": "{db_prefix}/catalog/random"
  }
}
```

Fastly rejects unexpected outer fields, overwrites neither identity nor
version silently, and requires:

- the v2 possession proof binds the exact HTTP method, normalized target, and
  canonical request body and has not been replayed;
- the body book ID matches the outer entry item ID; outer kind/schema/size are
  valid; create omits `generation`; and replace/delete carry the previously
  read `generation`;
- create/replace supplies a strictly bounded `book.object` whose rendered
  `txt_prefix`/`path` has the exact stored owner-prefix grammar, and a direct
  uncached R2 `HEAD` returns its exact ETag/length/`x-amz-meta-txt-sha256`;
- the current head either exactly equals `head.entry` (an already-applied
  retry), or the entry's `snapshot_generation` is exactly one greater than its
  current value; its outer ETag, length, digest, and encrypted pointer have
  strict bounded encodings; and
- `head.object_key` has the exact stored owner prefix and catalog/random-ID
  grammar (32 random bytes in canonical base64url), and a direct uncached R2
  `HEAD` of it returns the exact ETag/length/`x-amz-meta-txt-sha256` carried by
  `head.entry`.

Fastly uses the plaintext object locators only for that request and never
persists or returns them separately. It cannot decrypt either outer entry, so
it cannot prove a transient locator equals the encrypted book locator or head
pointer. The browser/CLI must construct each pair from one value and reject any
mismatch after decryption. A valid proof holder can make only this owner's own
encrypted state inconsistent; repair rebuilds the catalog from authoritative
books, while an inconsistent book locator requires explicit owner repair.

R2 has
[strong read-after-write consistency](https://developers.cloudflare.com/r2/reference/consistency/)
for object creates. The direct `HEAD` therefore establishes that the new bytes
exist before any KV write; do not put a caching custom domain between Fastly
and the S3 endpoint.

Fastly performs every required direct R2 `HEAD` **before any KV write**, then
the book operation and conditional `catalog-head` write. Cross-store and
cross-key atomicity is unavailable, so retries use postconditions:

- if create reports that the key exists, point-read it and succeed only if its
  complete canonical outer entry exactly equals the requested entry;
- if replace reports a generation mismatch, point-read and succeed only if
  the current complete canonical outer entry equals the requested entry;
- if delete finds the key absent, treat it as already applied (book IDs are
  never reused); otherwise a generation mismatch is a conflict;
- if the head write reports a generation mismatch, point-read and succeed only
  if every persisted head field exactly equals `head.entry`.

An eventually consistent point-read immediately following a write conflict
may not yet reveal that postcondition. Return `503 commit_pending` with phase
`propagation`; the caller retries the same semantic request with jitter and a
fresh proof. Never convert uncertainty into an overwrite. Other failures name
phase `content`, `snapshot`, `book`, or `head`, so a caller can distinguish a
failed precondition from an already-applied partial commit. This makes retrying
after a lost response or a successful book write safe and prevents the same
mutation being applied twice.

An idempotent transport retry reuses the exact book/head outer-entry bytes and
transient object fields from the first attempt and creates only a fresh proof.
Re-encrypting the same plaintext produces different nonce/ciphertext bytes and
therefore is a new publication attempt, not an exact postcondition retry.

Replacing a book's content is **not** a replace of the existing `book_id`,
because CFIs and bookmarks belong to the old document. Upload and commit the
new EPUB under a fresh `book_id` first. Only after that create is visible may
the client delete the old book, blocked while shares are nonempty, then delete
its reading entry through the separate proof-required route. A crash therefore
leaves old only, both old and new, or new only — never neither. The client does
not transfer reading state automatically.

There is no general create/delete/upsert or content-locator-only book endpoint
outside `/v1/vault/commit`.

### `PUT /v1/vault/head`

Purpose: publish only a repaired catalog projection after a complete owner
book scan. The proof-bearing request carries the current head `generation`
and the same next head fields as `/v1/vault/commit`. Fastly performs the same
catalog R2 `HEAD`, one-step generation check, conditional write, and exact
postcondition handling, but no book write or owner EPUB check. Normal book
changes cannot use this route; it is for a projection of already-authoritative
entries.

### `PUT /v1/vault/reading/{book_id}`

Purpose: write a book's reading position and bookmarks. The request contains
`protocol_version`, the previous `generation` (omitted for the first write),
and the complete next encrypted outer entry. It never contains an index
sub-object. Fastly first point-reads the exact `{book_id}` key and rejects an
absent book, then validates only the reading entry's outer ID/kind/schema/size.

An absent reading entry uses create-only semantics and requires a possession
proof plus the durable reading-create admission slot. Replacing an existing
entry requires its current `generation`; it is proof-exempt and uses the
bounded existing-entry rate limit. If the read observed an entry but the
subsequent conditional replace loses a race, return `409`; never fall back to
create. The browser fetches, decrypts, reapplies the semantic mutation, and
retries. Fastly cannot validate bookmark or CFI plaintext.

### `DELETE /v1/vault/reading/{book_id}`

Purpose: remove obsolete reading state after its book deletion has committed.
The request contains protocol version, possession proof, and the last reading
`generation`. Fastly performs a conditional delete; absence is idempotent
success, while a present generation mismatch is `409`. This proof-required
step is independent of the book/head commit, so a crash may leave an orphan
reading entry but cannot make a deleted book reappear. The safety-aged cleaner
is the fallback for abandoned orphans.

### `PUT /v1/vault/reading-index`

Purpose: independently update the derived library-wide reading index after a
qualifying reading-state write or bookmark mutation. The request carries a
possession proof, the complete encrypted outer entry, and either the previous
`generation` or an explicit create-only operation. Fastly validates outer
shape and conditionally writes only `reading-index`.

Write authoritative per-book reading state first, then the derived index. If
the index conflicts or fails, retain it as unsaved and independently fetch,
decrypt, merge, and retry the index without replaying the already-successful
reading-state write. A stale or missing index is repairable and never rolls
back authoritative reading state.

## `POST /v1/r2-url`

Purpose: issue one short-lived presigned R2 URL for one method on one exact
object. The browser never receives an access key, secret, session token,
prefix-wide permission, list permission, or DELETE URL. Cloudflare documents
that a presigned URL binds an operation and object and must be treated as a
bearer token in its
[R2 presigned URL guide](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
Use the R2 S3 API hostname directly; do not depend on custom-domain WAF/HMAC
features or any paid Cloudflare/Fastly rate-limiting product.

Every request contains `protocol_version`, its exact-request v2 possession
proof, and one of these allowlisted operation shapes:

| Operation          | Additional request fields | Signed R2 result |
| ------------------ | ------------------------- | ---------------- |
| `catalog-get`      | current head KV `generation` and the decrypted/rendered random `catalog_id` | GET exact `{db_prefix}/catalog/{catalog_id}` with `If-Match: <head ETag>` |
| `catalog-put`      | fresh random rendered `catalog_id`, current head KV `generation`, next logical generation, claimed byte length, ciphertext SHA-256, and MD5, all bounded | create-only PUT of that exact catalog key |
| `owner-epub-get`   | `book_id`, rendered `txt_prefix`, rendered `path`, and expected ETag from the decrypted book entry | GET that exact owner EPUB key with signed `If-Match` |
| `owner-epub-put`   | rendered `txt_prefix`, rendered `path`, claimed byte length, ciphertext SHA-256, and MD5, all bounded | create-only PUT of that exact owner EPUB key |
| `share-put`        | rendered `share_prefix`, rendered `share_path`, claimed byte length, ciphertext SHA-256, and MD5, all bounded | create-only PUT of that exact share key |
| `pending-get`      | object class plus the exact rendered random segments and expected length/SHA-256 from a just-attempted upload | GET only that exact immutable key, for lost-response recovery |

The request encodes MD5 as canonical base64url; Fastly converts it to the
standard Base64 required by the `Content-MD5` HTTP header. This MD5 is only
R2's single-PUT transport integrity check, not an application security digest.
Consumers still require the signed SHA-256 metadata and canonical AEAD.
R2 documents `Content-MD5` and conditional PutObject headers as supported in
its [S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/).

Fastly validates Firebase and proof, claims the replay nonce and
`owner-r2-url` slot in that order, reads all binding values from
`owner_control`, validates rendered path segments, and constructs the full key
itself. For `owner-epub-get`, it also point-reads the exact `{book_id}` KV key
to reject a nonexistent book. Because the locator is inside ciphertext,
Fastly cannot prove that the requested R2 locator/ETag equals that book's inner
metadata; the client must make that comparison after decryption. The proof and
fixed class grammar prevent a bearer token alone from using this limitation to
enumerate the prefix.

`pending-get` exists because a create-only PUT may have succeeded even when
the browser lost its response and ETag. It never lists or accepts a full raw
key: Fastly constructs one exact catalog/owner/share key from the selected
class grammar. The client must require the expected length, object metadata,
computed SHA-256, and AEAD before treating the prior PUT as successful;
otherwise it abandons that random path and uploads under a new one.

For `catalog-get`, Fastly reads the head at the supplied KV generation and
signs its ETag into `If-Match`; only the client can compare the supplied random
ID with the pointer it decrypted. For `catalog-put`, Fastly requires a current
head generation, the next logical generation, and a well-formed random ID,
then signs `If-None-Match: *`; the precondition, not Fastly guessing entropy,
enforces non-overwrite. Initial creation uses the same create-only rule through
the offline administration operation.

Every PUT URL signs and requires these exact headers:

```text
Content-Type: application/octet-stream
Cache-Control: private, no-store
Content-MD5: <standard Base64 MD5 of the complete bytes>
x-amz-meta-txt-sha256: <canonical base64url SHA-256>
If-None-Match: *                       # every immutable create
```

Do not sign `Content-Length`: browser JavaScript cannot set that forbidden
header. Instead, cap the claimed length before signing, bind MD5 and SHA-256
metadata into the signature, and require actual R2 length/digest metadata in
the following commit or registration check. Limit uploads to the configured
single-`PutObject` maximum; multipart authority is not exposed.

The response is allowlisted. Its bearer URL necessarily contains the exact
object key, but it contains no separately reusable prefix authority or
credential:

```json
{
  "protocol_version": 1,
  "method": "GET | PUT",
  "url": "https://<account>.r2.cloudflarestorage.com/<bucket>/<exact-key>?X-Amz-...",
  "expires_at": "RFC 3339 timestamp within the operation's maximum lifetime",
  "required_headers": {
    "Header-Name": "exact signed value"
  }
}
```

GET URLs expire after 60 seconds and PUT URLs after at most five minutes. URLs
are reusable until expiry, so retry a network failure only when the operation
is safe: GET is safe; create-only or conditional PUT is safe. R2 omits CORS
headers on expired presigned-URL errors, so the browser treats an opaque
failure near expiry as expired and obtains one fresh exact URL; it never logs
the URL or provider body. An R2 `412` means the signed ETag/create precondition
lost and is handled as a catalog conflict or immutable-path collision; a
`BadDigest` is a local integrity bug and is not retried unchanged. Reading
state and bookmarks never use R2. See R2's
[browser CORS behavior](https://developers.cloudflare.com/r2/buckets/cors/).

Runtime Fastly never issues R2 list or delete authority. Share deletion stays
inside its fixed Fastly saga. Owner-object inventory/deletion runs only in the
isolated administration cleaner after its two-pass reference check, using a
separate narrowly held R2 token that is never returned through an API.

## `POST /v1/shares`

Purpose: register an uploaded independent share object or return a fresh grant
for an identical active registration.

The Firebase-authenticated request carries protocol version, the possession
proof bound to this exact request, the owning `book_id`, raw share ID, and
rendered share prefix/path plus the uploaded object's ETag, length, and
ciphertext SHA-256. Fastly consumes `owner-share-write`, derives the binding
from `owner_control`, constructs and normalizes exactly:

```text
{db_prefix}/shared/{share_prefix}/{share_path}
```

It hashes the identifiers and direct-HEADs the immutable R2 object, requiring
exact ETag/length/`x-amz-meta-txt-sha256`, then creates the path reservation
followed by the share entry — which stores `book_id` and integrity metadata in
plaintext alongside the hashes, per [data_model.md](data_model.md) — in
`share_control`, both as create-only writes.

Each phase has an exact postcondition. If reservation creation reports a
conflict or indeterminate result, Fastly point-reads it: the exact requested
share/path hashes mean that phase already applied and creation continues;
anything else is `409` or `503` if propagation prevents a decision. If share
creation reports a conflict or indeterminate result, Fastly point-reads the
share and reservation: exact active state, book ID, hashes, and integrity
metadata are the idempotent-retry case (return a fresh grant, no write);
anything different is `409`, and an undecidable propagation result is `503`.
See [data_model.md](data_model.md) for the cleanup reconciliation rule.

```json
{
  "registered": true,
  "grant": "<base64url grant envelope, see cryptography.md>"
}
```

## `DELETE /v1/shares`

Purpose: revoke one owner share and delete its R2 object.

The Firebase-authenticated request contains protocol version, the possession
proof bound to this exact request, raw share ID, and rendered share prefix/
path. Fastly consumes `owner-share-write` — the same scope as
`POST /v1/shares` — derives the binding from `owner_control`, reconstructs the
exact key, recomputes every hash, and requires agreement with every present
control entry. It:

1. conditionally changes `active` to `deleting`, or resumes an exact
   already-`deleting` entry;
2. deletes the exact R2 object, treating not-found as success on retry; and
3. deletes the share entry, then the path-reservation entry.

If the share entry is absent, Fastly point-reads the exact path reservation. A
matching share/path tuple resumes cleanup by deleting the object and
reservation; an absent reservation deletes the exact unregistered orphan
object and is otherwise an idempotent 204. Any present mismatched reservation,
identity, or path is a conflict, not absence. A `deleting` entry never
authorizes a new URL.

## `POST /v1/shared-url`

Purpose: exchange an anonymous capability for a 60-second exact-object R2 GET
URL. No Firebase authentication or possession proof is used — a public
recipient has neither. The bounded request carries only protocol version, raw
share ID, and current encrypted grant. Fastly:

1. applies the best-effort in-instance IP prefilter;
2. verifies and decrypts the grant;
3. reads the share entry by ID hash from `share_control`;
4. requires `active`, a matching object-path hash, and normalized path;
5. claims one `public-share-url` durable slot from the ring keyed by this
   share's own `share_id_hash`; and
6. creates a 60-second exact GET URL with signed `If-Match` for the stored
   ETag and returns the stored length/SHA-256.

The response is `Cache-Control: private, no-store` and contains the URL,
required `If-Match` header, object ETag/length/SHA-256, and no credential or R2
list permission. The recipient requires equality with the same integrity
metadata in the URL fragment before downloading. Revocation affects the next
exchange; an issued URL remains usable only for its short lifetime.

## Health endpoints

- `/health/live` confirms that the deployed Compute package can serve requests.
- `/health/ready` reads required config/secret entries and reads the
  fixed `schema_...` marker key from all four KV Stores (see
  [data_model.md](data_model.md)). It must not write, read user data, or
  presign R2 URLs.
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
| `owner-r2-url`        | 60 per hour      | owner UID            |
| `owner-vault-scan`    | 12 per hour      | owner UID            |
| `owner-vault-write`   | 100 per 10 min   | owner UID            |
| `owner-share-write`   | 20 per 10 min    | owner UID            |
| `public-share-url`    | 20 per hour      | `share_id_hash`      |

`owner-vault-scan` covers `GET /v1/vault/books?cursor=...` only — the
administrative repair/verification scan — deliberately far tighter than
ordinary reads, since each call lists across the whole `book_` key prefix and
repeatedly triggering it is a realistic way to burn the Class A/B budget
documented in [README.md](README.md).

`owner-vault-write` covers book/head commits, head-only repair, first-create
or delete reading writes, and reading-index writes. `owner-share-write` covers
both `POST /v1/shares` and `DELETE /v1/shares` — registration and revocation
share one scope. For proof-bearing calls, Fastly validates Firebase and the
proof, successfully claims the replay nonce, and only then probes the durable
admission ring. A rejected replay therefore cannot exhaust the owner's write
budget.

Two route scopes are deliberately **not** covered by a durable slot ledger and
instead rely on a best-effort in-instance request counter that resets whenever
a Compute instance is recycled and is not shared across Fastly points of
presence:

- `owner-vault-read` (`GET /v1/vault/head`, `GET /v1/vault/books/{book_id}`,
  `GET /v1/vault/reading/{book_id}`, `GET /v1/vault/reading-index`), because it
  returns ciphertext or nonsensitive head metadata only; and
- `owner-reading-replace` (only a generation-conditional existing-entry
  `PUT /v1/vault/reading/{book_id}`), because its damage is confined to one
  existing book's reading state and always repairable.

Treat both as flood control, not a security boundary: a determined caller
distributed across many points of presence can exceed the intended ceiling
before any single instance notices. That is an accepted tradeoff for these
two routes specifically, in exchange for not spending a KV Store write on
every point read and every 15-second reading-position debounce; every other
route's abuse potential is high enough that this tradeoff is not offered.

Subject identifiers for every durable limit, owner and public alike, are
HMAC-SHA-256 with `RATE_LIMIT_KEY`; store only the digest as `subject_hash` in
`rate_limit_control`. An owner-subject digest is computed only from a
**verified** Firebase subject. The anonymous share route selects its ring only
after capability validation succeeds, computing its digest as
`HMAC-SHA-256(RATE_LIMIT_KEY, share_id_hash)` — not from requester IP and not
from one deployment-wide label — so a rotating-IP attacker still cannot
multiply durable rings and exhaust free-tier Class A writes: minting a new
`share_id` requires the authenticated, already-rate-limited
`owner-share-write` route, not an anonymous request, and exhausting one
share's ring cannot deny redemption of any other active share. Its cheap
pre-verification flood control remains in-instance and IP-keyed. Each accepted
durable call consumes one create-only slot. Start probing at
a CSPRNG-random slot and walk at most the configured `N` slots; cache a known
full ring in the current instance until the fixed window ends. An existing
slot is an ordinary collision, but a provider error is 503. The configured
maximum is 120 slots per ring so an attacker cannot force an unbounded scan.
This free-tier mechanism requires no Fastly Edge Rate Limiting product.

These short windows limit bursts; their combined maxima are not a monthly cost
budget. Before any route that could create a nonce, admission slot, or
application entry, Fastly also checks the operator-controlled
`MUTATIONS_DISABLED` Config Store flag. The scheduled budget monitor sets it
before the internal Class A cutoff in [README.md](README.md#capacity-target).
When set, or when the flag cannot be read, those routes return `503` without a
KV write; ciphertext-only routes that require no durable admission remain
readable.

## Error contract

| HTTP | Code                  | Meaning                                                                            |
| ---- | --------------------- | ---------------------------------------------------------------------------------- |
| 400  | `invalid_request`     | Invalid route shape, encoding, entry, or protocol version                         |
| 401  | `unauthorized`        | Missing, invalid, expired, or wrong-owner Firebase token; invalid share capability; missing, invalid, expired, wrong-request, or replayed possession proof |
| 403  | `binding_mismatch`    | Authenticated identity does not match owner/vault binding                          |
| 404  | `not_found`           | Entry absent, or public share absent/inactive without state disclosure             |
| 409  | `conflict`            | True generation/precondition conflict, share/path collision, incompatible state transition, or mismatched catalog metadata |
| 413  | `too_large`           | Request, ciphertext entry, or page exceeds its fixed limit                         |
| 429  | `rate_limited`        | A durable slot ring or best-effort limit was exceeded; include bounded `Retry-After` |
| 502  | `upstream_invalid`    | KV Store or R2 returned an invalid or unsupported response                         |
| 503  | `control_unavailable` / `commit_pending` | Dependency unavailable, or an eventually consistent postcondition cannot yet prove whether a commit phase applied |

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
MUTATIONS_DISABLED
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
