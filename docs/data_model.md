# Data Model

InstantDB schema — declarative, reactive, and permissioned, not SQL. The actual schema and permission rules live in [`instant.schema.ts`](../instant.schema.ts) and [`instant.perms.ts`](../instant.perms.ts) at the repo root (both the admin CLI and the web UI import from there) — this doc describes their shape and the reasoning behind it, it does not duplicate the code.

**Every stored payload is a blob-encrypted object in R2, addressed by a `path` field.** Small wrapped-key columns (`umkStore.umkBlob`, `txt.txtKeyBlob`, `metadataStore.metadataKeyBlob`) live inline in InstantDB as `i.string()` fields; everything else — a `txt` row's content parts, its read-position, its bookmarks, and the per-user filename index — is an object in Cloudflare R2, referenced by a `path: i.string().unique().indexed()` field on the corresponding InstantDB row. InstantDB itself no longer stores or serves any of that content directly (there is no `$files` entity in this schema) — it only holds the path pointer, gated by the same `isOwner` rule as every other field on that row. The `path` value is plaintext (it's just an address); the object it points to in R2 is always the same AEAD wire format described in [crypto.md](crypto.md) (`magic || version || salt || ciphertext || tag`).

## Key Hierarchy

```
user_root_key (per user; minted by the admin CLI at account-creation time and
                delivered to that user once, out-of-band -- never stored in InstantDB)
  └── umk                (umkStore.umkBlob)
        ├── txt_key       (txt.txtKeyBlob)                  — one per txt row
        │     ├── each part's content   (R2 object at txtParts.path, one row per part, ordered by partNum)
        │     ├── read-position         (R2 object at txtAccess.path)
        │     └── each bookmark's payload (R2 object at bookmarks.path)
        └── metadata_key  (metadataStore.metadataKeyBlob)   — one per user
              └── filename index         (R2 object at metadataStore.path)
```

`user_root_key` wraps `umk`; `umk` wraps `txt_key` and `metadata_key`; `txt_key` and `metadata_key` each wrap the actual content that hangs off them — `umk` itself never encrypts bulk content directly, only these two second-tier keys. `txtParts`, `txtAccess`, and `bookmarks` have no key of their own: all three live directly off a specific `txt` row, so their content is encrypted under that row's own `txt_key`. Full derivation/blob-format mechanics (HKDF, Ascon-Keccak, salts, versioning) are in [crypto.md](crypto.md); this is just the map of which entity/field sits where in that chain.

## Entities

- **`$users`** — InstantDB's built-in user entity. `email` is InstantDB's native field (populated at provisioning time, not separately declared/indexed here); the only field this app adds is `type` (required — every `$users` row has one), this app's own role field: `"admin"` acts only through the admin CLI (full CRUD via the InstantDB admin SDK, bypassing `instant.perms.ts`), `"user"` acts only through the web UI, bound by the rules below. Nothing in `instant.perms.ts` branches on `type` — only the admin CLI, via the InstantDB **admin** SDK (which bypasses `instant.perms.ts` entirely), acts on it.
- **`umkStore`** — one row per user: `umkBlob`, that user's `umk` wrapped under their `user_root_key`. Linked to `$users` via `umkStoreOwner`, `has: 'one'` on both sides (see Uniqueness below for why that shape is a deliberate, previously-troublesome choice).
- **`txt`** — one row per file: `txtKeyBlob`, that file's content key wrapped under the owning user's `umk`. No other fields — filename, content, read-position, and bookmarks all live off linked rows, never here. Linked to exactly one `umkStore` via `txtUmkStore` (`required: true` — a `txt` row can't exist unowned). Ownership is transitive through this link, not a direct link to `$users`: `instant.perms.ts` checks `auth.id in data.ref('umk.owner.id')`, not a direct `data.ref('owner.id')`.
- **`txtParts`** — many per `txt` row, linked via `txtTxtParts`. Each row is one ordered chunk of that file's content: `path` (the R2 object holding that chunk's encrypted, brotli-compressed bytes) and `partNum` (its order — indexed, so the reader can fetch/decrypt parts in sequence rather than downloading the whole file at once).
- **`txtAccess`** — one per `txt` row, linked via `txtAccessTxt`. Holds only `path`: read-position (last part read, last-accessed timestamp) lives in the R2 object at that path, encrypted under the owning `txt` row's `txt_key`. Because there's no cross-user sharing in this design (every `txt` row links to exactly one `umkStore`/owner, `has: 'one'` all the way down), a `txt` row has at most one possible reader, its owner — so read-position never needs a composite key, just this one-to-one link.
- **`metadataStore`** — one row per user: `metadataKeyBlob` (wrapped under that user's `umk`) and `path`. The actual filename index (a JSON map of every `txt` id this user owns → its name) is the R2 object at that path, encrypted under `metadata_key`. Linked to `umkStore` via `umkStoreMetadata`.
- **`bookmarks`** — many per `txt` row, linked via `txtBookmarks`. Holds only `path`: the bookmark payload is the R2 object at that path, encrypted under the owning `txt` row's `txt_key` — there's no separate bookmark key to wrap or store.

## Entities and links

```
$users
  └─ umkStoreOwner (1:1) ─ umkStore
       ├─ txtUmkStore (1:many) ─ txt
       │     ├─ txtTxtParts (1:many) ─ txtParts        [path -> R2, one part's content, enc by txt_key]
       │     ├─ txtAccessTxt (1:1) ─ txtAccess          [path -> R2, read-position, enc by txt_key]
       │     └─ txtBookmarks (1:many) ─ bookmarks       [path -> R2, bookmark payload, enc by txt_key]
       └─ umkStoreMetadata (1:1) ─ metadataStore         [path -> R2, filename index, enc by metadata_key]
```

## Permissions

Every entity uses the same `isOwner` shape: bind an `isOwner` predicate that walks the link chain up to `umkStore.owner` (=`$users`), then gate `view`/`create`/`delete` on it, plus `update` where the entity's own fields can legitimately change post-creation:

| Entity | `isOwner` bind | `update` allowed? |
|--------|----------------|--------------------|
| `umkStore` | `auth.id in data.ref('owner.id')` | yes, except the `owner` link itself |
| `txt` | `auth.id in data.ref('umk.owner.id')` | yes, except the `umk` link itself |
| `txtParts` | `auth.id in data.ref('txt.umk.owner.id')` | no — a part is created once, then deleted (never edited in place) |
| `metadataStore` | `auth.id in data.ref('owner.owner.id')` | yes, except the `owner` link itself |
| `bookmarks` | `auth.id in data.ref('txt.umk.owner.id')` | no — write-once, then delete only |
| `txtAccess` | `auth.id in data.ref('txt.umk.owner.id')` | yes, except the `txt` link itself — `path` is updated in place as the reader progresses |

There is no separate storage-layer permission rule anymore: with `$files` gone, a row's `path` field is just an ordinary string, protected by the same `view`/`update` rule as every other field on that row — nothing InstantDB-side additionally restricts who can read a `path` value once a row is visible. Whatever actually gates GET/PUT access to the R2 object at that path is outside this schema and not addressed here — see the note below.

None of this branches on `$users.type` — a regular user's session is bound by these rules regardless of role, since the web UI never needs admin-shaped access to any row, including its own user's. Only the admin CLI, via the InstantDB **admin** SDK, bypasses `instant.perms.ts` entirely.

## Notes

### Uniqueness

`umkStoreOwner`'s current `has: 'one'`/`has: 'one'` shape (declared on both `umkStore`'s `owner` label and `$users`' reverse `umkStore` label) is a **deliberate retry** of a shape that previously produced a persistent "already exists" rejection on creating a `umkStore` row for a user — this happened even after confirming there were zero existing `umkStore` rows for that user, no leftover entities from earlier diagnostic renames of the link, and that the request was made with correct auth. The root cause was never conclusively identified. The fallback used at the time (and the one to reach for again if this rejection recurs) was to relax the reverse side to `has: 'many'` on `$users`, and add a client-side check in application code — `queryOwnUmkStoreRow` in `src/db.ts` — that treats getting back more than one row as a fatal error, since the schema itself no longer guarantees at most one. Under the current strict `has: 'one'`/`has: 'one'` shape, `queryOwnUmkStoreRow` gets a single row or `undefined` back, never an array, so that client-side "more than one is fatal" check has nothing left to do — the schema constraint is what's actually being trusted this time, not a fallback still quietly doing the work.

### `onDelete: 'cascade'`/`required: true` sit on the dependent side, not the anchor

Across every link in `instant.schema.ts`, the side that should disappear when the other side is deleted is the one carrying `onDelete: 'cascade'` (and, where the link can't exist meaningfully without its anchor, `required: true` too) — e.g. `txtUmkStore` puts both on `txt` (deleted when its `umkStore` is deleted), `umkStoreMetadata` puts both on `metadataStore`, `txtBookmarks` puts both on `bookmarks`, and `txtTxtParts` puts both on `txtParts` — in each case the anchor side carries neither flag. Getting this backwards silently inverts which entity survives a deletion, so it's worth checking explicitly against an existing link rather than guessing when adding a new one.

`txtAccessTxt` carries `onDelete: 'cascade'` (on `txtAccess`, correctly — a `txtAccess` row is deleted when its `txt` row is) but not `required: true`, unlike its otherwise-identical siblings `txtBookmarks`/`umkStoreMetadata`/`txtTxtParts`. Whether that's deliberate (read-position tracking is meant to be optional/lazy per `txt` row) or a gap worth closing hasn't been confirmed either way — flagged here rather than assumed.

Deleting a **user** cascades `umkStoreOwner` → `umkStore` → (`txtUmkStore` → every `txt` row → `txtTxtParts`/`txtBookmarks`/`txtAccessTxt`) and (`umkStoreMetadata` → `metadataStore`), wiping every InstantDB row that user owned in one operation. It does **not** delete anything in R2 — the `path` values disappear along with the rows that held them, but the objects those paths pointed to are only ever cleaned up if something explicitly deletes them from R2 too. This is a real gap, not a subtlety: an R2 object can outlive every InstantDB row that ever referenced its path, and nothing in this schema notices or prevents that.

### R2 access control is not defined by this schema

Every `path` field here is protected by the same `isOwner` rule as the rest of its row — that governs whether a session can read *the string*, not whether it can actually `GET`/`PUT` the R2 object that string names. Nothing in `instant.schema.ts`/`instant.perms.ts` gates the object bytes themselves — whatever authorizes a client to actually fetch or write an R2 object (bucket policy, presigned URLs, a path-prefix convention enforced server-side) is not defined here and should not be assumed solved by this doc.
