# Data Model

InstantDB schema — declarative, reactive, and permissioned, not SQL. The actual schema and permission rules live in [`instant.schema.ts`](../instant.schema.ts) and [`instant.perms.ts`](../instant.perms.ts) at the repo root (both the admin CLI and the web UI import from there) — this doc describes their shape and the reasoning behind it, it does not duplicate the code.

**Every file's content is a blob-encrypted payload, never plaintext.** Small wrapped-key columns (`umkStore.umkBlob`, `txt.txtKeyBlob`, `metadataStore.metadataKeyBlob`) live inline as `i.string()` fields; everything else — a `txt` row's content and edit history, its read-position, its bookmarks, and the per-user filename index — lives in a linked `$files` row instead of a DB column, uploaded via InstantDB Storage (backed by Cloudflare R2). `$files.path`/`$files.url` are the only plaintext fields anywhere in this schema: they're storage addressing (an object path, a download URL), not content. Every uploaded file's actual bytes are the same AEAD wire format described in [crypto.md](crypto.md) (`magic || version || salt || ciphertext || tag`) — nothing is ever stored as raw plaintext or a naked JSON string.

## Key Hierarchy

```
user_root_key (per user; see architecture.md's Provisioning pipeline for how it's minted/delivered)
  └── umk                (umkStore.umkBlob)
        ├── txt_key       (txt.txtKeyBlob)                  — one per txt row
        │     ├── txt content + history    ($files, via txtPartFile)
        │     ├── read-position            ($files, via txtAccessFileEntry, off txtAccess)
        │     └── each bookmark's payload  ($files, via bookmarkFileEntry, off bookmarks)
        └── metadata_key  (metadataStore.metadataKeyBlob)   — one per user
              └── filename index           ($files, via txtMetadataFile)
```

`user_root_key` wraps `umk`; `umk` wraps `txt_key` and `metadata_key`; `txt_key` and `metadata_key` each wrap the actual content that hangs off them — `umk` itself never encrypts bulk content directly, only these two second-tier keys. `txtAccess` and `bookmarks` have no key of their own: both live directly off a specific `txt` row, so their content is encrypted under that row's own `txt_key`, the same key that encrypts the row's own part content. Full derivation/blob-format mechanics (HKDF, Ascon-Keccak, salts, versioning) are in [crypto.md](crypto.md); this is just the map of which entity/field sits where in that chain.

## Entities

- **`$users`** — InstantDB's built-in user entity. `email` is InstantDB's native field (populated at provisioning time, not separately declared/indexed here); the only field this app adds is `type` (required — every `$users` row has one), this app's own role field (`"admin" | "user"`, see [architecture.md](architecture.md)'s Role model). Nothing in `instant.perms.ts` branches on `type` — only the admin CLI, via the InstantDB **admin** SDK (which bypasses `instant.perms.ts` entirely), acts on it.
- **`umkStore`** — one row per user: `umkBlob`, that user's `umk` wrapped under their `user_root_key`. Linked to `$users` via `umkStoreOwner`, `has: 'one'` on both sides (see Uniqueness below for why that shape is a deliberate, previously-troublesome choice).
- **`txt`** — one row per file: `txtKeyBlob`, that file's content key wrapped under the owning user's `umk`. No other fields — filename, content, history, read-position, and bookmarks all live off linked rows, never here. Linked to exactly one `umkStore` via `txtUmkStore` (`required: true` — a `txt` row can't exist unowned). Ownership is transitive through this link, not a direct link to `$users`: `instant.perms.ts` checks `auth.id in data.ref('umk.owner.id')`, not a direct `data.ref('owner.id')`.
- **`txtAccess`** — one per `txt` row, linked via `txtAccessTxt`. No fields of its own: read-position (last part read, last-accessed timestamp) lives entirely in its linked `$files` row (`txtAccessFileEntry`), encrypted under the owning `txt` row's `txt_key`. Because there's no sharing in this design (see [architecture.md](architecture.md)), a `txt` row has at most one possible reader — its owner — so this never needs a composite key the way the old `txt_access` table did.
- **`metadataStore`** — one row per user: `metadataKeyBlob`, wrapped under that user's `umk`. The actual filename index (a JSON map of every `txt` id this user owns → its name) lives in its linked `$files` row (`txtMetadataFile`), encrypted under `metadata_key`, not here. Linked to `umkStore` via `umkStoreMetadata`.
- **`bookmarks`** — many per `txt` row, linked via `txtBookmarks`. No fields at all: the bookmark payload lives in its linked `$files` row (`bookmarkFileEntry`), encrypted under the owning `txt` row's `txt_key` — there's no separate bookmark key to wrap or store.
- **`$files`** — InstantDB's Storage-backed file entity (backed by Cloudflare R2). Four different owners link to it, each following the same atomically-swapped shape (see Notes below): `txt` (content + history, via `txtPartFile`), `txtAccess` (read-position, via `txtAccessFileEntry`), `bookmarks` (payload, via `bookmarkFileEntry`), and `metadataStore` (filename index, via `txtMetadataFile`).

## Entities and links

```
$users
  └─ umkStoreOwner (1:1) ─ umkStore
       ├─ txtUmkStore (1:many) ─ txt
       │     ├─ txtPartFile (1:1) ─ $files              [content + history, enc by txt_key]
       │     ├─ txtAccessTxt (1:1) ─ txtAccess
       │     │     └─ txtAccessFileEntry (1:1) ─ $files  [read-position, enc by txt_key]
       │     └─ txtBookmarks (1:many) ─ bookmarks
       │           └─ bookmarkFileEntry (1:1) ─ $files    [bookmark payload, enc by txt_key]
       └─ umkStoreMetadata (1:1) ─ metadataStore
             └─ txtMetadataFile (1:1) ─ $files            [filename index, enc by metadata_key]
```

## Permissions

Every non-`$files` entity uses the same `isOwner` shape: bind an `isOwner` predicate that walks the link chain up to `umkStore.owner` (=`$users`), then gate `view`/`create`/`delete` on it, plus `update` where the entity's own fields can legitimately change post-creation:

| Entity | `isOwner` bind | `update` allowed? |
|--------|----------------|--------------------|
| `umkStore` | `auth.id in data.ref('owner.id')` | yes, except the `owner` link itself |
| `txt` | `auth.id in data.ref('umk.owner.id')` | yes, except the `umk` link itself |
| `metadataStore` | `auth.id in data.ref('owner.owner.id')` | yes, except the `owner` link itself |
| `bookmarks` | `auth.id in data.ref('txt.umk.owner.id')` | no — write-once, then delete only |
| `txtAccess` | `auth.id in data.ref('txt.umk.owner.id')` | yes, except the `txt` link itself — read-position is swapped in place as the reader progresses |

`$files` uses a different, path-based rule instead of an owner-chain `bind`: `data.path.startsWith(auth.id + '/')`, so every upload this app makes must be written under a `${auth.id}/...` path for the permission to hold, regardless of which entity ends up linking to it.

None of this branches on `$users.type` — a regular user's session is bound by these rules regardless of role, since the web UI never needs admin-shaped access to any row, including its own user's. Only the admin CLI, via the InstantDB **admin** SDK, bypasses `instant.perms.ts` entirely.

## Notes

### Uniqueness

`umkStoreOwner`'s current `has: 'one'`/`has: 'one'` shape (declared on both `umkStore`'s `owner` label and `$users`' reverse `umkStore` label) is a **deliberate retry** of a shape that previously produced a persistent "already exists" rejection on creating a `umkStore` row for a user — this happened even after confirming there were zero existing `umkStore` rows for that user, no leftover entities from earlier diagnostic renames of the link, and that the request was made with correct auth. The root cause was never conclusively identified. The fallback used at the time (and the one to reach for again if this rejection recurs) was to relax the reverse side to `has: 'many'` on `$users`, and add a client-side check in application code — `queryOwnUmkStoreRow` in `src/db.ts` — that treats getting back more than one row as a fatal error, since the schema itself no longer guarantees at most one. Under the current strict `has: 'one'`/`has: 'one'` shape, `queryOwnUmkStoreRow` gets a single row or `undefined` back, never an array, so that client-side "more than one is fatal" check has nothing left to do — the schema constraint is what's actually being trusted this time, not a fallback still quietly doing the work.

### `onDelete: 'cascade'`/`required: true` sit on the dependent side, not the anchor

Across every link in `instant.schema.ts`, the side that should disappear when the other side is deleted is the one carrying `onDelete: 'cascade'` (and, where the link can't exist meaningfully without its anchor, `required: true` too) — e.g. `txtUmkStore` puts both on `txt` (deleted when its `umkStore` is deleted), `umkStoreMetadata` puts both on `metadataStore`, and `txtBookmarks` puts both on `bookmarks` — in each case the anchor side carries neither flag. Getting this backwards silently inverts which entity survives a deletion, so it's worth checking explicitly against an existing link rather than guessing when adding a new one.

`txtAccessTxt` is the one link that carries `onDelete: 'cascade'` (on `txtAccess`, correctly — a `txtAccess` row is deleted when its `txt` row is) but not `required: true`, unlike its otherwise-identical siblings `txtBookmarks`/`umkStoreMetadata`. Whether that's deliberate (read-position tracking is meant to be optional/lazy per `txt` row) or a gap worth closing hasn't been confirmed either way — flagged here rather than assumed.

### Four links share one atomic-swap shape: upload first, link second

`txtPartFile`, `txtAccessFileEntry`, `bookmarkFileEntry`, and `txtMetadataFile` are all `has: 'one'`/`has: 'one'` on `$files` without `required: true` on the `$files` side, for the same reason in every case: the `$files` row is created by a separate `db.storage.uploadFile` call *before* the `db.transact` that links it to its owner, so for a moment after upload the file exists unlinked — `required: true` would reject that transient state. Each link is still safe because the eventual link (and the unlink of whatever file it's replacing, on an update) happens inside one atomic `db.transact` — there is never an externally observable moment with zero or two files linked to a given row, only ever the single moment right after upload where a *new, not-yet-linked* file exists on its own. `txtPartFile`'s version is the one that actually matters most in practice, since it's the one that preserves edit history on every swap: the prior `current` value is appended onto a `history` array before the new content is uploaded and swapped in, rather than being discarded the way `--force` re-ingest used to work.
