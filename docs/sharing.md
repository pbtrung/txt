# Public Sharing — Design

Only the authenticated owner can create or revoke a share. A recipient is
anonymous and read-only: the recipient presents a random capability, receives a
short-lived exact-object R2 URL, downloads the encrypted shared copy directly
from R2, and decrypts it in the browser with a key carried in the original URL
fragment.

The Northflank API never proxies EPUB bytes and never receives the share content
key.

## 1. Configuration

| Name                                                             | Purpose                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `SHARE_URL_TTL_SECONDS`                                          | Lifetime of an exact-object R2 GET URL; fixed to 60 seconds initially           |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION`                          | R2 target used to construct the signed request                                  |
| `R2_READ_WRITE_ACCESS_KEY_ID`, `R2_READ_WRITE_SECRET_ACCESS_KEY` | Parent credential used only inside the API to presign and delete shared objects |
| `UI_ORIGIN`                                                      | Exact origin allowed to redeem and download a share                             |
| `RATE_LIMIT_KEY`                                                 | Key for hashing public rate-limit subjects before rqlite storage                |
| `SHARE_GRANT_KEY`                                                | Independent 32-byte secret; encrypts/decrypts the opaque object-path grant carried in a share URL |

The 32-byte random `share_id` is the bearer capability. rqlite maps its
SHA-256 digest to a share row, but the exact R2 object path is never persisted
there — it exists only as `object_path_hash`, and as ciphertext inside the
grant carried by the share URL itself (§4.4).

## 2. Persisted state

The owner's encrypted SQLCipher database contains a `txt_shares` row with the
raw capability, independent 128-byte content key, and random object-key segments.
That row is private owner data.

rqlite contains only:

- `SHA-256(raw_share_id)`;
- `SHA-256(exact encrypted-object path)`, never the path itself;
- `active` or `deleting` state;
- creation and update timestamps.

rqlite never stores the raw capability, the share content key, or the plaintext
object path. The schema is defined in `docs/control_database.md`.

## 3. Share URL

The public URL has this conceptual form:

```text
https://reader.example/shared#id=<base64url-share-id>&key=<base64url-content-key>&api=<encoded-api-origin>&grant=<base64url-grant>
```

Everything after `#` is a fragment and is not sent in the initial HTTP request.
The shared page parses it locally. The content key remains only in browser
memory and browser-controlled history or clipboard state.

The capability must contain 32 random bytes and use canonical unpadded
base64url. The content key must contain 128 random bytes. `api` is the exact
HTTPS origin derived from the owner's `rqlite_db_url`; localhost HTTP is allowed
only for development. `grant` is the opaque, API-minted envelope described in
§4.4 that decrypts to the exact object path; it is canonical unpadded base64url
and at most 512 bytes. New shares always receive new capability and content-key
values; a capability or content key is never reused. A grant, by contrast, is
re-minted by the API every time the owner copies the URL (§5) — copying the
same share twice yields two different, independently valid grants for the same
object path.

## 4. Endpoints

### 4.1 `POST /v1/shares`

This owner-only endpoint registers an uploaded encrypted shared copy:

```http
POST /v1/shares
Authorization: Bearer <owner Firebase ID token>
Content-Type: application/json
```

```json
{
  "db_path": "<owner database path>",
  "db_prefix": "<owner content prefix>",
  "share_prefix": "<52-character segment>",
  "share_path": "<52-character segment>",
  "share_id": "<canonical base64url 32 random bytes>"
}
```

The API requires the configured owner UID, checks the submitted path-pair
binding against `owner_control.db_binding_hash`, validates every path segment,
constructs `{db_prefix}/shared/{share_prefix}/{share_path}`, and inserts a row
keyed by `SHA-256(share_id)` and `SHA-256(object_path)` — never the object path
itself. Repeating the same capability and object path is idempotent; reusing
either one for different material returns `409`. The response is:

```json
{
  "registered": true,
  "grant": "<base64url grant envelope, see §4.4>"
}
```

A fresh `grant` is minted on every call, including a repeated idempotent one —
this is also how the owner re-obtains a grant to copy the URL again later
(§5) without rqlite ever having stored the path to look up.

### 4.2 `POST /v1/shared-url`

This endpoint requires no identity token, but the proxy accepts it only when the
browser request origin exactly equals `UI_ORIGIN`:

```json
{
  "share_id": "<canonical base64url 32-byte capability>",
  "grant": "<base64url grant envelope, see §4.4>"
}
```

The API accepts at most 512 bytes of JSON, applies the `public-share-url` rqlite
rate limit, decrypts the grant with `SHARE_GRANT_KEY` to recover the object
path, hashes the capability, and selects an `active` share whose
`object_path_hash` matches `SHA-256(decrypted path)`. It then creates a SigV4
presigned `GET` for that object path and returns:

```json
{
  "url": "<60-second exact-object R2 URL>",
  "expires_at": 0
}
```

The response uses `Cache-Control: no-store`. The signed request permits only
`GET` for one object. It grants no list, write, delete, bucket, prefix, or other
object access. A recipient must start the request before expiry; the browser
downloads the full encrypted blob before decrypting it.

### 4.3 `DELETE /v1/shares`

This owner-only endpoint accepts the same path-bound body as `POST /v1/shares`
(§4.1) — the owner already holds `db_path`/`db_prefix` and the share's own
`share_prefix`/`share_path` locally, so no grant is needed here; the Firebase
bearer token and the `db_binding_hash` check are the authorization:

```json
{
  "db_path": "<owner database path>",
  "db_prefix": "<owner content prefix>",
  "share_prefix": "<52-character shared-object segment>",
  "share_path": "<52-character shared-object segment>",
  "share_id": "<canonical base64url 32 random bytes>"
}
```

The API re-derives the object path, checks its hash against the row selected by
`SHA-256(share_id)`, and atomically changes the row from `active` to
`deleting`, which immediately blocks new presigned URLs. It then deletes the
exact R2 object. An R2 `404` is treated as success. After successful deletion,
it removes the rqlite row and returns `204`.

If R2 deletion fails, the row remains `deleting`: the share remains revoked and
the owner can retry deletion. A URL issued before revocation can remain usable
until its 60-second expiry unless object deletion has already completed.

### 4.4 Object-path grants

A grant is how the exact R2 object path travels from the API to a share URL
and back, without ever being written to rqlite. `id_hash = SHA-256(raw
share_id)`. The API derives a fresh per-grant XChaCha20-Poly1305 key from
`SHARE_GRANT_KEY` using HKDF-SHA-256 with a random 32-byte salt and
`info = "txt:share-grant-key:v1" || id_hash`, then encrypts the exact object
path with a random 24-byte nonce and associated data
`"txt:share-grant:v1" || id_hash` (binding the grant to its own `share_id` so
it cannot be replayed against a different one):

```text
grant = base64url(0x01 || salt_32 || nonce_24 || XChaCha20-Poly1305(ciphertext || tag))
```

XChaCha20-Poly1305 is implemented through libsodium rather than OpenSSL, which
has no XChaCha20 cipher; the gateway calls it directly through a LuaJIT FFI
binding.

Only the API (holding `SHARE_GRANT_KEY`) can produce or open a grant. Decrypting
it recovers the object path, which the API then re-hashes and compares against
the row's `object_path_hash` before doing anything with it — the grant proves
the caller was handed a real object path by the API, and the hash check proves
that path is still the one currently registered for this `share_id`.

## 5. Creation flow

1. The owner selects a book to share.
2. The browser generates `share_id`, `share_content_key`, `share_prefix`, and
   `share_path` independently with `crypto.getRandomValues`.
3. The browser commits a local `txt_shares` row in `creating` state.
4. The browser decrypts the owner EPUB locally and encrypts a new immutable copy
   under `share_content_key`.
5. Using the owner's temporary prefix credential, the browser uploads the copy
   with `If-None-Match: *`.
6. The browser calls `POST /v1/shares`. After registration succeeds, it commits
   local state as `active`, discarding the grant in that response — creation
   and copying are independent actions.
7. Separately, whenever the owner copies the share link (immediately after
   creation, or any time later), the browser calls `POST /v1/shares` again
   (idempotent) purely to obtain a fresh `grant`, then constructs the fragment
   URL and copies it. The complete URL is not stored in rqlite, R2, or the
   owner's local database.

A failed upload or registration leaves a visible `creating` row that can be
retried or cleaned up. The owner cannot delete the source book while a share row
references it.

## 6. Recipient flow

1. The recipient opens the public URL. The fragment stays out of the navigation
   request and referrer.
2. The shared page validates and retains the capability, content key, and
   grant in memory.
3. It posts the capability and grant to `{api}/v1/shared-url`.
4. It immediately fetches the encrypted EPUB from the returned R2 URL.
5. It decrypts and renders the EPUB locally. The API sees neither EPUB bytes nor
   the decryption key.

Recipient bookmarks and reading position remain in browser-local storage keyed
by the capability. They never modify the owner's SQLCipher database. EPUB scripts
remain disabled, and section frames use a restrictive content-security policy.

## 7. R2 CORS and headers

The R2 bucket allows the exact `UI_ORIGIN` to perform shared `GET` and owner
`GET`/`PUT` requests. The trusted gateway deletes a revoked share with its
server-held parent credential after first marking the registry row as deleting.
Bucket CORS allows `Range`, `Cache-Control`, conditional-write headers, and the
SigV4 headers emitted by the client, and exposes `ETag`, `Content-Length`,
`Content-Range`, and `Accept-Ranges`. Wildcard origins are forbidden.

The shared object response uses `Content-Type: application/octet-stream` and
`Cache-Control: private, no-store`. Presigned URLs and capabilities must not be
written to application logs.

OpenResty rejects every `/v1/*` request whose `Origin` header is absent or does
not exactly match `UI_ORIGIN`. This is an origin boundary, not recipient
authentication: possession of the random share capability remains the public
read authorization.

## 8. Security properties

- A copied rqlite database does not reveal a usable capability, content key, or
  the plaintext object path — only `SHA-256` digests of the capability and the
  object path.
- A copied public URL grants read access to that shared copy by design.
- Guessing a 256-bit capability is infeasible.
- Forging a grant without `SHARE_GRANT_KEY` is infeasible; a grant decrypted
  under the wrong `share_id` fails its associated-data check.
- The presigned URL reveals an opaque object path but expires after 60 seconds
  and cannot authorize a different request.
- Revocation blocks new URLs immediately and deletes the encrypted object.
- Revocation cannot erase plaintext or ciphertext a recipient already saved.
- The public endpoint is an abuse-control boundary, not an identity boundary;
  capability possession is the authorization.
