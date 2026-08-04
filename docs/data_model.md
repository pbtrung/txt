# Data Model — InstantDB

This project stores data in a single InstantDB app — isolation between users is enforced entirely by InstantDB's permission rules (CEL expressions). Identity comes from Firebase Auth; InstantDB maps a verified Firebase ID token to an InstantDB user by its email claim.

Documents, their content, shares, read-position, and bookmarks are all literal InstantDB entities. Only one thing is stored outside InstantDB: a document part's actual text, which lives as a single encrypted object in Cloudflare R2, addressed by a random key that only an encrypted `txtParts.path` value (below) points to.

Every column that holds user content, a wrapped key, or anything else sensitive stores an opaque encrypted blob in the wire format defined in [crypto.md](crypto.md) — `magic || version || salt || ciphertext || tag`. InstantDB and R2 both only ever see ciphertext; all encryption/decryption and key unwrapping happens in the client (or admin tooling), never in the database.

Exact InstantDB API names below (`i.entity`, `unique()`, `.ref()`, permission rule shape) come from InstantDB's own docs (`instantdb.com/docs/modeling-data`, `/docs/permissions`, `/docs/auth/firebase`) — verify against a real `npx instant-cli@latest push schema` before treating any of this as final.

This file covers the entities themselves and who can touch them. See [key_hierarchy.md](key_hierarchy.md) for how their encryption keys nest, [protocols.md](protocols.md) for the read/write/share/garbage-collection flows, [r2_credentials.md](r2_credentials.md) for how R2 access is brokered (and how new accounts are provisioned), [auth.md](auth.md) for the sign-in flow, and [crypto.md](crypto.md) for the underlying AEAD/KDF/KEM primitives.

## Operating model: admin owns content, users only ever read shared documents

Only an `admin`-typed account ever creates a `txt` row (a document) or its `txtParts` — a `user`-typed account has no ingest path of its own. A `user` account gets read access to a specific document exclusively through a `txtShares` row the admin creates for them (see [protocols.md](protocols.md)'s Sharing protocol); everything else about a `user` account (their own `txtAccess`/`txtBookmarks` rows, their own `keyStore` keypair) exists to support reading documents shared to them, not to own any of their own. This is a real behavioral asymmetry between the two roles, not just a permission-rule detail — worth keeping in mind when reading every entity below.

## Entities

There's no app-level profile entity in this design — `$users` (InstantDB's own built-in auth entity) is the only account-identity entity, and every other entity's `owner`/`user` link points directly at it. `auth.id` already equals a `$users` row's own id, so ownership checks below are always a single-hop `data.ref('owner.id')`, never a two-hop traversal through an intermediate row — the one exception is a share recipient's _read_ access to `txtParts`/`txtMetadata`, which does need a two-hop check through the parent `txt`; see "Permission rules" below.

- **`$users`** — one row per Firebase-authenticated identity, keyed by email. Carries two custom attributes beyond the built-in ones:
  - **`umk`** — base64, 128 random bytes, generated once per account and wrapped (`crypto.md`'s Blob format) under `user_root_key` — an external secret supplied by `creds.json`, never stored in InstantDB. `umk` is the encryption key for this account's `keyStore.keyStoreKey` and `credStore.credStoreKey` (below) — the intermediate keys that in turn protect `keyStore.privKey` and `credStore.content`, not those fields directly.
  - **`type`** — `'admin' | 'user'`. `'admin'` can create/update/delete any `txt`/`txtMetadata`/`txtParts`/`txtShares` row and act on any account's data, full stop; `'user'` can only view its own `keyStore`/`credStore` rows (create/update/delete on those are admin-only — provisioning or rotating key material is a provisioning action, never a regular user self-service write), can view/create/update/delete its own `txtAccess`/`txtBookmarks` rows freely, and can read (never write) a `txt`/`txtMetadata`/`txtParts` row they have a `txtShares` grant for — see "Permission rules" below for the exact rule per entity. Only ever writable via `instant.perms.ts`'s `$users.update: "isAdmin"` — there's no `isSelf` branch, so a plain user can never touch their own `type` (or anything else on their own `$users` row) through the normal write path, let alone self-promote to admin.

  **Unverified — confirm before relying on this:** whether `auth.ref('$user.type')` (`instant.perms.ts`'s `isAdmin` check) resolves a plain, non-linked attribute on the current session's own `$users` row the same way `auth.ref`/`data.ref` resolve an attribute reached across a real link.

- **`keyStore`** — one row per user (`owner`, unique link to `$users`), holding that account's `lc_kyber_1024_x448` composite keypair (see `crypto.md`'s Composite KEM Key Sizes). `pubKey` is stored raw (1624 bytes, not sensitive); `keyStoreKey` (128 random bytes, wrapped under the owner's `umk`) protects `privKey` — a fresh intermediate key rather than wrapping `privKey` directly under `umk`. This keypair exists purely so the admin can share a document with this account without ever needing that account's `umk` — see `txtShares` below. Provisioned for every account, admin included (the admin needs a `keyStore` row too, in case anyone ever needs to share _to_ the admin, though in practice the admin is always the sharer, never the recipient, today).

- **`credStore`** — one row per `user`-role account (`owner`, link to `$users`), but the admin's own `owner` is deliberately **not** unique: the admin can hold several `credStore` rows, all sharing the _same_ `credStoreKey` (generated once for the admin, not minted fresh per row) rather than each row wrapping its own. `credStoreKey` (128 random bytes, wrapped under the owner's `umk`) protects `content`, a single encrypted JSON blob holding that row's own R2 connection info plus a display label — a fresh intermediate key rather than wrapping `content` directly under `umk`, same pattern as `keyStore.keyStoreKey`. Because `owner` isn't globally `unique()` at the schema level (unlike every other one-row-per-account entity here), "exactly one row" for a `user`-role account is a client-side/provisioning-time convention, not a database-enforced constraint. The R2 connection info exists for exactly one purpose: connecting to the bucket to read (or, for the admin, write) `txtParts` objects — the actual object addresses come from `txtParts.path` (below), not from here.

  For a `user`-role account:

  ```json
  {
    "r2_config": {
      "endpoint": "",
      "region": "",
      "bucket": ""
    },
    "display_name": ""
  }
  ```

  For the admin's own row:

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
    "display_name": ""
  }
  ```

  A `user`-role row's `r2_config` carries no access keys at all, since a `user` session never holds a static R2 credential of any kind, only a short-lived, prefix-scoped, read-only temporary one minted on demand (see [r2_credentials.md](r2_credentials.md)) — a `user` account never writes to R2, and the Worker never grants it a credential that could. The admin's row carries the real, permanent R2 keys — used by CLI tooling (`--migrate`, `--clean-bucket`, `--collect-garbage`), document ingest, and the planned admin-session frontend GC counterpart (see [protocols.md](protocols.md)'s Garbage collection), which deliberately use the admin's real credential directly rather than a temporary one.

- **`txt`** — one row per document. Fields: `owner` (link to `$users` — always the admin account today, per the operating model above), `txtKey` (128 random bytes, wrapped under `owner`'s `umk`), `prefix` — this document's own R2 prefix: a Crockford-base32-lowercase encoding of 32 random bytes, generated once when the document is created and wrapped under this row's own `txtKey` — and `sourceTxtId`, present only on a document created by `txt.ts --migrate`: the plaintext integer `txt_id` it had in the source snapshot (`txt/owner.ts`'s legacy schema), queried by to make a re-run resumable (see "Ingest / write path" in [protocols.md](protocols.md)) since InstantDB rows have no integer id to reuse the way that source schema's own `txt_id` could double as its own target row id. `prefix` is what actually addresses this document's content in R2 (see `txtParts` below and [r2_credentials.md](r2_credentials.md)): unlike a value derived from `auth.id`, it's random and only ever recoverable by decrypting it under `txtKey` — so knowing which account owns a document, or even that account's `auth.id`, gives an attacker no way to compute where that document's parts live in the bucket. `txt` itself carries no name/metadata/read-position — see `txtMetadata` and `txtAccess` below.

- **`txtMetadata`** — one row per document (`txt`, unique link to `txt`). Fields: `owner` (link to `$users`, same account as `txt.owner` — kept as its own single-hop link for permission rules rather than traversing `txt.owner`), and `content` — a single encrypted JSON blob (wrapped directly under this document's own `txtKey`, brotli-compressed):

  ```json
  {
    "name": "original filename",
    "metadata": { "...": "opf sidecar fields, when present" }
  }
  ```

  Unwrapping this content is the same two-step chain as a document's `txtParts`: `umk` (or a share's Decapsulate) unwraps `txtKey`, `txtKey` unwraps `content` directly — no intermediate per-purpose key. A share recipient reads this the same way they read `txtParts`: once they've Decapsulated `txtKey`, `txtMetadata` unwraps exactly like it does for the owner.

- **`txtParts`** — a document's content, chunked into ordered parts. Fields: `txt` (link to `txt`), `owner` (link to `$users`, same account as `txt.owner` — kept as its own single-hop link for permission rules rather than traversing `txt.owner`, same reasoning as `txtMetadata` above), `partNum`, `txtPartKey` (128 random bytes, wrapped under this document's own `txtKey`), `path` — wrapped under this row's own `txtPartKey`, not `txtKey` directly — Crockford-base32-lowercase encoding of 32 random bytes, and a synthetic `partKey = "${txtId}:${partNum}"` (`unique().indexed()` — see "The composite-uniqueness problem" below). The actual part content is **not** in InstantDB: `path`, once decrypted, is a fresh random key `raw_key`, and the real R2 object lives at `raw_path = "${prefix}/${raw_key}"`, where `prefix` is this document's own `txt` row's `prefix` field, decrypted directly under `txtKey` (unaffected by any one part's own `txtPartKey`). The R2 object body is `Blob.encrypt(txtPartKey, brotli(cleaned part text))` — the same `txtPartKey` that wraps `path`, a second independent application of it. Giving every part its own key (rather than reusing the document's `txtKey` directly for `path`/the object body) means a single part's `txtPartKey` being compromised exposes only that one part — never another part of the same document, and never the document-level `prefix`, both of which stay under `txtKey` alone.

- **`txtShares`** — one row per (document, recipient) share grant. Fields: `txt` (link to `txt`), `fromUser` (link to `$users` — always the admin, since only the admin can share), `toUser` (link to `$users`, the recipient), `saltKemCt` (`salt` (64 random bytes) `|| lc_kyber_1024_x448` KEM ciphertext (1624 bytes), raw/public), `txtKey` (the same `txt.txtKey` bytes, rewrapped for this recipient via `HKDF-SHA3-512(IKM=ss, salt) -> 128-byte OKM` — see `crypto.md`'s Encapsulate/Decapsulate — where `ss` is the raw, uncombined shared secret from `lc_kyber_1024_x448_enc`/`_dec`, never itself stored), and a synthetic `shareKey = "${txtId}:${fromUserId}:${toUserId}"` (`unique().indexed()`). A recipient's read access to a `txt`/`txtMetadata`/`txtParts` row is gated on the existence of a `txtShares` row with `toUser.id == auth.id` for that `txt` — see "Permission rules" below for the exact predicate and [protocols.md](protocols.md)'s Sharing protocol for the actual Encapsulate/Decapsulate flow.

- **`txtAccess`** — one row per user (`owner`, unique link to `$users`), holding that user's read position across every document they've opened — owner or share recipient alike. `txtAccessKey` (128 random bytes, wrapped under `owner`'s `umk`) protects `content`, a single encrypted JSON blob keyed by `txt_id`: `{"<txt_id>": {"last_part_num": int, "last_accessed": int}, ...}`, capped at 10 `txt_id` entries (client evicts the entry with the oldest `last_accessed` before exceeding the cap — no DB-level enforcement).

- **`txtBookmarks`** — one row per user (`owner`, unique link to `$users`), holding that user's bookmarks across every document they've opened — owner or share recipient alike. `txtBookmarkKey` (128 random bytes, wrapped under `owner`'s `umk`) protects `content`, a single encrypted JSON blob keyed by `txt_id`: `{"<txt_id>": [{"part_num": int, "line": int, "txt_preview": str, "created_at": int (unix ms)}, ...], ...}`, each `txt_id`'s list capped at 20 entries (client evicts the oldest `created_at` before exceeding the cap — no DB-level enforcement).

## Permission rules

Three predicates, all evaluated in `instant.perms.ts`:

- `isAdmin` — `auth.ref('$user.type') == 'admin'`.
- `isOwner` — `auth.id in data.ref('owner.id')`, single-hop off this row's own `owner` link.
- `isSharedReader` — has two forms, depending on the entity. For `txt` itself: `auth.id in data.ref('txtShares.toUser.id')`, single-hop via `txt`'s reverse link to `txtShares`. For `txtParts`/`txtMetadata` (linked to `txt`, not directly to `txtShares`): `auth.id in data.ref('txt.txtShares.toUser.id')`, a two-hop check — the one exception to this design's single-hop rule, since a share grants access to a document, not to its individual parts or metadata row.

| Entity         | read                                            | create                 | update                 | delete                 |
| -------------- | ----------------------------------------------- | ---------------------- | ---------------------- | ---------------------- |
| `keyStore`     | `isAdmin \|\| isOwner`                          | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `credStore`    | `isAdmin \|\| isOwner`                          | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txt`          | `isAdmin \|\| isOwner \|\| isSharedReader`      | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txtMetadata`  | `isAdmin \|\| isOwner \|\| isSharedReader`      | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txtParts`     | `isAdmin \|\| isOwner \|\| isSharedReader`      | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txtShares`    | `isAdmin \|\| auth.id in data.ref('toUser.id')` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txtAccess`    | `isAdmin \|\| isOwner`                          | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` |
| `txtBookmarks` | `isAdmin \|\| isOwner`                          | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` |

The asymmetry this table encodes is the whole point of the operating model: once a `txtShares` row grants `toUser` access to a `txt`, that recipient gets **read-only** access to `txt`/`txtMetadata`/`txtParts` — `isSharedReader` never appears in a `create`/`update`/`delete` rule, anywhere — but **full read/write** on their own `txtAccess`/`txtBookmarks` rows regardless of whether they own the document those entries reference. Tracking your own read position and bookmarks for a document is not the same permission as writing the document itself, and `isOwner` alone (no `isSharedReader` branch needed) already grants it, since `txtAccess`/`txtBookmarks` ownership is about the reading account, never the document's.

`txtShares.read` deliberately includes the recipient (`auth.id in data.ref('toUser.id')`) — without it, a recipient could never discover which documents have been shared to them, or fetch the `saltKemCt`/`txtKey` blob they need to Decapsulate. Every write on `txtShares` stays admin-only, matching "only the admin can share" above.

### Design notes

- **Isolation depends entirely on permission rules, not physical separation** — a rules bug is a cross-user data leak across the whole app, not contained to a single account.
- **Reading a document and tracking your own progress through it are deliberately two different permissions.** A share recipient's `isSharedReader` grant covers `txt`/`txtMetadata`/`txtParts` read-only, full stop — but their `txtAccess`/`txtBookmarks` rows are gated on `isOwner` (of that row, not the document), so they can freely record their own read position and bookmarks for a shared document without ever needing write access to the document itself.

## The composite-uniqueness problem (guarded insert)

InstantDB's `unique()` constraint is per-attribute, whole-namespace — it cannot express "unique per (a, b, c)" directly. Two entities above need a composite key for exactly this reason, and each follows the same fix: compute a synthetic key client-side and mark it `unique().indexed()`, so a concurrent duplicate insert fails outright rather than needing a hand-rolled existence check first.

| Entity      | Synthetic key                                     | Guards against                                         |
| ----------- | ------------------------------------------------- | ------------------------------------------------------ |
| `txtParts`  | `partKey = "${txtId}:${partNum}"`                 | two concurrent ingests writing the same part twice     |
| `txtShares` | `shareKey = "${txtId}:${fromUserId}:${toUserId}"` | double-sharing the same document to the same recipient |

Every synthetic key is deterministic and plaintext by design (it only needs to be unique and computable, never secret) — unlike the values it helps guard (`txtParts.path`, `txtShares.txtKey`/`saltKemCt`), which are wrapped precisely because they're either a real R2 address or real key material. `txtMetadata` and `txtAccess` don't need one: `txtMetadata` is one row per `txt` (a plain unique link), and `txtAccess` is one row per user (`unique()` on the link to `$users` alone).
