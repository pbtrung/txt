# Data Model — InstantDB

This project stores data in a single InstantDB app — isolation between users is enforced entirely by InstantDB's permission rules (CEL expressions), not by physical separation into per-user databases. Identity comes from Firebase Auth; InstantDB maps a verified Firebase ID token to an InstantDB user by its email claim.

InstantDB itself holds only three things: `$users` (identity plus a per-account `umk`), `credStore` (encrypted key-material blobs), and a page-store (`dbMeta`/`pages`/`activeReaders`) for **one SQLCipher-encrypted SQLite database per user**, paged remotely into R2. The actual application schema — documents, their content, bookmarks — lives entirely _inside_ that per-user SQLCipher database (see "Per-user SQLCipher database schema" below) and is never visible to InstantDB as rows at all: InstantDB only ever sees an opaque, client-encrypted object key per page.

Exact InstantDB API names below (`i.entity`, `unique()`, `.ref()`, permission rule shape) come from InstantDB's own docs (`instantdb.com/docs/modeling-data`, `/docs/permissions`, `/docs/auth/firebase`) — verify against a real `npx instant-cli@latest push schema` before treating any of this as final. Two items below are explicitly flagged as unverified and worth confirming empirically before this design is trustworthy enough to build on.

## Entities

There's no app-level profile entity in this design — `$users` (InstantDB's own built-in auth entity) is the only account-identity entity, and every other entity's `owner`/`user` link points directly at it. `auth.id` already equals a `$users` row's own id, so ownership checks below are always a single-hop `data.ref('owner.id')`, never a two-hop traversal through an intermediate row.

- **`$users`** — one row per Firebase-authenticated identity, keyed by email. Carries two custom attributes beyond the built-in ones:
  - **`umk`** — base64, 128 random bytes, generated once per account and wrapped (`crypto.md`'s Blob format) under `user_root_key` — an external secret supplied by `creds.json`, never stored in InstantDB. `umk` is the encryption key for this account's `credStore` rows (below) — nothing else about this account's key hierarchy lives on `$users` itself.
  - **`type`** — `'admin' | 'user'`, the permission system's role switch: a `'user'` can only view/create/update their own `dbMeta`/`pages`/`activeReaders`/`credStore` rows (every rule on those is `isAdmin || isOwner`), an `'admin'` can act on any user's data, full stop — including operations (updating/deleting `pages` rows) an ordinary owner is never allowed, since those violate the page store's append-only MVCC invariant and are meant only as a deliberate support/repair escape hatch. Only ever writable via `instant.perms.ts`'s `$users.update: "isAdmin"` — there's no `isSelf` branch on that rule at all, so a plain user can never touch their own `type` (or anything else on their own `$users` row) through the normal write path, let alone self-promote to admin.

  **Unverified — confirm before relying on this:** whether `auth.ref('$user.type')` (`instant.perms.ts`'s `isAdmin` check) resolves a plain, non-linked attribute on the current session's own `$users` row the same way `auth.ref`/`data.ref` resolve an attribute reached across a real link. This project's prior design routed `type` through a separate profile entity specifically so this question never had to be answered; collapsing that entity away means it now does.

- **`credStore`** — the encrypted key-material store. One row per (owner, subject) pair; a single `owner` can hold multiple rows. Fields: `owner` (link to `$users`, whoever's `umk` encrypts this row's `content`), `user` (link to `$users`, optional — which account's key material this row actually describes; left empty when a row describes its own owner), and `content` (a string: JSON, wrapped whole via `crypto.md`'s Blob format under `owner`'s `$users.umk`).

  For a `user`-role account's own row (`owner` = that user, `user` link empty):

  ```json
  {
    "r2_config": {
      "endpoint": "",
      "region": "",
      "bucket": ""
    },
    "display_name": "",
    "path_key": "<base64, 128 random bytes>",
    "db_key": "<base64, 256 random bytes>"
  }
  ```

  For the admin's own row (`owner` = admin, `user` = admin):

  ```json
  {
    "r2_config": {
      "endpoint": "",
      "read_only_access_key_id": "",
      "read_only_secret_access_key": "",
      "read_write_access_key_id": "",
      "read_write_secret_access_key": "",
      "region": "",
      "bucket": ""
    },
    "display_name": "",
    "path_key": "<base64, 128 random bytes>",
    "db_key": "<base64, 256 random bytes>"
  }
  ```

  `path_key` wraps each page's `raw_key` (see `pages` below) before it's written into `pages.path`. `db_key` is the raw SQLCipher key for the described account's own database — **must be ≥256 raw bytes**: the leancrypto cipher provider (`sqlcipher/sqlcipher.js`, this repo's vendored WASM build) rejects anything shorter (`sqlcipher_cipher_ctx_key_derive: key must be supplied as a raw key blob x'...' of at least 256 bytes`, confirmed against the real WASM module) — unlike `umk`/`path_key`, which are just HKDF input keying material and have no such hard minimum. `r2_config` is the connection info needed to read/write the described account's page objects — for the admin, this also includes the actual R2 access keys; a `user`-role row's `r2_config` carries no access keys at all, since a `user` session never holds a static R2 credential of any kind, only a short-lived, prefix-scoped temporary one minted on demand (see "Temporary, prefix-scoped R2 credentials" below). `display_name` is a human-readable label for the described account (e.g. for an account picker) — plaintext-adjacent (protected by the same `content` wrapping as everything else here, but not itself security-sensitive), sourced from `creds.json`'s own `display_name` field at provisioning time.

  A third row shape — `owner` = admin, `user` = some other user, `content` wrapped under the admin's own `umk` (not that other user's):

  ```json
  {
    "user_root_key": "<base64, that user's own external secret>"
  }
  ```

  This is the admin's own copy of that user's `user_root_key` — the one thing every other secret in this whole hierarchy is ultimately wrapped under, and the one thing the admin has no other way to recover (unlike `path_key`/`db_key`, which the admin generated in the first place at provisioning time but doesn't otherwise persist its own copy of). It's what lets cross-account maintenance tooling (`txt.ts --collect-garbage`) unwrap any account's own `umk` → own credStore row → `path_key`, without that account's own session ever being involved: decrypt this row under the admin's `umk` to get the target account's `user_root_key`, use it to decrypt that account's own `$users.umk`, then use that to decrypt that account's own credStore self-row (the first shape above) as normal.

- **`dbMeta`** — one row per user (one-to-one link to `$users`): `currentVersion`, `pageCount`, `pageSize`, `needsGc` — the table of contents for that user's SQLCipher database's page store. `pageSize` matches that database's own page size (`PRAGMA page_size`, set to `32768` — see the schema's `PRAGMA` block below); SQLCipher's own `cipher_page_size` follows the same value.
- **`pages`** — one row per (owner, page_no, version) triple of the SQLCipher database above: `pageNo`, `version`, a synthetic `pageKey` (see below), linked to `$users` (owner), and `path` — this page-version's real R2 object key, encrypted and stored directly as base64: `path = base64(Blob(raw_key; IKM = path_key))`, where `raw_key` is a fresh Crockford-base32-lowercase encoding of 32 random bytes and the object's real address is `raw_path = "${r2Prefix}/${raw_key}"` (`r2Prefix = base32_lowercase(sha3-256(auth.id))`, a pure function of the owning account's `auth.id`, never itself encrypted or stored — cheap to recompute at the point of the actual R2 GET/PUT, so leaving it out of every encrypted `path` is pure savings, not a missing piece). A "page" here is a literal SQLite/SQLCipher page, not an arbitrary document chunk.
- **`activeReaders`** — one row per open read session: `snapshotVersion` (the version that session pinned at open) and `leaseExpiresAt`, linked to `$users`. Lets garbage collection compute the oldest version still in use by any live reader.

## The composite-uniqueness problem (guarded insert)

InstantDB's `unique()` constraint is per-attribute, whole-namespace — it cannot express "unique per (owner, page_no, version)" directly, since every user's page store independently starts at page 1, version 1, and those would collide across users on a bare `pageNo`/`version` attribute. Fix: compute a synthetic `pageKey = "${ownerId}:${pageNo}:${version}"` client-side and mark _that_ attribute `unique().indexed()`. Attempting to write a `pages` row whose `pageKey` already exists then fails outright — the guarded-insert guarantee for concurrent writers, enforced by the constraint itself, no hand-rolled SQL needed. `pageKey` is deterministic and plaintext by design (it only needs to be unique and computable, never secret) — unlike `raw_key` (wrapped into `pages.path`), which is random and encrypted precisely because it's half of a real R2 object address (the other half, `r2Prefix`, is deterministic and never encrypted at all — see `pages` above).

## Commit protocol (MVCC write path)

1. Client stages dirty pages of its local SQLCipher database (via the vendored `sqlcipher.wasm` + `js-vfs.mjs` remote-page VFS) in memory.
2. On commit, for each dirty page: the SQLCipher layer has already produced that page's ciphertext (encrypted under `db_key`, Ascon-Keccak at the SQLite page level) — this _is_ the R2 object body; no separate app-level wrapping of page content is needed.
3. Generate a fresh `raw_key = crockford_base32_lowercase(32 random bytes)` for this page-version, and `PUT` the page ciphertext to the user's own R2 bucket at `"${r2Prefix}/${raw_key}"` (`r2Prefix = base32_lowercase(sha3-256(auth.id))`) — via the admin's static read-write credentials for an admin session, or a freshly-minted temporary credential scoped to `${r2Prefix}/*` for a `user` session (see "Temporary, prefix-scoped R2 credentials" below).
4. Encrypt `raw_key` alone (`crypto.md`'s Blob format, IKM = `path_key`) and base64-encode the result — this becomes the new `pages` row's `path` value directly; no separate upload call is needed to produce it.
5. One `db.transact([...])`: create the new `pages` row (`pageKey = "${auth.id}:${pageNo}:${version}"`, `path` from step 4, linked to `owner`) and CAS-bump `dbMeta.currentVersion` — all in the same atomic transaction. The CAS is enforced by a permission rule on `dbMeta`'s `update`: `newData.currentVersion == data.currentVersion + 1` — since the rule evaluates against the record's state at commit time inside the same transaction, a concurrent writer that already advanced the version makes the whole transaction fail.

   **The one failure mode:** step 3 (the R2 `PUT`) and step 5 (the InstantDB `transact`) are two separate operations, not one atomic unit. A crash between them leaves a real R2 object with no `pages` row pointing at it — since `path` is written directly by the same `transact()` that creates the row, there's no second, separately-created metadata step in between to fail on its own. Garbage collection sweeps for this one case (see below).

   **Unverified — confirm before relying on this:** whether `transact()` is truly serializable per-record, or just "check rules against a possibly-stale read, then apply." This is the one piece of this design load-bearing enough to need real verification.

## Read protocol

Query `pages` for `owner = self, pageNo = N, version <= target`, ordered by version descending, limit 1 (indexed `version` column enables the comparison/ordering) — the result already includes `path`, so no second query or download is needed to reach it. Decrypt `path` with `path_key` to recover `raw_key`, reassemble `raw_path = "${r2Prefix}/${raw_key}"` (`r2Prefix` re-derived from `auth.id`, already known at this point), then `GET` that key from R2 — the real (SQLCipher-encrypted) page bytes, handed to the local SQLite/SQLCipher engine, which decrypts them with `db_key` as the page is loaded. Two hops: one InstantDB query, one R2 fetch.

## Temporary, prefix-scoped R2 credentials

No account holds a static R2 access key in the browser, admin included — the admin's own `read_write_access_key_id`/`secret` is the only permanent R2 credential in this design, and it lives only as a Cloudflare Worker secret (`worker/r2Creds.ts`'s `env.READ_WRITE_ACCESS_KEY_ID`/`SECRET`), never in any client session. Every read/write goes through a short-lived, prefix-scoped temporary credential instead.

**Planned exception:** a frontend counterpart to `txt.ts --collect-garbage` (see "Garbage collection" below) is intended to use the admin's real, decrypted `r2_config` directly in an admin-logged-in browser session, not a temporary credential — a deliberate, accepted departure from the rule above, not an oversight. The admin's own `r2_config` is already recoverable client-side regardless (decrypt `umk` → the admin's own `credStore` row), so this doesn't expose anything not already reachable; what it changes is that the real key gets materialized in a browser session at all, for as long as that session is open, rather than never. Every delete this feature issues still targets one account's own `r2Prefix` at a time (never a whole-bucket operation, same scoping `--collect-garbage` already has server-side) — bounding what a compromised admin session could do relative to holding the real key with no such scoping.

### Provisioning a `user` account

Creating a `user` account is an admin-side action: the admin sets that new `$users` row's `type: "user"`, generates that user's `path_key`/`db_key`, initializes their SQLCipher database (schema, `PRAGMA`s — see below — and an empty `dbMeta`), uploads its initial pages to R2 under that user's `r2Prefix` using the admin's own credentials, and writes the resulting `credStore` row (`owner` = that user, `user` link empty, `content` wrapped under that user's own `umk`) plus `dbMeta`/`pages` rows. From that point on, the user reads and writes their own database entirely through the temporary-credential flow below, the same one the admin's own session also uses — the admin never needs to touch it again for ordinary use.

### The credential flow

Every account's `raw_path` values live under `r2Prefix = base32_lowercase(sha3-256(auth.id))` (see `pages` above) — deterministic, computable by anyone who knows `auth.id`. R2 access for any account is restricted to exactly that slice, via a Cloudflare Worker (`worker/r2Creds.ts`, deployed alongside the app's own static build as one Worker-with-static-assets resource, not a separate platform):

1. The client calls Firebase's `getIdToken()` (not a cached raw token string — see below) and sends `{idToken, prefix: computeR2Prefix(auth.id), bucket, endpoint}` to the Worker's `POST /api/r2-creds`.
2. The Worker verifies the token itself — RS256 signature against Firebase's own public JWKS via `jose` (Workers-compatible), issuer/audience pinned to a Worker-configured Firebase project ID that's never accepted from the request itself (accepting it from the client would let a caller point verification at a different Firebase project they control). It does **not** independently re-derive or cross-check the requested prefix against the token's own subject — the prefix is trusted as given once the token itself is proven real, a deliberate simplification for a small, admin-curated user base.
3. The Worker mints a temporary credential via R2's Temporary Credentials **local signing** path (the runnable reference is at [developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials](https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/); the prose-only page at `.../api/s3/temporary-credentials/` is incomplete on its own and got several details wrong the first time this was built from it) — no outbound call to Cloudflare's own API needed: sign a JWT (HS256, via `jose`'s `SignJWT`) with the admin's parent R2 secret access key (held only as a Worker secret), with claims `{bucket, scope: "object-read-write", paths: {prefixPaths: ["${prefix}/"]}}` plus the standard registered claims `sub` (the R2 account ID, parsed from `endpoint`), `iss` (the parent access key ID — this, not the request's own `accessKeyId`, is what R2 uses server-side to look up which parent secret to re-verify the signature against), `aud` (the R2 endpoint's own host), and `iat`/`exp` (via `setIssuedAt()`/`setExpirationTime()` — there is no separate `ttlSeconds` claim). The temporary `secretAccessKey` is the SHA-256 hex digest of the signed JWT; the `sessionToken` is plain `base64("jwt/" + <signed JWT>)` (not base64url); the parent access key ID is reused as-is for the temporary `accessKeyId`.
4. The Worker returns `{accessKeyId, secretAccessKey, sessionToken, expiresAtMs}` to the client, which builds a normal S3 client from them (`aws4fetch`'s `AwsClient` in this app, or `@aws-sdk/client-s3` with `sessionToken` set elsewhere).
5. The client re-requests a fresh temporary credential before `expiresAtMs` — scheduled off that real, server-returned value rather than a hardcoded assumption about the credential's own lifetime; no long-lived secret is ever cached client-side.

**Re-requesting doesn't mean re-login.** Firebase ID tokens are short-lived (~1 hour by default) independent of this design's own credential lifetime, but that's invisible in the normal case: `getIdToken()` transparently mints a fresh ID token from the SDK's own longer-lived refresh token whenever the cached one is stale, with no interactive step. An actual re-login is only forced when the _refresh token_ itself stops being valid — the admin calls `revokeRefreshTokens()` for that account, the password changes, the account is disabled, or local app storage holding the refresh token was cleared/signed out — not merely because time has passed since the last unlock.

This is the one place this design needs a server component — every other unlock/read/write path is a direct client-to-InstantDB or client-to-R2 call. The Worker only ever verifies identity and brokers scoped, time-limited credentials; it never sees page content (already SQLCipher-encrypted before it would ever reach R2) or any account's `umk`/`path_key`/`db_key`.

## Garbage collection

Two sweeps:

1. Once no `activeReaders` row still needs a superseded page version, delete the `pages` row, then delete the R2 object its `path` (decrypted via `path_key`, combined with the owning account's own re-derived `r2Prefix`) resolves to — in that order, so a crash mid-GC never leaves a `pages` row pointing at something already deleted.
2. An orphan sweep for the commit protocol's one failure mode above, needing a full R2 bucket listing diffed against everything currently reachable — structurally the same shape as the existing `txt.ts --clean-bucket` tool, just decrypting via `path_key` instead of that tool's `txt_key`/`txt_metadata_key` chain: real R2 objects with no `pages` row whose decrypted `path` resolves to them (the step-3 `PUT` succeeded, but the step-5 `transact` never completed) — after some grace period (long enough to outlast any in-flight commit's step-3-to-step-5 gap), delete them directly.

`txt.ts --migrate` implements a version of this sweep scoped to its own target account, run at the start of every invocation (no grace period needed there, since it's the same operator re-running the same command, not a background job racing an in-flight commit): list R2 objects under the target account's own `r2Prefix`, diff against every `pages` row's own decrypted `raw_key` (any version, not just the current one — a superseded-but-not-yet-GC'd page's object is still legitimately known), and delete whatever's left over from a previous run that crashed between `RemotePageStore.commitPages`' own R2-upload step and its final `transact`. This is what makes `--migrate` resumable without duplicating documents: each migrated document keeps its source `txt_id` as its target `txt_id`, so a re-run only needs `SELECT id FROM txt` against the target to know which source documents already made it across.

Cross-user GC visibility doesn't strictly require the Admin SDK's rule-bypassing — `instant.perms.ts`'s `isAdmin` branch already grants a real, authenticated `admin`-typed client session (not just the Admin SDK) full read/write across every account's `$users`/`dbMeta`/`pages`/`credStore` rows, same as any other entity in this design. `txt.ts --collect-garbage` uses the Admin SDK anyway, since it's a standalone server-side tool with no live admin session to authenticate as; a frontend counterpart (below) can instead do the same querying/deleting through a real admin-logged-in session and the ordinary client SDK.

`txt.ts --collect-garbage` implements both sweeps above, app-wide, one account at a time: for every account with a `dbMeta` row, "current version" is evaluated **per page number**, not as one flat cutoff against `dbMeta.currentVersion` — most page numbers were never touched in whatever commit last bumped that value, so their only row legitimately carries some earlier version and is still current, not stale. The rule: for each `pageNo`, find its own highest version among that account's rows, then delete every row for that `pageNo` that isn't the one at that highest version (plus the R2 object each deleted row's decrypted `path` resolves to) — a deliberate simplification of sweep 1's full `activeReaders`-aware condition, since this is a manually-run maintenance operation, not a background job expected to race live readers — then, for that same account, sweep 2's untracked-object pass. After sweep 1, the number of distinct page numbers remaining should equal that account's `dbMeta.pageCount` exactly; `--collect-garbage` checks this itself and warns if not. Recovering a non-admin account's `path_key` (needed to decrypt its own `pages.path` values) goes through `credStore`'s third row shape above: the admin's own held copy of that account's `user_root_key`, unwrapped under the admin's own `umk`.

**Planned: a frontend counterpart.** The same two sweeps, triggerable from an admin-logged-in browser session instead of this CLI tool — same account enumeration, same `credStore`-third-row-shape path_key recovery, same per-`r2Prefix` scoping for every delete — but using the real client SDK (permission-rule-respecting, per the note above) and the admin's own decrypted `r2_config` directly rather than a Worker-minted temporary credential. See "Temporary, prefix-scoped R2 credentials" above for the deliberate exception this represents. Not yet implemented.

## Auth

Every unlock requires a live Firebase sign-in (`getIdToken()` → `db.auth.signInWithIdToken()`), since InstantDB resolves identity from the token's email claim at session-creation time, not from a long-lived static credential. A non-interactive, file-based unlock flow would need Firebase custom tokens minted from a small backend instead. After sign-in, the client reads its own `$users.umk`, unwraps it under `user_root_key`, then reads its own `credStore` row (`owner = self`) and decrypts its `content` under `umk` to recover `path_key`/`db_key`/`r2_config`, and uses `db_key` to open (or create) its own per-user SQLCipher database via the vendored `sqlcipher.wasm` + `js-vfs.mjs` remote-page VFS, backed by the `dbMeta`/`pages` page store above. A `user`-role session additionally depends on the temporary-credential intermediary (above) for its R2 access — the only server component this design needs.

## Per-user SQLCipher database schema

Entirely opaque to InstantDB — these tables live inside the per-user SQLCipher-encrypted SQLite file itself (paged into R2 via the page store above), never as InstantDB rows. Because SQLCipher already encrypts every page of this file under `db_key`, individual columns don't need their own app-level `Blob`-wrapping — the whole file is ciphertext at rest, InstantDB and R2 both included.

```sql
PRAGMA cipher_default_page_size = 32768;
PRAGMA page_size = 32768;
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE txt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,  -- original filename
    metadata      BLOB,              -- brotli(JSON)
    last_part_num INTEGER,           -- this document's own read position; NULL until first opened
    last_accessed INTEGER,           -- unix ms; NULL until first opened
    created_at    INTEGER NOT NULL,  -- unix ms
    FOREIGN KEY (id, last_part_num) REFERENCES txt_parts(txt_id, part_num)
);

CREATE INDEX idx_txt_last_accessed ON txt(last_accessed DESC);

CREATE TABLE txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    content     BLOB    NOT NULL UNIQUE, -- brotli(raw text)
    UNIQUE (txt_id, part_num)
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num   INTEGER NOT NULL,
    line       INTEGER NOT NULL,
    preview    TEXT    NOT NULL CHECK (length(preview) <= 60),
    created_at INTEGER NOT NULL,  -- unix ms
    UNIQUE (txt_id, part_num, line)
);

CREATE INDEX idx_txt_bookmarks_txt_id_created_at ON txt_bookmarks(txt_id, created_at);

-- Enforces the per-document bookmark cap in the database instead of relying
-- on every caller to evict before inserting: after each insert, keep only
-- the 20 most recent rows (by created_at, id as tiebreak) for that txt_id
-- and delete the rest.
CREATE TRIGGER trg_txt_bookmarks_cap
AFTER INSERT ON txt_bookmarks
BEGIN
  DELETE FROM txt_bookmarks
  WHERE txt_id = NEW.txt_id
    AND id NOT IN (
      SELECT id FROM txt_bookmarks
      WHERE txt_id = NEW.txt_id
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    );
END;
```

### Pragmas

- **`page_size = 32768`** — must be set before any table is created (SQLite only honors a `page_size` change on an empty database, or via a subsequent `VACUUM`); this is what `dbMeta.pageSize`/`pages` above are keyed to. A larger-than-default page size means fewer, bigger R2 objects per database for a given document size — fewer round-trips to page a large document in, at the cost of moving more bytes than strictly needed when only a small part of a page actually changed.
- **`auto_vacuum = INCREMENTAL`** — also only settable before any table exists. Lets freed pages (e.g. after deleting a document) be reclaimed via an explicit `PRAGMA incremental_vacuum` sweep without rewriting the whole file, unlike a full `VACUUM` — important here since every reclaimed page is also a page-store entry (`pages`) and an R2 object to garbage-collect, not just local disk space.

### Tables

- **`txt`** — one row per document: `name` and `metadata` (an OPF sidecar's parsed fields, when present) live directly on the document's own row. `last_part_num`/`last_accessed` are this document's own read position — since each user has their own database, a document's read position is just two columns on its own row, no separate cross-document table needed.
- **`txt_parts`** — a document's content, chunked into ordered parts: `content` (brotli-compressed raw text) is stored directly in this table, protected by SQLCipher's own page-level encryption — reading a part is a local (decrypted-on-the-fly-by-SQLCipher) row read once the relevant pages are paged in, no per-part AEAD wrap or R2 round-trip. `UNIQUE(txt_id, part_num)` supports fetching a specific part or range in order; the `UNIQUE` constraint on `content` itself is a dedup safety net.
- **`txt_bookmarks`** — per-document bookmarks. `trg_txt_bookmarks_cap` enforces a cap of 20 directly in the database after every insert — SQLite itself guarantees the cap, not application code, so nothing (a buggy or malicious caller included) can exceed it.
- The composite `FOREIGN KEY (id, last_part_num) REFERENCES txt_parts(txt_id, part_num)` on `txt` enforces, at the SQLite level, that a document's read position always points at a part that actually exists.

## Design Notes

- **Isolation depends entirely on permission rules, not physical separation** — a rules bug is a cross-user data leak across the whole app, not contained to a single account. Worth weighing deliberately, not as an afterthought.
- **Two independent layers of encryption protect a page, deliberately**: SQLCipher's own page-level encryption (`db_key`) protects page _content_; `path_key` separately protects the R2 _address_ a page lives at. Compromising one without the other isn't enough to read page content (no `db_key`) or to locate which R2 objects belong to which user/page (no `path_key`) — genuine defense-in-depth, not two copies of the same protection.
- **The temporary-credential intermediary is a real trust boundary, not a formality** — it holds the admin's R2 credential and, on a compromised or buggy Firebase ID token check, could mint an over-scoped or long-lived credential for the wrong prefix. Its blast radius is bounded (never sees `umk`/`path_key`/`db_key`/plaintext page content, only brokers scoped R2 tokens), but it's the one component in this design whose compromise directly threatens R2-level isolation between accounts, rather than just one account's own data.
