# Data Model — InstantDB

This project stores data in a single InstantDB app — isolation between users is enforced entirely by InstantDB's permission rules (CEL expressions), not by physical separation into per-user databases. Identity comes from Firebase Auth; InstantDB maps a verified Firebase ID token to an InstantDB user by its email claim. Page bytes for the MVCC page store live on R2; InstantDB holds only metadata and an encrypted pointer to each page's R2 location — it never sees plaintext content or even a plaintext path.

Exact InstantDB API names below (`i.entity`, `unique()`, `.ref()`, permission rule shape) come from InstantDB's own docs (`instantdb.com/docs/modeling-data`, `/docs/permissions`, `/docs/auth/firebase`, `/docs/storage`) — verify against a real `npx instant-cli@latest push schema` before treating any of this as final. Two items below are explicitly flagged as unverified and worth confirming empirically before this design is trustworthy enough to build on.

## Entities

- **`$users`** (InstantDB's built-in auth entity) — one row per Firebase-authenticated identity, keyed by email.
- **`users`** — an app-level profile entity, one-to-one linked to `$users`, holding `type: 'admin' | 'user'`. Kept separate from `$users` because `$users` is managed by InstantDB's auth system and isn't meant to carry arbitrary app fields. `type` is the permission system's role switch (`instant.perms.ts`): a `'user'` can only view/create/update their own `dbMeta`/`pages`/`$files`/`activeReaders` rows (every rule is `isAdmin || isOwner`), an `'admin'` can act on any user's data, full stop — including operations (updating/deleting `pages`/`$files` rows) an ordinary owner is never allowed, since those violate the page store's append-only MVCC invariant and are meant only as a deliberate support/repair escape hatch. A `'user'` can update their own profile row but never their own `type` field (blocked via `request.modifiedFields`), so self-promotion to admin isn't possible through the normal write path.
- **`dbMeta`** — one row per user (one-to-one link to `users`): `currentVersion`, `pageCount`, `pageSize`, `needsGc` — the table of contents for that user's page store.
- **`pages`** — one row per (owner, page_no, version) triple: `pageNo`, `version`, a synthetic `pageKey` (see below), linked to `users` (owner) and to `$files` (the encrypted pointer).
- **`$files`** (InstantDB's built-in storage entity) — one row per page-version's encrypted pointer. **Confirmed: `$files.url`/the storage-upload API are not used at all.** `$files.path` is a plain string attribute holding the AEAD ciphertext blob directly (`magic||version||salt||ciphertext||tag`, the blob format from [crypto.md](crypto.md)) whose decrypted plaintext is an R2 object key — set and read like any other attribute via `transact()`/queries, not through `db.storage.uploadFile()`/a download URL. The actual page bytes are never uploaded to InstantDB at all; only this small pointer string is, and it's queried straight off `pages`' link to `$files`.
- **`activeReaders`** — one row per open read session: `snapshotVersion` (the version that session pinned at open) and `leaseExpiresAt`, linked to `users`. Lets garbage collection compute the oldest version still in use by any live reader.

### Why route pointers through `$files` instead of a plain column on `pages`

Two independent, separately-gated permission surfaces (`pages`' rules and `$files`' rules) rather than one — a bug in one rule set doesn't automatically expose the other, though in practice both encode the same ownership check (ref-traversal back to the owning user), so treat this as defense-in-depth, not two genuinely independent secrets.

## The composite-uniqueness problem (guarded insert)

InstantDB's `unique()` constraint is per-attribute, whole-namespace — it cannot express "unique per (owner, page_no, version)" directly, since every user's page store independently starts at page 1, version 1, and those would collide across users on a bare `pageNo`/`version` attribute. Fix: compute a synthetic `pageKey = "${ownerId}:${pageNo}:${version}"` client-side and mark *that* attribute `unique().indexed()`. Attempting to write a `pages` row whose `pageKey` already exists then fails outright — the guarded-insert guarantee for concurrent writers, enforced by the constraint itself, no hand-rolled SQL needed.

## Commit protocol (MVCC write path)

1. Client stages dirty pages in memory.
2. On commit, for each dirty page: upload new page ciphertext to R2 at a fresh random key, then encrypt that key into a small AEAD blob.
3. One `db.transact([...])`: create the new `$files` row (`path` = the encrypted pointer blob from step 2), create the new `pages` row (with its `pageKey`, linked to that `$files` row), and CAS-bump `dbMeta.currentVersion` — all in the same atomic transaction, since `$files.path` is just a plain attribute here, not a separate `uploadFile()` call. The CAS is enforced by a permission rule on `dbMeta`'s `update`: `newData.currentVersion == data.currentVersion + 1` — since the rule evaluates against the record's state at commit time inside the same transaction, a concurrent writer that already advanced the version makes the whole transaction fail.

   **Unverified — confirm before relying on this:** whether `transact()` is truly serializable per-record, or just "check rules against a possibly-stale read, then apply." This is the one piece of this design load-bearing enough to need real verification.

## Read protocol

Query `pages` for `owner = self, pageNo = N, version <= target`, ordered by version descending, limit 1 (indexed `version` column enables the comparison/ordering), with the linked `$files.path` included in the same query → decrypt `path` client-side → get the R2 key → `GET` from R2 → the real page bytes. One InstantDB query (no separate file-download hop, since `$files.url` isn't used) plus one R2 fetch.

## Garbage collection

Two-phase, since content lives outside the metadata store entirely:

1. Once no `activeReaders` row still needs a superseded page version, delete the `pages` row.
2. Only then delete the `$files` row and the R2 object it points to — in that order, so a crash mid-GC never leaves a `pages` row pointing at something already deleted.

Maintenance/GC tooling almost certainly needs to run via InstantDB's server-side Admin SDK (an app-level secret token bypassing permission rules entirely, analogous to Firebase's Admin SDK) rather than as an ordinary authenticated client — GC needs cross-user visibility that per-user CEL rules should never grant to a regular client.

## Auth

Every unlock requires a live Firebase sign-in (`getIdToken()` → `db.auth.signInWithIdToken()`), since InstantDB resolves identity from the token's email claim at session-creation time, not from a long-lived static credential. A non-interactive, file-based unlock flow would need Firebase custom tokens minted from a small backend instead — a server component this design otherwise avoids.

## Open questions

- **Isolation depends entirely on permission rules, not physical separation** — a rules bug is a cross-user data leak across the whole app, not contained to a single account. Worth weighing deliberately, not as an afterthought.
- **Migration path from any existing data store is undefined** — this design assumes a fresh start.
