# Data Model — InstantDB

This project stores data in a single InstantDB app — isolation between users is enforced entirely by InstantDB's permission rules (CEL expressions), not by physical separation into per-user databases. Identity comes from Firebase Auth; InstantDB maps a verified Firebase ID token to an InstantDB user by its email claim. Page bytes for the MVCC page store live on R2; InstantDB holds only metadata and an encrypted pointer to each page's R2 location — it never sees plaintext content or even a plaintext path.

Exact InstantDB API names below (`i.entity`, `unique()`, `.ref()`, permission rule shape) come from InstantDB's own docs (`instantdb.com/docs/modeling-data`, `/docs/permissions`, `/docs/auth/firebase`, `/docs/storage`) — verify against a real `npx instant-cli@latest push schema` before treating any of this as final. Two items below are explicitly flagged as unverified and worth confirming empirically before this design is trustworthy enough to build on.

## Entities

- **`$users`** (InstantDB's built-in auth entity) — one row per Firebase-authenticated identity, keyed by email.
- **`users`** — an app-level profile entity, one-to-one linked to `$users`, holding `type: 'admin' | 'user'`. Kept separate from `$users` because `$users` is managed by InstantDB's auth system and isn't meant to carry arbitrary app fields. `type` is the permission system's role switch (`instant.perms.ts`): a `'user'` can only view/create/update their own `dbMeta`/`pages`/`$files`/`activeReaders` rows (every rule is `isAdmin || isOwner`), an `'admin'` can act on any user's data, full stop — including operations (updating/deleting `pages`/`$files` rows) an ordinary owner is never allowed, since those violate the page store's append-only MVCC invariant and are meant only as a deliberate support/repair escape hatch. A `'user'` can update their own profile row but never their own `type` field (blocked via `request.modifiedFields`), so self-promotion to admin isn't possible through the normal write path.
- **`dbMeta`** — one row per user (one-to-one link to `users`): `currentVersion`, `pageCount`, `pageSize`, `needsGc` — the table of contents for that user's page store.
- **`pages`** — one row per (owner, page_no, version) triple: `pageNo`, `version`, a synthetic `pageKey` (see below), linked to `users` (owner) and to `$files` (the encrypted pointer).
- **`$files`** (InstantDB's built-in storage entity) — one row per page-version's encrypted pointer. InstantDB only allows creating a `$files` row via `db.storage.uploadFile(path, file)` — `transact()` can update an existing row's `path` or delete the row, but never create one ([instantdb.com/docs/storage#link-files](https://instantdb.com/docs/storage#link-files)). `path` is set to the same value as `pages.pageKey` (see below) and is just a routing key, not secret — the AEAD ciphertext blob (`magic||version||salt||ciphertext||tag`, the blob format from [crypto.md](crypto.md)) whose decrypted plaintext is an R2 object key is the *uploaded file's content*, not the `path` attribute. Reading it back means fetching `$files.url` (a real download, not embedded in the query result) and decrypting the response body. The real page bytes still never touch InstantDB — only this small pointer blob does, as an upload.
- **`activeReaders`** — one row per open read session: `snapshotVersion` (the version that session pinned at open) and `leaseExpiresAt`, linked to `users`. Lets garbage collection compute the oldest version still in use by any live reader.

### Why route pointers through `$files` instead of a plain column on `pages`

Two independent, separately-gated permission surfaces (`pages`' rules and `$files`' rules) rather than one — a bug in one rule set doesn't automatically expose the other. These are now genuinely different mechanisms, not just two copies of the same check: `pages`' rules are ref-traversal (`auth.id in data.ref('owner.authUser.id')`), while `$files`' rules are a string-prefix check on `path` (see `instant.perms.ts` — ref traversal isn't available there at creation time; see the commit protocol below).

## The composite-uniqueness problem (guarded insert)

InstantDB's `unique()` constraint is per-attribute, whole-namespace — it cannot express "unique per (owner, page_no, version)" directly, since every user's page store independently starts at page 1, version 1, and those would collide across users on a bare `pageNo`/`version` attribute. Fix: compute a synthetic `pageKey = "${ownerId}:${pageNo}:${version}"` client-side and mark *that* attribute `unique().indexed()`. Attempting to write a `pages` row whose `pageKey` already exists then fails outright — the guarded-insert guarantee for concurrent writers, enforced by the constraint itself, no hand-rolled SQL needed.

## Commit protocol (MVCC write path)

1. Client stages dirty pages in memory.
2. On commit, for each dirty page: upload new page ciphertext to R2 at a fresh random key, then encrypt that key into a small AEAD blob (crypto.md's blob format).
3. Compute `key = "${auth.id}:${pageNo}:${version}"` — the same composite-identity string used for `pages.pageKey`, using `auth.id` (the `$users` id) rather than the `users` profile row's own id, since `instant.perms.ts`'s `$files` rules need to compare it directly against `auth.id`.
4. `await db.storage.uploadFile(key, <the AEAD blob as a File>)` — this *creates* the `$files` row (`path = key`, content = the blob). This is the only way to create a `$files` row and can't be folded into the `transact()` below; ownership at this point is enforced purely by `instant.perms.ts` checking `data.path.startsWith(auth.id + ':')`, since no link to any other entity exists yet.
5. One `db.transact([...])`: create the new `pages` row (`pageKey = key`, linked to `owner` and, via the upload's returned `data.id`, to the `$files` row through `pointerFile`), and CAS-bump `dbMeta.currentVersion` — all in the same atomic transaction. The CAS is enforced by a permission rule on `dbMeta`'s `update`: `newData.currentVersion == data.currentVersion + 1` — since the rule evaluates against the record's state at commit time inside the same transaction, a concurrent writer that already advanced the version makes the whole transaction fail.

   **New failure mode:** steps 4 and 5 are no longer one atomic operation — a crash between them leaves an uploaded-but-unlinked `$files` row (no `pages` row points at it, though the R2 object from step 2 is fine since that upload already succeeded independently). Garbage collection needs a sweep for these (see below).

   **Unverified — confirm before relying on this:** whether `transact()` is truly serializable per-record, or just "check rules against a possibly-stale read, then apply." This is the one piece of this design load-bearing enough to need real verification.

## Read protocol

Query `pages` for `owner = self, pageNo = N, version <= target`, ordered by version descending, limit 1 (indexed `version` column enables the comparison/ordering), with the linked `$files.url` included in the same query. Then: `GET $files.url` → decrypt the response body to recover the R2 key → `GET` from R2 → the real page bytes. Three hops now, not two — one InstantDB query, one download from InstantDB storage for the pointer blob, and one R2 fetch for the real content — since the pointer blob is real uploaded file content rather than a plain attribute value embedded in the query result.

## Garbage collection

Two-phase, since content lives outside the metadata store entirely:

1. Once no `activeReaders` row still needs a superseded page version, delete the `pages` row.
2. Only then delete the `$files` row and the R2 object it points to — in that order, so a crash mid-GC never leaves a `pages` row pointing at something already deleted.

A third sweep handles the orphan case from the commit protocol above: `$files` rows with no incoming `pointerFile` link, older than some grace period (long enough to outlast any in-flight commit's upload-to-transact gap) — delete these and the R2 object their decrypted pointer resolves to, same as any other GC'd file.

Maintenance/GC tooling almost certainly needs to run via InstantDB's server-side Admin SDK (an app-level secret token bypassing permission rules entirely, analogous to Firebase's Admin SDK) rather than as an ordinary authenticated client — GC needs cross-user visibility that per-user CEL rules should never grant to a regular client.

## Auth

Every unlock requires a live Firebase sign-in (`getIdToken()` → `db.auth.signInWithIdToken()`), since InstantDB resolves identity from the token's email claim at session-creation time, not from a long-lived static credential. A non-interactive, file-based unlock flow would need Firebase custom tokens minted from a small backend instead — a server component this design otherwise avoids.

## Design Notes

- **Isolation depends entirely on permission rules, not physical separation** — a rules bug is a cross-user data leak across the whole app, not contained to a single account. Worth weighing deliberately, not as an afterthought.
