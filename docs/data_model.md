# Data Model — InstantDB

This project stores data in a single InstantDB app — isolation between users is enforced entirely by InstantDB's permission rules (CEL expressions). Identity comes from Firebase Auth; InstantDB maps a verified Firebase ID token to an InstantDB user by its email claim.

Documents, their content, shares, read-position, and bookmarks are all literal InstantDB entities. Only one thing is stored outside InstantDB: a document part's actual text, which lives as a single encrypted object in Cloudflare R2, addressed by a random key that only an encrypted `txtParts.path` value (below) points to.

Every column that holds user content, a wrapped key, or anything else sensitive stores an opaque encrypted blob in the wire format defined in [crypto.md](crypto.md) — `magic || version || salt || ciphertext || tag`. InstantDB and R2 both only ever see ciphertext; all encryption/decryption and key unwrapping happens in the client (or admin tooling), never in the database. Every such column is also meant to have a sibling `<field>Context` column (32 random bytes, base64) supplying crypto.md's `context` input for that one column — see [key_hierarchy.md](key_hierarchy.md)'s Context columns for the complete list and why it exists; the entity descriptions below don't repeat it field by field. **Not yet implemented**: no such column exists in `instant.schema.ts` yet.

Exact InstantDB API names below (`i.entity`, `unique()`, `.ref()`, permission rule shape) come from InstantDB's own docs (`instantdb.com/docs/modeling-data`, `/docs/permissions`, `/docs/auth/firebase`) — verify against a real `npx instant-cli@latest push schema` before treating any of this as final.

This file covers the entities themselves and who can touch them. See [key_hierarchy.md](key_hierarchy.md) for how their encryption keys nest, [protocols.md](protocols.md) for the read/write/share/cleanup flows, [r2_credentials.md](r2_credentials.md) for how R2 access is brokered (and how new accounts are provisioned), [auth.md](auth.md) for the sign-in flow, and [crypto.md](crypto.md) for the underlying AEAD/KDF/KEM primitives.

## Operating model: admin owns content, users only ever read shared documents

Only an `admin`-typed account ever creates a `txt` row (a document) or its `txtParts` — a `user`-typed account has no ingest path of its own. A `user` account gets read access to a specific document exclusively through its own `sharedTxt` row (and that share's own `sharedTxtParts`, below) that the admin creates for them (see [protocols.md](protocols.md)'s Sharing protocol) — an independent, admin-re-encrypted copy of that document's content under a fresh `txtKey` and R2 prefix, never a grant to read the admin's own `txt`/`txtParts` rows directly. Everything else about a `user` account (their own `txtAccess`/`txtBookmarks` rows, their own `keyStore` keypair) exists to support reading documents shared to them, not to own any of their own. This is a real behavioral asymmetry between the two roles, not just a permission-rule detail — worth keeping in mind when reading every entity below.

## Entities

There's no app-level profile entity in this design — `$users` (InstantDB's own built-in auth entity) is the only account-identity entity, and every other entity's `owner`/`forUser`/`fromUser`/`toUser` link points directly at it. `auth.id` already equals a `$users` row's own id, so ownership checks below are always a single-hop `data.ref('owner.id')`, never a two-hop traversal through an intermediate row — including a share recipient's own read access to `sharedTxt`/`sharedTxtMetadata`/`sharedTxtParts`, since those rows are owned by the recipient directly rather than reached by traversing someone else's; see "Permission rules" below.

- **`$users`** — one row per Firebase-authenticated identity, keyed by email. Carries three custom attributes beyond the built-in ones:
  - **`umk`** — base64, 128 random bytes, generated once per account and wrapped (`crypto.md`'s Blob format) under `user_root_key` — an external secret supplied by `creds.json`, never stored in InstantDB. `umk` is the encryption key for this account's `keyStore.keyStoreKey` and for every `credStore.credStoreKey` on a row this account owns — the intermediate keys that in turn protect `keyStore.privKey` and `credStore.content`, not those fields directly. `credStore.forUser` says which account a credential row is about; it does not change which `umk` wraps that row.
  - **`type`** — `'admin' | 'user'`. `'admin'` can create/update/delete any `txt`/`txtMetadata`/`txtParts`/`sharedTxt`/`sharedTxtParts` row and act on any account's data, full stop; `'user'` can only view its own `keyStore`/`credStore` rows (create/update/delete on those are admin-only — provisioning or rotating key material is a provisioning action, never a regular user self-service write), can view/create/update/delete its own `txtAccess`/`txtBookmarks` rows freely, and can read (never write) its own `sharedTxt`/`sharedTxtParts` rows — see "Permission rules" below for the exact rule per entity. Only ever writable via `instant.perms.ts`'s `$users.update: "isAdmin"` — there's no `isSelf` branch, so a plain user can never touch their own `type` (or anything else on their own `$users` row) through the normal write path, let alone self-promote to admin.
  - **`deleted`** — boolean, optional, set `true` by Manage Users' delete flow after it has already torn down that account's `keyStore`/`credStore`/`sharedTxt`/`txtAccess`/`txtBookmarks` rows and zeroed its `umk`. InstantDB refuses a real `delete` permission on `$users` at all (`instant.perms.ts`: "The `$users` namespace doesn't support permissions for delete"), so the row itself is permanent regardless of any of that — `deleted` is what lets Manage Users stop listing it once nothing else about the account still works. Absent on every row predating this field, same meaning as an explicit `false`.

  **Unverified — confirm before relying on this:** whether `auth.ref('$user.type')` (`instant.perms.ts`'s `isAdmin` check) resolves a plain, non-linked attribute on the current session's own `$users` row the same way `auth.ref`/`data.ref` resolve an attribute reached across a real link.

- **`keyStore`** — one row per user (`owner`, unique link to `$users`), holding that account's `lc_kyber_1024_x448` composite keypair (see `crypto.md`'s Composite KEM Key Sizes). `pubKey` is stored raw (1624 bytes, not sensitive); `keyStoreKey` (128 random bytes, wrapped under the owner's `umk`) protects `privKey` — a fresh intermediate key rather than wrapping `privKey` directly under `umk`. Sharing (`sharedTxt` below) does not use this keypair — it wraps a share's key symmetrically instead, since the admin can already recover any user's `umk` via that user's admin-owned recovery `credStore` row (see [r2_credentials.md](r2_credentials.md)'s Provisioning a `user` account). `keyStore` is kept provisioned for every account, admin included, against a future feature that does need an asymmetric wrap without the admin recovering the target's `umk` — see `crypto.md`'s Encapsulate/Decapsulate.

- **`credStore`** — encrypted credential rows. Fields: `owner` (link to `$users` — the account whose `umk` wraps this row's `credStoreKey`), `forUser` (link to `$users` — the account these credentials belong to), `credStoreKey` (128 random bytes, freshly generated per row and wrapped under `owner`'s `umk`), and `content`, a single encrypted JSON blob protected by that row's own `credStoreKey`. `forUser` is deliberately plaintext and queryable: the admin user-management flow can fetch the admin-owned credential row for one target user directly, instead of decrypting every admin-owned `credStore` row and matching by email or embedded id. It is not a permission grant; read access is still based on `owner` (or `isAdmin`) below.

  The normal self row for an account has `owner == forUser == that account`. An admin-managed recovery row has `owner == admin` and `forUser == target user`; its `content` is the admin-only backup/edit credential bundle for that target user, encrypted through `admin.umk -> this row's fresh credStoreKey -> content`. The target user's own row uses `target.umk -> its own fresh credStoreKey -> content`. These rows never share a `credStoreKey`.

  Because `owner` is not globally `unique()` at the schema level, "exactly one self row per account" and "at most one admin-managed recovery row per user" are provisioning/UI invariants, not database-enforced constraints. The R2 connection info exists for exactly one purpose: connecting to the bucket to read (or, for the admin, write) `txtParts` objects — the actual object addresses come from `txtParts.path` (below), not from here.

  For a `user`-role account's self row:

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

  For an admin-managed recovery row:

  ```json
  {
    "instant_app_id": "",
    "instant_client_name": "",
    "firebase_email": "",
    "firebase_password": "",
    "firebase_api_key": "",
    "display_name": "",
    "user_root_key": ""
  }
  ```

  The admin-managed recovery row also carries its own copy of `display_name`, written once at creation from the same admin-supplied value as the target's own self row (above) — `forUser` still identifies which account it's about, but Manage Users needs a name it can show/label a target account by without ever decrypting that account's own self row, which only the target's own `umk` can unwrap. Manage Users' Edit User screen surfaces this copy read-only and never resubmits it as part of an edit; nothing in the schema or permission rules enforces that, so an admin-authored `db.transact` outside that screen could still change it, and neither copy is kept in sync with the other after creation.

  For the admin's own self row:

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

  A `user`-role row's `r2_config` carries no access keys at all, since a `user` session never holds a static R2 credential of any kind, only a short-lived, prefix-scoped, read-only temporary one minted on demand after the Worker verifies current document access (see [r2_credentials.md](r2_credentials.md)) — a `user` account never writes to R2, and the Worker never grants it a credential that could. The admin's row carries the real, permanent R2 keys too. All CLI tooling that writes or deletes R2 objects (`--ingest`, `--clean-bucket`) resolves this same live row and uses those keys directly — none of it carries its own static R2 credential in creds.json. During admin unlock, `ui/` decrypts the combined self-row JSON containing those keys and _does_ retain the read-write pair in session state (`session.ts`'s `adminR2WriteCreds`) — the one deliberate exception to every other frontend R2 read still using a Worker-minted temporary credential, needed because sharing (see [protocols.md](protocols.md)'s Sharing protocol) writes the recipient's own copy directly from the browser. See [r2_credentials.md](r2_credentials.md)'s own design note for the trade-off this accepts.

- **`txt`** — one row per document. Fields: `owner` (link to `$users` — always the admin account today, per the operating model above), `txtKey` (128 random bytes, wrapped under `owner`'s `umk`), `prefix` — this document's own R2 prefix: a Crockford-base32-lowercase encoding of 32 random bytes, generated once when the document is created and wrapped under this row's own `txtKey` — `prefixHash = Base64(SHA-256(UTF-8(prefix)))`, a plaintext commitment generated alongside `prefix` so the credential Worker can verify that a client-supplied decrypted prefix belongs to this `txtId` without learning the prefix from InstantDB — and `seq`, a plaintext admin-assigned incrementing integer set once by `txt.ts --ingest` when it creates a document. `seq` exists purely so the whole-account paginated scans (`--clean-bucket`, `--update-db-catalog`, `--update-db-prefixHash`, and `ui/`'s own library loader) have a real, indexed attribute to `order` by, since an entity's own built-in `id` cannot be used in an InstaQL `order` clause. `prefix` is what actually addresses this document's content in R2 (see `txtParts` below and [r2_credentials.md](r2_credentials.md)): unlike a value derived from `auth.id`, it's random and only ever recoverable by decrypting it under `txtKey` — so knowing which account owns a document, or even that account's `auth.id`, gives an attacker no way to compute where that document's parts live in the bucket. The hash does not weaken that property because its input has 256 bits of randomness; it only binds a supplied prefix to a row. `txt.ts --update-db-prefixHash --creds <creds.json>` decrypts every admin-owned document's existing `prefix` and backfills/repairs this derived field.

  `txt` itself carries no name/metadata/read-position — see `txtMetadata` and `txtAccess` below.

- **`txtMetadata`** — one row per document (`txt`, unique link to `txt`). Fields: `owner` (link to `$users`, same account as `txt.owner` — kept as its own single-hop link for permission rules rather than traversing `txt.owner`), `content`, and `catalog`.

  `content` is the full encrypted metadata JSON blob (wrapped directly under this document's own `txtKey`, brotli-compressed):

  ```json
  {
    "name": "original filename",
    "metadata": { "...": "opf sidecar fields, when present" }
  }
  ```

  `catalog` is the lightweight listing projection extracted from `content`, also wrapped directly under the document's own `txtKey` and brotli-compressed:

  ```json
  {
    "name": "original filename",
    "title": "display title",
    "authors": [],
    "subjects": [],
    "publishers": []
  }
  ```

  `catalog` is the preferred column name: it describes the normalized data needed to render the library/catalog list, without implying that this is the complete metadata (`metadata`) or a human-written excerpt (`summary`/`preview`). Library loading fetches `txtMetadata.catalog` only. The reader screen and metadata-edit flow fetch full `txtMetadata.content` on demand; any metadata edit must update both `content` and the derived `catalog` in the same transaction.

  `txt.ts --update-db-catalog --creds <creds.json>` rewrites this derived `catalog` for every admin-owned metadata row, including rows that already have an older catalog blob, so additive projection changes like `title` are backfilled rather than only filling missing values.

  Unwrapping either metadata blob is the same two-step chain as a document's `txtParts`: `umk` unwraps `txtKey`, `txtKey` unwraps `content` or `catalog` directly — no intermediate per-purpose key. A share recipient never reads this row at all — sharing re-encrypts a copy of `content`/`catalog` onto that share's own `sharedTxtMetadata` row (below) at share time, so a recipient's metadata read stays a single-hop, owner-only lookup on their own row, the same shape as every other read in this design.

- **`txtParts`** — a document's content, chunked into ordered parts. Fields: `txt` (link to `txt`), `owner` (link to `$users`, same account as `txt.owner` — kept as its own single-hop link for permission rules rather than traversing `txt.owner`, same reasoning as `txtMetadata` above), `partNum` (1-based), `txtPartKey` (128 random bytes, wrapped under this document's own `txtKey`), `path` — wrapped under this row's own `txtPartKey`, not `txtKey` directly — Crockford-base32-lowercase encoding of 32 random bytes, and a synthetic `partKey = "${txtId}:${partNum}"` (`unique().indexed()` — see "The composite-uniqueness problem" below). The actual part content is **not** in InstantDB: `path`, once decrypted, is a fresh random key `raw_key`, and the real R2 object lives at `raw_path = "${prefix}/${raw_key}"`, where `prefix` is this document's own `txt` row's `prefix` field, decrypted directly under `txtKey` (unaffected by any one part's own `txtPartKey`). The R2 object body is `Blob.encrypt(txtPartKey, brotli(cleaned part text))` — the same `txtPartKey` that wraps `path`, a second independent application of it. Giving every part its own key (rather than reusing the document's `txtKey` directly for `path`/the object body) means a single part's `txtPartKey` being compromised exposes only that one part — never another part of the same document, and never the document-level `prefix`, both of which stay under `txtKey` alone.

- **`sharedTxt`** — one row per (document, recipient) share, and a `user` account's _only_ path to any document's content: not a grant to read the admin's own `txt`/`txtParts`/`txtMetadata` rows, but an independent, admin-made copy of that document — its own `txtKey`, its own R2 `prefix`, its own `sharedTxtParts`/`sharedTxtMetadata` (below).

  Fields: `txt` (link to the source `txt` row, for provenance — e.g. an admin UI listing every current recipient of a document), `owner` (link to `$users`, the recipient — this row's permission owner, same role `owner` plays on `txt` itself), `fromUser` (link to `$users` — always the admin, since only the admin can create a share), and a synthetic `shareKey = "${txtId}:${fromUserId}:${toUserId}"` (`unique().indexed()` — see "The composite-uniqueness problem" below).

  This share's own root key (128 random bytes, generated fresh per share — independent of the source document's own `txtKey`, and never itself stored) is wrapped **two** independent, purely symmetric ways, both recovering the same plaintext bytes — sharing does not use `keyStore`'s KEM keypair or Encapsulate/Decapsulate at all:
  - `adminTxtKey` — wrapped directly under `fromUser`'s (the admin's) own `umk`, exactly like `txt.txtKey` is wrapped under its owner's `umk`. This exists purely so admin-side tooling (the orphan sweep, below) can recover this share's whole chain — its `prefix`, every part's `raw_key` — on demand, without re-deriving anything about the recipient.
  - `userTxtKey` — wrapped directly under `owner`'s (the recipient's) own `umk`, the same way `txt.txtKey` is wrapped under its owner's `umk`. The admin can produce this wrap because creating a share is already an admin action with admin-level reach: the admin looks up its own admin-owned recovery `credStore` row for that recipient (`owner == admin`, `forUser == recipient`), decrypts that row's `content` to recover the recipient's `user_root_key`, and uses it to decrypt the recipient's own `$users.umk` field — the same `user_root_key -> umk` unwrap [key_hierarchy.md](key_hierarchy.md) already defines, just performed by the admin instead of the recipient's own client. A recipient's ordinary read of their own `sharedTxt` row then unwraps `userTxtKey` exactly like an owner unwraps `txt.txtKey` — under their own `umk`, no different code path from reading anything else they own.

  Everything below is wrapped directly under this share's own root key plaintext bytes — whichever field (`adminTxtKey` or `userTxtKey`) it was unwrapped from — exactly mirroring `txt`'s own chain: `prefix` (this share's own, independent R2 prefix — never the source document's own prefix, and never shared with any other recipient's share of the same document), `prefixHash = Base64(SHA-256(UTF-8(prefix)))` (plaintext commitment, same purpose as `txt.prefixHash`).

  A recipient's read access to their own `sharedTxt`/`sharedTxtParts`/`sharedTxtMetadata` rows is a plain, single-hop `isOwner` check — see "Permission rules" below. They never read the source `txt`/`txtParts`/`txtMetadata` rows at all.

- **`sharedTxtMetadata`** — one row per share (`sharedTxt`, unique link to `sharedTxt`) — the `sharedTxt` analogue of `txtMetadata`, same split and same reasoning: a recipient's library view loads only `catalog`, never full `content`. Fields: `sharedTxt` (link), `owner` (link to `$users`, same account as `sharedTxt.owner` — kept as its own single-hop link for permission rules, same reasoning as `txtMetadata.owner`), `content` and `catalog` — re-encrypted copies of the source document's `txtMetadata.content`/`catalog`, made once at share time (see [protocols.md](protocols.md)'s Sharing protocol) and wrapped directly under this share's own root key, same shape as `txtMetadata`.

- **`sharedTxtParts`** — a share's content, chunked into ordered parts — the `sharedTxt` analogue of `txtParts`, with the same reasoning throughout. Fields: `sharedTxt` (link to `sharedTxt`), `owner` (link to `$users`, same account as `sharedTxt.owner` — kept as its own single-hop link for permission rules, same reasoning as `txtParts.owner`), `partNum` (1-based), `txtPartKey` (128 random bytes, wrapped under this share's own root key), `path` (wrapped under this row's own `txtPartKey`, Crockford-base32-lowercase encoding of 32 random bytes), and a synthetic `partKey = "${sharedTxtId}:${partNum}"` (`unique().indexed()`). The R2 object itself lives at `raw_path = "${sharedTxt.prefix}/${raw_key}"`, decrypted the same two-step way as a `txtParts` object — a share's R2 content is a full, independent copy, never the same object the source document's own `txtParts` point at.

- **`txtAccess`** — one row per user (`owner`, unique link to `$users`), holding that user's read position across every document they've opened — owner or share recipient alike. `txtAccessKey` (128 random bytes, wrapped under `owner`'s `umk`) protects `content`, a single encrypted JSON blob keyed by `txt_id`: `{"<txt_id>": {"last_part_num": int, "last_accessed": int}, ...}`, where `last_part_num` uses the same 1-based numbering as `txtParts.partNum`, capped at 10 `txt_id` entries (client evicts the entry with the oldest `last_accessed` before exceeding the cap — no DB-level enforcement).

- **`txtBookmarks`** — one row per user (`owner`, unique link to `$users`), holding that user's bookmarks across every document they've opened — owner or share recipient alike. `txtBookmarkKey` (128 random bytes, wrapped under `owner`'s `umk`) protects `content`, a single encrypted JSON blob keyed by `txt_id`: `{"<txt_id>": [{"part_num": int, "line": int, "txt_preview": str, "created_at": int (unix ms)}, ...], ...}`, where `part_num` uses the same 1-based numbering as `txtParts.partNum` and `line` is 1-based within that part, each `txt_id`'s list capped at 20 entries (client evicts the oldest `created_at` before exceeding the cap — no DB-level enforcement).

## Permission rules

Two predicates, all evaluated in `instant.perms.ts`:

- `isAdmin` — `'admin' in auth.ref('$user.type')`.
- `isOwner` — `auth.id in data.ref('owner.id')`, single-hop off this row's own `owner` link. Every entity below is gated this same single-hop way — there is no two-hop or cross-entity predicate anywhere in this design, since a share is its own independent, directly-owned row (`sharedTxt`/`sharedTxtParts`) rather than a grant to read someone else's.

| Entity              | read                   | create                 | update                 | delete                 |
| ------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| `keyStore`          | `isAdmin \|\| isOwner` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `credStore`         | `isAdmin \|\| isOwner` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txt`               | `isAdmin \|\| isOwner` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txtMetadata`       | `isAdmin \|\| isOwner` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txtParts`          | `isAdmin \|\| isOwner` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `sharedTxt`         | `isAdmin \|\| isOwner` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `sharedTxtMetadata` | `isAdmin \|\| isOwner` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `sharedTxtParts`    | `isAdmin \|\| isOwner` | `isAdmin`              | `isAdmin`              | `isAdmin`              |
| `txtAccess`         | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` |
| `txtBookmarks`      | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` | `isAdmin \|\| isOwner` |

`owner` on a `sharedTxt`/`sharedTxtMetadata`/`sharedTxtParts` row is the recipient, not the admin who created it — the same role `owner` plays on every other entity above, just filled by a different account than the one that wrote the row. `isAdmin` alone covers the `create`/`update`/`delete` columns for all three, since the recipient never writes their own share. This is the whole point of the operating model: a recipient gets **read-only** access to their own `sharedTxt`/`sharedTxtMetadata`/`sharedTxtParts` — `isOwner` never appears in a `create`/`update`/`delete` rule on any of the three — but **full read/write** on their own `txtAccess`/`txtBookmarks` rows regardless of which document those entries reference. Tracking your own read position and bookmarks for a document is not the same permission as writing the document (or the share) itself.

### Design notes

- **Isolation depends entirely on permission rules, not physical separation** — a rules bug is a cross-user data leak across the whole app, not contained to a single account.
- **Reading a document and tracking your own progress through it are deliberately two different permissions.** A share recipient's access to their own `sharedTxt`/`sharedTxtMetadata`/`sharedTxtParts` is read-only, full stop — but their `txtAccess`/`txtBookmarks` rows are gated on `isOwner` of that row (not the share), so they can freely record their own read position and bookmarks for a shared document without ever needing write access to the share itself.
- **`credStore.forUser` is an admin-management index, not an access-control hook.** A user can read a `credStore` row only when they own that row; the admin recovery copy for that same user is owned by the admin and remains admin-only despite pointing at the user through `forUser`.

## The composite-uniqueness problem (guarded insert)

InstantDB's `unique()` constraint is per-attribute, whole-namespace — it cannot express "unique per (a, b, c)" directly. Three entities above need a composite key for exactly this reason, and each follows the same fix: compute a synthetic key client-side and mark it `unique().indexed()`, so a concurrent duplicate insert fails outright rather than needing a hand-rolled existence check first.

| Entity           | Synthetic key                                     | Guards against                                             |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `txtParts`       | `partKey = "${txtId}:${partNum}"`                 | two concurrent ingests writing the same part twice         |
| `sharedTxt`      | `shareKey = "${txtId}:${fromUserId}:${toUserId}"` | double-sharing the same document to the same recipient     |
| `sharedTxtParts` | `partKey = "${sharedTxtId}:${partNum}"`           | two concurrent share-copy runs writing the same part twice |

Every synthetic key is deterministic and plaintext by design (it only needs to be unique and computable, never secret). The values it helps guard have their own appropriate representation: `txtParts.path`, `sharedTxtParts.path`, and `sharedTxt.adminTxtKey`/`userTxtKey` are wrapped because they contain a real R2 address or real key material. `txtMetadata`/`sharedTxtMetadata` and `txtAccess` don't need a synthetic key: both metadata entities are one row per parent (a plain unique link), and `txtAccess` is one row per user (`unique()` on the link to `$users` alone).
