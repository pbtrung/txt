# Sharing protocol and lifecycle

Sharing is an explicit independent-copy design. A share recipient gets no
owner account, KV Store access, owner EPUB key, owner R2 prefix credential, or
server-side reading state. Revocation is a server registry decision and takes
effect for new signed-URL exchanges.

## Owner-side share record

Each `vault` key `{book_id}` contains its shares as defined in
[data_model.md](data_model.md), alongside that book's content locator and
catalog metadata. The R2 layout for a shared object is:

```text
{db_prefix}/shared/{share_prefix}/{share_path}
```

The owner-side `share_id`, `share_content_key`, prefix, path, state,
timestamps, ordering, and R2 integrity metadata are end-to-end encrypted in
the book entry and library snapshot. Fastly sees the raw ID/path only in
authenticated owner API calls and stores path/ID hashes plus nonsensitive
ETag/length/digest in the server-only `share_control` store.

## Creating a share

The browser performs a recoverable saga:

1. Fetch and decrypt the current book entry.
2. Generate a fresh 32-byte `share_id`, 128-byte `share_content_key`, 32-byte
   `share_prefix`, and 32-byte `share_path` using the cryptographic RNG.
3. Append a `creating` share record and commit the book entry plus derived
   snapshot through the idempotent publication protocol, using the current
   book/head `generation` values.
4. If the immutable owner EPUB is not already in memory, obtain an exact
   `owner-epub-get` URL through `/v1/r2-url`, download, verify its encrypted
   book locator metadata, and decrypt it. Encrypt a new independent shared copy
   with `share_content_key`; never reuse or wrap the owner `txt_key`.
5. Obtain an exact `share-put` URL bound to the path, `If-None-Match: *`,
   content type, Content-MD5, and SHA-256 metadata; upload the shared
   ciphertext and record its ETag/length/digest. On a retry, accept an existing
   object only after a `pending-get` exact URL fetch and full local verification.
6. Fill those integrity fields while the encrypted owner record remains
   `creating`, and republish it through `/v1/vault/commit`. This makes the
   expected immutable bytes durable before registration.
7. Call `POST /v1/shares` with Firebase owner authentication, the possession
   proof bound to this exact request, the book's `book_id`, and uploaded
   ETag/length/SHA-256. Fastly stores the book ID and integrity metadata in
   plaintext alongside path hashes so later reconciliation can work without
   decrypting the library. It derives owner/vault binding from its owner entry.
8. Fastly validates the Firebase token, possession proof, binding, and a direct
   R2 HEAD against the submitted ETag/length/SHA-256 metadata, then reserves
   the share ID/path in `share_control` and returns a fresh authenticated grant.
9. Change the encrypted owner record from `creating` to `active` and republish
   through the normal conflict-replay protocol.
10. Construct the public URL locally. Capability and decryption material belong
   in the URL fragment, together with expected object ETag/length/SHA-256, so
   normal HTTP requests and referrers do not disclose them.

The UI exposes Copy Link only after step 9 succeeds. A failure after step 3
leaves visible `creating` state and a retry action, not a fabricated active
link. A failure after server registration may retry the identical registration;
Fastly returns a fresh grant for an identical active hash pair, allowing
the browser to finish step 9.

## Copying an existing link

For an `active` owner share, Copy Link calls `POST /v1/shares` again with the
same authenticated identity and exact share tuple. Fastly requires the
same active book ID, share/path hashes, and integrity metadata and returns a
newly encrypted grant. It must not create a second registry entry or upload
another R2 copy.

The browser then reconstructs the fragment locally from the owner-side
encrypted share record and returned grant. A registry collision or a path that
does not exactly match the existing registration is a conflict requiring user
attention.

## Anonymous read

1. The share page parses capability/decryption values from the URL fragment and
   removes or masks the fragment from visible navigation history where the
   current UI already does so.
2. It sends only the raw `share_id` and encrypted grant to
   `POST /v1/shared-url`.
3. Fastly applies the best-effort in-instance IP prefilter, authenticates the
   grant, reads the server-only hashed registry entry, requires `active` plus
   an exact path-hash match, and claims the deployment-global durable slot.
4. It returns a 60-second R2 URL granting GET for one object, signed
   `If-Match`, and the registry's expected integrity metadata.
5. The browser requires registry and fragment ETag/length/SHA-256 equality,
   sends the required `If-Match`, hashes the ciphertext, and then decrypts it
   with `share_content_key`. Any mismatch fails closed without plaintext.

Recipient reading progress, CFI, font choice, and bookmarks are local browser
state only. They never write KV Store or the owner snapshot. The existing
read-only reader restrictions remain; no editing, re-sharing, owner metadata
mutation, or R2 upload path is exposed.

Public failures deliberately do not distinguish absent, revoked, deleting,
malformed, or mismatched shares. A recipient can continue using an already
issued exact-object URL only until that URL's short expiry.

## Deleting a share

The owner browser performs the inverse recoverable saga:

1. Change `active` or recoverable `creating` state to `deleting` in the
   encrypted book entry and republish the snapshot.
2. Call `DELETE /v1/shares` with Firebase authentication, the possession proof
   bound to this exact request and the share tuple. Fastly derives owner/vault
   binding from its stored owner entry. No grant is needed or retained by the
   owner.
3. Fastly conditionally changes `active` to `deleting`; a deleting share can
   no longer mint a public URL.
4. Fastly deletes the exact shared R2 object. Not-found is idempotent
   success for an otherwise matching record.
5. Fastly deletes the share entry, then the path-reservation entry.
6. The browser removes the local share record and republishes the snapshot.

If the API call fails, keep `deleting` visible and retry it. If the browser
crashes after server deletion but before the local update, an idempotent retry
returns success and step 6 completes. Never reactivate a deleting server
entry.

A `creating` share that was never registered can be cleaned locally after the
browser verifies no matching active registry through the authenticated owner
delete endpoint; the server must still normalize and delete the exact orphan R2
path before returning success.

## Book deletion invariant

The UI, data store, CLI, and repair tool all reject source-book deletion while
the encrypted `shares` array is non-empty, regardless of share state. The owner
must finish deleting every active, creating, or deleting share first. This
prevents loss of the only owner-side share key/identity required to retry
cleanup. Fastly cannot enforce this itself — `shares` lives inside ciphertext
it never decrypts — so this is a client-side invariant backed by the
Recovery reconciliation table below, not a preventive server control.

## Concurrent devices and conflict handling

All local share transitions are semantic book mutations and therefore use the
book entry and catalog-head KV `generation` conditions. On conflict, refetch/
decrypt and reapply by `share_id`; do not replace the entire shares array from
stale memory.

- Creating an already-present identical share is idempotent.
- Creating the same ID with different key/path values is a hard conflict.
- Activating requires current local state `creating` and matching identity.
- Marking deleting is idempotent for an already `deleting` matching record.
- Removing requires `deleting`; it must not erase a concurrently replaced
  record with the same array position.

The server registry independently uses KV Store conditional writes for its
own two entries. Client `generation` correctness never substitutes for
server-side share authorization.

## Recovery reconciliation

The administration CLI provides a read-only report and explicit repair mode.
Because every `share_control` entry carries a plaintext `book_id`
([data_model.md](data_model.md)), the report looks up each entry's owning
book directly rather than decrypting the whole library to find which book's
`shares` array contains a matching hash:

| Owner encrypted state | Server registry | R2 object | Action                                                                             |
| --------------------- | --------------- | --------- | ---------------------------------------------------------------------------------- |
| `creating`            | absent          | absent    | retry encryption/upload or remove after confirmation                               |
| `creating`            | absent          | present/exact | retry registration                                                              |
| `creating`            | absent          | present/mismatch | delete the exact orphan and retry with fresh immutable bytes/path              |
| `creating`            | active          | present/exact | issue fresh grant and mark owner state active                                   |
| `creating`            | active          | absent/mismatch | quarantine; revoke the broken registry before retrying creation               |
| `active`              | active          | present/exact | healthy                                                                         |
| `active`              | active          | absent/mismatch | quarantine; do not issue/use a link; explicitly repair or revoke              |
| `active`              | absent/deleting | any       | block Copy Link; complete deletion or re-register only with an exact binding match |
| `deleting`            | active/deleting | any       | retry server deletion                                                              |
| `deleting`            | absent          | present   | retry exact orphan-object deletion, then remove owner state                        |
| `deleting`            | absent          | absent    | remove owner record                                                                |
| absent                | active/deleting | any       | report orphan; require explicit revocation before deletion                         |

`present/exact` means every present owner/registry ETag, length, and ciphertext
SHA-256 agrees with R2; for `active`, all three copies must agree. A pre-upload
`creating` row with null metadata is not exact: recovery must download the
exact path, verify length/hash and AEAD, persist those fields while still
`creating`, and only then register it. Existence alone is never healthy.

Automated repair may only take idempotent actions that cannot publish a new
capability. Creating/re-registering an anonymous share after ambiguous state
requires explicit owner confirmation.

A path reservation with no matching share entry is a distinct case, described
in [data_model.md](data_model.md): it means the two-step share registration
was interrupted between its first and second write. An exact owner retry
resumes registration from that reservation. Administrative cleanup removes it
only after the grace period and a second absence check; owner cancellation uses
the proof-bearing delete route to remove the exact R2 object and reservation.

## Tests required before cutover

- A share uses ciphertext/key material independent from its source EPUB.
- Raw share IDs and paths do not appear in KV Store control entries or logs.
- No browser response contains an R2 credential, prefix/list authority, or
  DELETE URL; every owner URL is method/object/header scoped.
- Registration and path reservation together survive an interruption between
  their two writes without producing a usable, unreserved path.
- Copy Link is idempotent only for an exact active tuple.
- A deleting share cannot exchange for a URL.
- Delete retries survive R2 404, a `generation` conflict, browser crash at
  every saga boundary, and an expired Firebase ID token or presigned URL.
- Public rate limiting is durable across Fastly POPs and Compute instances.
- A grant for one path/share cannot authorize another.
- Fragment/registry/R2 ETag, length, or SHA-256 disagreement blocks download
  before decryption.
- No client response contains a KV Store binding or can select a control
  store/key.
- Source deletion remains blocked until every share record is gone.
- Recipient reader state never reaches owner KV Store/R2 state.
- `POST /v1/shares` and `DELETE /v1/shares` reject a missing, expired, wrong-
  route, or replayed possession proof even with a valid Firebase token.
