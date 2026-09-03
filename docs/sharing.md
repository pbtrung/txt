# Public Sharing — Design

Only the authenticated owner can create or revoke a share. A recipient is
anonymous and read-only: the recipient presents a random capability plus
a grant, receives a short-lived exact-object R2 URL, downloads the
encrypted shared copy directly from R2, and decrypts it in the browser
with a key carried in the URL fragment. The Worker never proxies EPUB
bytes and never receives the share content key.

`POST /v1/shared-url` is the one `/v1/*` endpoint excluded from Cloudflare
Access (`docs/auth.md` §1); everything else here — creation and
revocation — is owner-only and requires a fresh proof of possession
(`docs/auth.md` §4).

## 1. Persisted state

D1's `shares` table (`docs/data_model.md` §2) contains, per share:

- `share_id_hash = SHA-256(raw share_id)`;
- `object_path_hash = SHA-256(exact encrypted-object path)` — never the
  path itself;
- `owner_blob`, wrapped by a per-row `key_store` key (purpose
  `share_key`), whose plaintext is `{share_id, share_content_key,
share_path}` — the owner's own durable record of a share it created,
  so the owner's browser can list active shares and know what to submit
  for revocation, without needing local-only browser storage. This blob
  plays no part in redemption (§3.3) — the grant does.
- `active`/`creating`/`deleting` state and timestamps.

D1 never stores the raw capability, the share content key, or the
plaintext object path outside that one wrapped blob.

## 2. Share URL

```text
https://sub.domain.com/shared#id=<base64url-share-id>&key=<base64url-content-key>&grant=<base64url-grant>
```

Everything after `#` is a fragment and is not sent in the initial HTTP
request; the shared page parses it locally. The content key remains only
in browser memory and browser-controlled history or clipboard state.

`share_id` must contain 32 random bytes and use canonical unpadded
base64url — a bearer capability distinct in both size and encoding from
the base32-Crockford R2 path segments (`docs/storage_layout.md`).
`share_content_key` must contain 128 random bytes. A capability or
content key is never reused across shares. `grant` is the opaque,
Worker-minted envelope described in `docs/crypto.md` §"Share grant
envelope" that decrypts to the exact object path; it is canonical
unpadded base64url and at most 512 bytes. A grant is re-minted by the
Worker every time the owner copies the URL (§4) — copying the same share
twice yields two different, independently valid grants for the same
object path.

## 3. Endpoints

### 3.1 `GET /v1/shares`

Owner-only, Access session only (no proof — a read, `docs/auth.md`
§4.3). Returns every `shares` row, joined against `key_store` for its
`key_wrapped` (avoiding N+1, the same pattern as
`GET /v1/documents/recent-access`, `docs/data_model.md` §3), so the
browser can decrypt each `owner_blob`
locally to list active shares and know what to submit for revocation
(§1):

```json
{
  "shares": [
    {
      "share_id_hash": "<base64>",
      "document_id": 0,
      "key_wrapped": "<base64>",
      "owner_blob": "<base64>",
      "state": "active",
      "created_at": 0
    }
  ]
}
```

### 3.2 `POST /v1/shares`

Owner-only. Requires the `X-Owner-Ticket`/`X-Owner-Proof` headers and the
`user_handle`/`db_prefix` body fields described in `docs/auth.md` §4.2,
alongside:

```json
{
  "user_handle": "<base64 32 bytes>",
  "db_prefix": "<52-character token>",
  "document_id": 0,
  "share_id": "<canonical base64url 32 random bytes>",
  "share_path": "<52-character segment>",
  "key_wrapped": "<base64, a fresh key_store `share_key` row's wrapped bytes>",
  "owner_blob": "<base64, {share_id, share_content_key, share_path} already encrypted client-side under that key, Blob Format>"
}
```

The browser generates `share_content_key` and encrypts `owner_blob`
itself, the same way it encrypts every other row-level blob (`docs/
crypto.md`) — the Worker never receives `share_content_key` in any form,
wrapped or plain. The Worker validates `share_id`, `share_path`, and
`document_id`, constructs `{db_prefix}/shared/{share_path}`, and inserts
a `key_store` row holding `key_wrapped` plus a `shares` row holding
`owner_blob` as opaque bytes, keyed by `SHA-256(share_id)` and
`SHA-256(object_path)` — never the object path itself. Repeating the same
capability and object path is idempotent; reusing either for different
material returns `409`. The response is:

```json
{ "registered": true, "grant": "<base64url grant envelope>" }
```

A fresh `grant` is minted on every call, including a repeated idempotent
one — this is also how the owner re-obtains a grant to copy the URL again
later (§4) without D1 ever having stored the path to look up.

| Status | Condition                                                              |
| ------ | ---------------------------------------------------------------------- |
| `200`  | Share registered (or already registered, idempotently); grant returned |
| `400`  | Malformed body or path segment                                         |
| `409`  | Capability or path reused for different material                       |

### 3.3 `POST /v1/shared-url`

No Access session and no proof required — capability possession is the
entire authorization. The rate-limiting rule (`docs/auth.md` §6) still
applies, keyed by the recipient's IP.

```json
{
  "share_id": "<canonical base64url 32-byte capability>",
  "grant": "<base64url grant envelope, see docs/crypto.md>"
}
```

The Worker decrypts `grant` with `SHARE_GRANT_KEY` to recover the object
path, hashes the capability, and selects an `active` `shares` row whose
`object_path_hash` matches `SHA-256(decrypted path)`. It does not consult
`owner_blob` or `key_store` for this — the grant alone carries what's
needed, and the hash check confirms it's still the path currently
registered and active for this capability. It then creates a SigV4
presigned `GET` for that object path and returns:

```json
{ "url": "<60-second exact-object R2 URL>", "expires_at": 0 }
```

The response uses `Cache-Control: no-store`. The signed request permits
only `GET` for one object — no list, write, delete, bucket, prefix, or
other object access. A grant that fails to decrypt at all is
distinguished (`400`) from one that decrypts but doesn't match any
`active` row (`404`, whether the `share_id_hash` is unknown or the row
is inactive) — those latter two cases are indistinguishable from each
other, without revealing which one occurred.

| Status | Condition                                           |
| ------ | --------------------------------------------------- |
| `200`  | Exact-object 60-second URL returned                 |
| `400`  | Malformed capability or grant that fails to decrypt |
| `404`  | No active share matching this capability and grant  |
| `429`  | Rate limit exceeded                                 |

### 3.4 `DELETE /v1/shares`

Owner-only (`X-Owner-Ticket`/`X-Owner-Proof` headers, `docs/auth.md`
§4.2). No grant is needed here — the owner already holds `document_id`
and the share's own `share_path` locally (from creating it, or from
decrypting its own `owner_blob`), and sends `share_path` again in
plaintext so the Worker can re-derive the hash itself without ever
decrypting `owner_blob` (which it cannot — it never holds the key that
wraps it):

```json
{
  "user_handle": "<base64 32 bytes>",
  "db_prefix": "<52-character token>",
  "document_id": 0,
  "share_id": "<canonical base64url 32 random bytes>",
  "share_path": "<52-character segment>"
}
```

The Worker looks up the row by `SHA-256(share_id)`, checks its
`document_id` matches, re-derives `object_path_hash` from
`{db_prefix}/shared/{share_path}` and checks it matches the row's stored
value, and atomically transitions `active` → `deleting`, which
immediately blocks new presigned URLs from §3.3 (any grant decrypted
afterward still fails the `active`-row lookup).
No row for that `share_id` is treated as already deleted — `204` with no
further action. Once `deleting`, the Worker deletes the exact R2 object;
a `404` from R2 is treated as success. After successful deletion, it
deletes the `shares` row, which fires `trg_shares_delete_key`
(`docs/data_model.md` §2), cleaning up the row's `key_store` entry
automatically, and returns `204`.

If R2 deletion fails, the row stays `deleting`: the share remains revoked
and the owner can retry. A URL issued before revocation can remain usable
until its 60-second expiry unless the object is already gone.

| Status | Condition                                                  |
| ------ | ----------------------------------------------------------- |
| `204`  | Revoked (or already absent)                                |
| `400`  | Row exists but its `document_id`/`share_path` don't match  |
| `409`  | Row exists but isn't `active` (e.g. already `deleting`)    |
| `503`  | R2 deletion failed; row remains `deleting` for retry       |

## 4. Creation flow

1. The owner selects a document to share.
2. The browser generates `share_id`, `share_content_key`, and
   `share_path` independently with `crypto.getRandomValues`. D1 is the
   only durable state for a share — the browser keeps no local
   "creating"/"deleting" bookkeeping of its own to keep in sync; a
   share is either registered on the server or it isn't.
3. The browser decrypts the owner's EPUB locally and encrypts a new
   immutable copy under `share_content_key` using the same Blob Format
   used for D1 rows (`docs/crypto.md`) — no change from how the rest of
   this design encrypts content.
4. Using its temporary `{db_prefix}/shared/*` credential
   (`docs/storage_layout.md`), the browser uploads the copy with
   `If-None-Match: *`.
5. The browser mints a fresh `key_store`-backed key, wraps
   `{share_id, share_content_key, share_path}` into `owner_blob` under it
   (Blob Format, `docs/crypto.md`), and calls `POST /v1/shares` (§3.2)
   with `key_wrapped`, `owner_blob`, and a fresh proof, then discards
   the grant in that response — creation and copying are independent
   actions.
6. Separately, whenever the owner copies the share link (immediately
   after creation, or any time later), the browser calls `POST
/v1/shares` again (idempotent) purely to obtain a fresh `grant`, then
   constructs the fragment URL and copies it. The complete URL is never
   stored in D1 or R2.

A failed upload or registration surfaces as an error to the owner, who
can simply retry the Share action from scratch — since no local state
is kept, a retry generates entirely new `share_id`/`share_content_key`/
`share_path` material rather than resuming the failed attempt. The
owner cannot delete the source document
while a share row references it (`shares.document_id ... ON DELETE
RESTRICT`).

## 5. Recipient flow

1. The recipient opens the public URL. The fragment stays out of the
   navigation request and referrer.
2. The shared page validates and retains the capability, content key,
   and grant in memory.
3. It posts the capability and grant to `POST /v1/shared-url` (§3.3).
4. It immediately fetches the encrypted EPUB from the returned R2 URL.
5. It decrypts (the same Blob Format used everywhere else,
   `docs/crypto.md`) and renders the EPUB locally. The Worker sees
   neither the EPUB bytes nor the decryption key.

Recipient bookmarks and reading position remain in browser-local storage
keyed by the capability. They never modify the owner's D1 rows. EPUB
scripts remain disabled, and section frames use a restrictive
content-security policy.

## 6. R2 CORS and headers

The R2 bucket allows the exact deployed UI origin to perform shared `GET`
and owner `GET`/`PUT` requests (`docs/storage_layout.md`). The shared
object response uses `Content-Type: application/octet-stream` and
`Cache-Control: private, no-store`. Presigned URLs, capabilities, and
grants must not be written to application logs.

## 7. Security properties

- A copied D1 export does not reveal a usable capability, content key, or
  the plaintext object path — only `SHA-256` digests, plus the owner's
  own wrapped `owner_blob`, itself opaque without `umk`.
- A copied public URL grants read access to that shared copy by design.
- Guessing a 256-bit capability is infeasible.
- Forging a grant without `SHARE_GRANT_KEY` is infeasible; a grant
  decrypted under the wrong `share_id` fails its additional-data check
  (`docs/crypto.md`).
- The presigned URL reveals an opaque object path but expires after 60
  seconds and cannot authorize a different request.
- Revocation blocks new URLs immediately and deletes the encrypted
  object.
- Revocation cannot erase plaintext or ciphertext a recipient already
  saved.
- `POST /v1/shared-url` is an abuse-control boundary (rate limiting), not
  an identity boundary; capability possession is the authorization.
