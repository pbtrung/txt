# Sharing protocol and lifecycle

Sharing remains an explicit independent-copy design. A share recipient gets no
owner account, Cosmos access, owner EPUB key, owner R2 prefix credential, or
server-side reading state. Revocation remains a server registry decision and
takes effect for new signed-URL exchanges.

## Owner-side share record

Each encrypted book aggregate contains its shares as defined in
[data_model.md](data_model.md). The current R2 layout remains:

```text
{db_prefix}/shared/{share_prefix}/{share_path}
```

The owner-side `share_id`, `share_content_key`, prefix, path, state, timestamps,
and ordering are end-to-end encrypted in the book row and library snapshot.
Northflank sees the raw ID/path only in authenticated owner API calls and stores
only SHA-256 hashes in server-only `share_control`.

## Creating a share

The browser performs a recoverable saga:

1. Point-read and decrypt the current book record.
2. Generate a fresh 32-byte `share_id`, 128-byte `share_content_key`, 32-byte
   `share_prefix`, and 32-byte `share_path` using the cryptographic RNG.
3. Append a `creating` share record and atomically publish the book plus library
   snapshot using the current book/head `_etag` values.
4. Download and decrypt the immutable owner EPUB if it is not already in
   memory. Encrypt a new independent shared copy with `share_content_key`; never
   reuse or wrap the owner `txt_key` for a recipient.
5. Upload the shared ciphertext to the exact new R2 path with
   `If-None-Match: *`. On a retry, accept an existing object only after its
   locally expected ciphertext hash/length match.
6. Call `POST /v1/shares` with Firebase owner authentication and the version-3
   owner/vault binding.
7. Northflank validates the binding and object, transactionally reserves the
   share ID/path in `share_control`, and returns a fresh authenticated grant.
8. Change the encrypted owner record from `creating` to `active` and republish
   the snapshot through the normal conflict-replay protocol.
9. Construct the public URL locally. Capability and decryption material belong
   in the URL fragment so normal HTTP requests and referrers do not disclose
   them.

The UI exposes Copy Link only after step 7 succeeds. A failure after step 3
leaves visible `creating` state and a retry action, not a fabricated active
link. A failure after server registration may retry the identical registration;
Northflank returns a fresh grant for an identical active hash pair, allowing
the browser to finish step 8.

## Copying an existing link

For an `active` owner share, Copy Link calls `POST /v1/shares` again with the
same authenticated identity and exact share tuple. Northflank requires the
same active share-ID and object-path hashes and returns a newly encrypted grant.
It must not create a second registry row or upload another R2 copy.

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
3. Northflank applies the IP rate limit, authenticates the grant, point-reads
   the server-only hashed registry entry, and requires `active` plus an exact
   path-hash match.
4. It returns a 60-second R2 URL granting GET for one object.
5. The browser downloads and decrypts the independent share ciphertext with
   `share_content_key` from the fragment.

Recipient reading progress, CFI, font choice, and bookmarks are local browser
state only. They do not write Cosmos or the owner snapshot. The existing
read-only reader restrictions remain; no editing, re-sharing, owner metadata
mutation, or R2 upload path is exposed.

Public failures deliberately do not distinguish absent, revoked, deleting,
malformed, or mismatched shares. A recipient can continue using an already
issued exact-object URL only until that URL's short expiry.

## Deleting a share

The owner browser performs the inverse recoverable saga:

1. Change `active` or recoverable `creating` state to `deleting` in the
   encrypted book and republish the snapshot.
2. Call `DELETE /v1/shares` with Firebase authentication, exact owner/vault
   binding, and the share tuple. No grant is needed or retained by the owner.
3. Northflank conditionally changes `active` to `deleting`; a deleting share can
   no longer mint a public URL.
4. Northflank deletes the exact shared R2 object. Not-found is idempotent
   success for an otherwise matching record.
5. Northflank transactionally removes the registry and path-reservation items.
6. The browser removes the local share record and republishes the snapshot.

If the API call fails, keep `deleting` visible and retry it. If the browser
crashes after server deletion but before the local update, an idempotent retry
returns success and step 6 completes. Never reactivate a deleting server row.

A `creating` share that was never registered can be cleaned locally after the
browser verifies no matching active registry through the authenticated owner
delete endpoint; the server must still normalize and delete the exact orphan R2
path before returning success.

## Book deletion invariant

The UI, data store, CLI, and repair tool all reject source-book deletion while
the encrypted `shares` array is non-empty, regardless of share state. The owner
must finish deleting every active, creating, or deleting share first. This
prevents loss of the only owner-side share key/identity required to retry
cleanup.

## Concurrent devices and conflict handling

All local share transitions are semantic book mutations and therefore use book
and catalog-head `_etag` conditions. On conflict, refetch/decrypt and reapply by
`share_id`; do not replace the entire shares array from stale memory.

- Creating an already-present identical share is idempotent.
- Creating the same ID with different key/path values is a hard conflict.
- Activating requires current local state `creating` and matching identity.
- Marking deleting is idempotent for an already `deleting` matching record.
- Removing requires `deleting`; it must not erase a concurrently replaced
  record with the same array position.

The server registry independently uses Cosmos conditional writes and one
partition transactional batches. Client `_etag` correctness never substitutes
for server-side share authorization.

## Recovery reconciliation

The administration CLI provides a read-only report and explicit repair mode:

| Owner encrypted state | Server registry | R2 object | Action |
| --- | --- | --- | --- |
| `creating` | absent | absent | retry encryption/upload or remove after confirmation |
| `creating` | absent | present | retry registration |
| `creating` | active | present | issue fresh grant and mark owner state active |
| `active` | active | present | healthy |
| `active` | absent/deleting | any | block Copy Link; complete deletion or re-register only with exact proof |
| `deleting` | active/deleting | any | retry server deletion |
| `deleting` | absent | absent | remove owner record |
| absent | active/deleting | any | report orphan; require explicit revocation before deletion |

Automated repair may only take idempotent actions that cannot publish a new
capability. Creating/re-registering an anonymous share after ambiguous state
requires explicit owner confirmation.

## Tests required before cutover

- A share uses ciphertext/key material independent from its source EPUB.
- Raw share IDs and paths do not appear in Cosmos control documents or logs.
- Register and path reservation succeed or fail atomically under concurrency.
- Copy Link is idempotent only for an exact active tuple.
- A deleting share cannot exchange for a URL.
- Delete retries survive R2 404, Cosmos conflict, browser crash at every saga
  boundary, and an expired owner data token.
- Public rate limiting is durable across Northflank workers and restarts.
- A grant for one path/share cannot authorize another.
- A resource token for `vault` cannot read any share registry item.
- Source deletion remains blocked until every share record is gone.
- Recipient reader state never reaches owner Cosmos/R2 state.
