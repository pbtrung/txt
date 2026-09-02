# Authentication and Authorization — Design

There is exactly one authenticated principal: the owner. Cloudflare Access
proves the owner's identity at the edge; the Worker never accepts a request
to `/v1/*` from anyone Access didn't already authenticate as `OWNER_EMAIL`,
except the one public redemption endpoint. Anonymous recipients are not
accounts. They can only redeem an owner-created share capability for a
short-lived read as described in `docs/sharing.md`.

## 1. Topology

One Worker serves the whole `sub.domain.com` host. Requests to `/v1/*` run
the API's route handlers; every other request falls through to the
Worker's static assets binding (`dist/`, built from the React UI),
configured with `not_found_handling: "single-page-application"` so
client-side routes resolve to `index.html`. The Worker holds a D1 binding
(`docs/data_model.md`) and an R2 binding used only to mint scoped,
time-limited credentials for direct browser-to-R2 transfer of EPUB bytes
(`docs/storage_layout.md`) — the Worker itself never proxies document
content.

A Cloudflare Access application gates only `/v1/*` at the edge, before any
request reaches the Worker — not the whole `sub.domain.com` host. The one
exclusion within `/v1/*` is `POST /v1/shared-url`, which stays reachable
by anonymous recipients redeeming a share.

Static assets (the SPA shell — `index.html` and its JS/CSS bundle) are
never gated by Access, for anyone. They carry no confidential data, and
the owner's authenticated app and the public shared-reading page are
served from the _same_ single-page bundle: gating asset paths would also
block the shared-reading page's own JS/CSS from loading for a recipient
who was never meant to pass Access in the first place, since a browser
that fetches `/shared#...` still has to fetch its script and style assets
from other, unrelated paths before it can render anything. What actually
needs protecting — wrapped key material and the ability to mutate the
library — lives entirely behind `/v1/*`.

A `fetch()` to a gated `/v1/*` path from a browser without a valid Access
session doesn't reach the Worker at all — Access intercepts it and
responds with its own login challenge, typically an HTML redirect to the
Access login page, not a JSON body or a clean `401`. The UI treats that
response shape (a non-JSON body, a redirect, or a cross-origin failure if
`fetch()` follows the redirect into Access's login domain) as "not logged
in, prompt to authenticate."

## 2. Cloudflare Access

A Cloudflare Access application in front of `/v1/*` is configured with
exactly one policy: `Include: emails equals OWNER_EMAIL`, using either the
One-Time PIN login method (an emailed code, no external identity
provider) or a Google login restricted to that one address — both are
available on Access's free plan, which covers up to 50 authenticated
seats at no cost; this app uses one.

Use the Google option only if that Google account already has a passkey
or hardware security key enrolled: without one, Google login is
single-factor (password) just like One-Time PIN, and a bare password on a
heavily phished account is arguably worse than an emailed code, not
better — the security gain from choosing Google comes entirely from the
phishing-resistant second factor, not from the provider name. If that
isn't already true of the account, One-Time PIN is the simpler,
self-contained choice: it doesn't tie the front door to a separately
managed third-party account's security posture drifting over time.

Access forwards every gated request to the Worker with a signed
`Cf-Access-Jwt-Assertion` header. The Worker verifies it independently —
signature against the team domain's JWKS, `aud` equal to the Access
application's tag, `exp`, and `email` equal to the configured
`OWNER_EMAIL` — rather than trusting the edge unconditionally, and uses
the verified email as the authenticated identity embedded in the owner
binding ticket (§4.1).

**Why Access alone isn't enough for a mutation.** Access establishes that
_this browser session_ logged in as the owner and is authorized to reach
`/v1/*` at all. It says nothing about whether the caller also possesses
`user_root_key` and the resulting unwrapped P-521 signing key — material
that never leaves unlocked browser memory and that Access never sees. A
stolen `Cf-Access-Jwt-Assertion` / `CF_Authorization` session cookie is,
from the Worker's perspective, just a bearer credential: without also
stealing the unlock file's `user_root_key` and completing the unwrap, an
attacker holding only the Access session cannot produce a valid proof
(§4) and therefore cannot obtain R2 write credentials or mutate any row
in D1. Every D1-_mutating_ `/v1/*` endpoint and R2 credential minting
require proof of possession, not just a valid Access session; reads stay
behind the Access JWT alone, since a read only ever returns opaque
per-row ciphertext (`docs/data_model.md` §1) and an attacker without
`umk` gains nothing exploitable from it.

## 3. Owner record

D1's singleton `owner` row (`docs/data_model.md` §2) stores the hash of
the owner's email, wrapped key material, the hash of the owner's private
handle, the `db_prefix` binding, and the public half of the P-521 signing
key. It contains no role or account-type column.

The encrypted credential payload (`owner.encrypted_credentials`) has this
shape:

```json
{
  "user_handle": "<base64 32 bytes>",
  "display_name": "...",
  "db_prefix": "<52-character token>"
}
```

`db_prefix` is an independently random 32-byte value rendered as 52
lowercase base32-Crockford characters (`docs/storage_layout.md`). D1
stores only `SHA-256(db_prefix)`; the raw value, the unwrapped owner
master key, and the unwrapped signing private key exist only in
provisioning or unlocked browser memory.

## 4. Owner binding ticket and proof of possession

### 4.1 Ticket issuance

The Worker verifies the Access JWT and reads the singleton `owner` row,
returning the owner's wrapped key material plus a 24-hour HS256 ticket:

```json
{
  "v": 1,
  "aud": "r2-token",
  "sub": "<owner email>",
  "jti": "<base64url 32 random bytes>",
  "user_handle_hash": "<base64url SHA-256(handle)>",
  "sign_public_key": "<base64url SPKI DER>",
  "db_binding_hash": "<base64url SHA-256(db_prefix)>",
  "iat": 0,
  "exp": 0
}
```

| Status | Condition                                          |
| ------ | -------------------------------------------------- |
| `200`  | Wrapped owner material and ticket returned         |
| `401`  | Missing or invalid Access session                  |
| `403`  | Verified email is not the configured `OWNER_EMAIL` |
| `429`  | Rate limit exceeded (`docs/deployment.md` §2.3)    |

### 4.2 Proof of possession

The browser unwraps `umk` (with `user_root_key`) and the P-521 signing
private key (with `umk`) entirely in memory. For every D1-mutating
request or R2 credential request, it signs a fresh proof over the exact
ticket, the request itself, and the `db_prefix` binding:

```json
{
  "ticket": "<exact compact JWS returned by ticket issuance>",
  "proof": {
    "version": 1,
    "expires_at": 0,
    "request_id": "<base64 32 random bytes>",
    "signature": "<base64 raw P-521 signature>"
  }
}
```

The signed canonical bytes are (see `docs/crypto.md` §3 for the signing
mechanics):

```
UTF8("txt:owner-proof:v1") || 0x00 ||
SHA-256(UTF8(exact_compact_ticket)) ||
user_handle_32_bytes ||
U64BE(expires_at_unix_seconds) ||
request_id_32_bytes ||
SHA-256(UTF8(db_prefix)) ||
SHA-256(UTF8(method) || 0x00 || UTF8(path) || 0x00 || body)
```

Binding the exact HTTP method, full request path, and body — not just an
abstract "operation name" — matters because a target id such as a
bookmark or share id typically travels in the URL (e.g. `DELETE
/v1/bookmarks/{id}`) rather than in an otherwise-empty body: a proof that
only covered the body would look identical for two different targets of
the same operation, letting a captured proof for "delete bookmark #5" be
replayed against bookmark #7. Hashing the full method-and-path together
with the body closes that. `expires_at` is at most 60 seconds after the
Worker's clock.

The Worker verifies the ticket, re-derives the canonical bytes for the
exact request it received, and verifies the signature with the ticket's
`sign_public_key`. A valid signature proves possession of the owner's
unwrapped private key; the `db_binding_hash` check proves the caller also
knows the raw `db_prefix`, which only unwrapping the credential payload
(§3) can reveal.

| Status      | Condition                                                     |
| ----------- | ------------------------------------------------------------- |
| `200`/`204` | Mutation applied, or R2 credential returned                   |
| `400`       | Malformed ticket, proof, or request body                      |
| `401`       | Ticket invalid, expired, or proof expiry exceeded             |
| `403`       | Owner subject, binding, or signature mismatch                 |
| `412`       | `documents.access_version` conflict (`docs/data_model.md` §4) |
| `429`       | Rate limit exceeded                                           |

### 4.3 Endpoint scope

Every mutating `/v1/*` endpoint — reading-state updates, bookmark writes,
share create/delete — and the R2 credential endpoint require a ticket and
proof. Read endpoints (library listing, ticket issuance itself) require
only a valid Access session. `POST /v1/shared-url` requires neither: it
has no Access session to check and authenticates purely by capability
possession (`docs/sharing.md`).

## 5. Owner session

1. The owner selects the local unlock file, containing `user_root_key`.
2. The browser completes Cloudflare Access login if it doesn't already
   have a session, then requests an owner binding ticket (§4.1).
3. The browser unwraps `umk`, the credential payload, and the P-521
   private key entirely in memory.
4. The browser signs a proof (§4.2) and requests 15-minute R2
   credentials (`docs/storage_layout.md`).
5. The browser renews R2 credentials with a fresh proof against the same
   ticket until the ticket's 24-hour expiry, then re-authenticates
   through Access for a new ticket.
6. Locking or reloading releases the unlock credentials, unwrapped keys,
   ticket, and any temporary R2 credentials from the page.

## 6. Rate limiting

Cloudflare's WAF rate-limiting rules on the free plan give this zone
exactly one custom rule. One rule, matching every path under `/v1/*` with
**URI Path** added to its counting characteristics, still keeps a
separate counter per endpoint — the rule does not collapse different
`/v1/*` endpoints into one shared counter. Counting happens at
Cloudflare's edge, before a request reaches the Worker or D1.

Configured rule (set directly in the Cloudflare dashboard):

- Match: `starts_with(http.request.uri.path, "/v1/")`
- Counting characteristics: `ip.src` and URI Path
- Period / threshold: 10 seconds / 20 requests
- Action: Block (or Managed Challenge for a softer response on the public
  endpoint)

20 requests per 10 seconds bounds `POST /v1/shared-url` — the one
endpoint facing unauthenticated internet traffic — at burst granularity.
Applied to the owner-only endpoints (already behind Access), the same
rule bounds a compromised or malfunctioning owner session rather than
anonymous volume. Because counting happens in Cloudflare's own edge
infrastructure, rate limiting is part of Cloudflare's availability, not a
dependency this application has to reason about failing open or closed.

## 7. Trust boundary

The unlocked browser and the Worker are trusted. D1 is trusted for
authorization state and durability but receives only wrapped or encrypted
owner material and hashes, never plaintext content or an unwrapped key —
rate limiting lives entirely at Cloudflare's edge, so D1 holds no counter
state either. R2 is trusted for object durability but not plaintext
confidentiality. Cloudflare Access is trusted to gate request arrival to
the one configured owner identity, which is sufficient on its own for
reads; it is never a substitute for proof of possession on any endpoint
that mutates D1 or mints R2 credentials.

The Worker does not hold `user_root_key`, `umk` unwrapped, any per-row
key from `key_store` unwrapped, the raw P-521 private key, or any share
content key. A compromised Worker can authorize R2 access — it is inside
the trusted computing base — but a copied D1 export alone cannot decrypt
the library.

## 8. Incident response

| Event                           | Response                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Access session compromised      | Revoke the session in the Access dashboard; every ticket/proof still requires `user_root_key`, which the session alone doesn't grant |
| Signing private key exposed     | Re-provision the signing key; existing tickets referencing the old `sign_public_key` stop verifying once the `owner` row is updated  |
| Temporary R2 credential exposed | It expires after at most 15 minutes                                                                                                  |
| `SHARE_GRANT_KEY` exposed       | Rotate it and redeploy; every outstanding grant stops decrypting and any copied share URL must be re-copied (`docs/sharing.md`)      |
| `user_root_key` lost            | Restore from the protected owner credential backup; the server cannot reconstruct it                                                 |
| D1 export leaked                | No usable plaintext, capability, or unwrapped key is exposed — rotate `user_root_key` and re-wrap if the leak's scope is uncertain   |
