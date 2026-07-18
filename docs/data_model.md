# Data Model

InstantDB schema — declarative, reactive, and permissioned, not SQL — shared by the admin CLI and the web UI. The actual schema and permission rules live in [`instant.schema.ts`](../instant.schema.ts) and [`instant.perms.ts`](../instant.perms.ts) at the repo root (both `cli/` and `ui/` import from there) — they are not duplicated in this doc. A duplicated copy drifting from what's actually pushed caused several real bugs earlier (see Uniqueness below), so this file describes the shape and the reasoning behind it rather than embedding the code itself.

`$files`, `$users`, `txt`, `umkStore`, and their links (`txtUmkStore`, `txtFileEntry`, `umkStoreOwner`) are pulled from the deployed app (`npx instant-cli@latest pull schema`/`pull perms`), not hand-maintained. `metadataStore` and `bookmarks` (and their links, and the two new fields on `txt`) are marked **proposed** in both files — designed here, not yet pushed — see Additions below.

Nothing in the old SQLite design's `txt_parts`/`part_count` survives the move to InstantDB: bulk content — an entry's text and its full edit history, the metadata index's JSON, a bookmark's payload — all live in a linked `$files` row now that object storage is available, instead of a DB column. Only small wrapped-key blobs (`umkBlob`, `txtKeyBlob`, `metadataKeyBlob`) stay inline as `i.string()` fields.

## Entities and links

```
$users
  └─ umkStoreOwner (1:1) ─ umkStore
       ├─ txtUmkStore (1:many) ─ txt
       │     ├─ txtFileEntry (1:1) ─ $files                [content + history]
       │     └─ txtBookmarks (1:many) ─ bookmarks (proposed)
       │           └─ bookmarkFileEntry (1:1) ─ $files      [bookmark payload]
       └─ umkStoreMetadata (1:1) ─ metadataStore (proposed)
             └─ metadataFileEntry (1:1) ─ $files            [filename index]
```

- **`$users`** — InstantDB's built-in user entity. `email` is InstantDB's native field (populated at provisioning time, not separately declared/indexed here); the only field this app adds is `type` (required — every `$users` row has one, no InstantDB-default-user case to leave it unset for), this app's own role field (`"admin" | "user"`, see [architecture.md](architecture.md)'s Role model). Nothing in `instant.perms.ts` currently branches on `type` — only the admin CLI, via the InstantDB **admin** SDK (which bypasses `instant.perms.ts` entirely), acts on it.
- **`umkStore`** — one row per user, holding that user's wrapped `umk` (`umkBlob`). `umkStoreOwner` is `has: 'one'` on both sides (see Uniqueness below for why that shape is a deliberate, previously-troublesome choice, not an oversight).
- **`txt`** — one row per file, holding its wrapped content key (`txtKeyBlob`) and, proposed, its read-position (`lastPartNum`/`lastAccessed`). Links to exactly one `umkStore` via `txtUmkStore` (`required: true` — a `txt` row can't exist unowned). Ownership is transitive through this link, not a direct link to `$users`: `instant.perms.ts` checks `auth.id in data.ref('umk.owner.id')`, not a direct `data.ref('owner.id')`.
- **`$files`** — InstantDB's Storage-backed file entity (backed by Cloudflare R2). Three different owners link to it, each atomically swapped the same way (see the note below): a `txt` row's content + history via `txtFileEntry`, a `metadataStore` row's index via `metadataFileEntry` (proposed), and a `bookmarks` row's payload via `bookmarkFileEntry` (proposed).
- **`metadataStore`** (proposed) — one row per user, holding only the wrapped `metadataKeyBlob`; the actual filename index lives in its linked `$files` row via `metadataFileEntry`. Linked to `umkStore` via `umkStoreMetadata`.
- **`bookmarks`** (proposed) — many per `txt` row, linked via `txtBookmarks`. No fields of its own at all — the bookmark payload lives in its linked `$files` row via `bookmarkFileEntry`, and it's keyed off the owning `txt` row's `txtKeyBlob` (see [crypto.md](crypto.md)'s Bookmark Encryption section), so there's no separate key blob to store here either.

Neither `instant.schema.ts` nor `instant.perms.ts` grants the `admin`/`user` role distinction any special treatment — a regular user's browser session is bound by `instant.perms.ts`'s rules regardless of their `type` value, since the web UI never needs admin-shaped access to any row, including its own user's.

## Additions on top of the live schema

Three things this redesign needs aren't live yet: read-position tracking, bookmarks, and a filename index. They follow the same conventions as the live schema (owner-chain `bind`/`allow` rules, `onDelete: 'cascade'` anchored at the top of each chain) and are already written into `instant.schema.ts`/`instant.perms.ts`, marked `proposed`.

### Read-position tracking is two new fields on `txt`, not a new table

The old `txt_access` table was keyed on `(txt_id, user_id)` because a shared file could have multiple readers, each with their own position. This redesign drops sharing (see [architecture.md](architecture.md)) — every `txt` row has exactly one possible reader, its owner — so the composite key collapses to two new optional fields directly on `txt`, `lastPartNum` and `lastAccessed`. No new link or permission rule is needed: `txt.allow.update` already reads `"isOwner && !('umk' in request.modifiedFields)"` — the owner may already write any field except `umk`, and these two are exactly that kind of field.

### `bookmarks`

No `update` rule — bookmarks are write-once-then-delete, same as the old table (there was never an `UPDATE bookmarks` in the old design either). The old 12-bookmarks-per-file cap was a SQL `BEFORE INSERT` trigger; InstantDB has no server-side triggers, so the cap becomes a **client-enforced invariant** instead: before inserting, the client queries the current bookmark count for that `txt` row and, if at or over 12, bundles a delete of the oldest bookmark into the same `db.transact` as the insert. This is a real behavior change worth being explicit about — the cap is no longer guaranteed by the database, only by the app's own code path. The risk is low: a user who bypasses their own client only ever over-stuffs their own bookmarks, and `isOwner` still prevents them from touching anyone else's. See [security.md](security.md).

### `metadataStore` — one aggregate filename index per user

Same rationale as the old `txt_metadata` table: rendering a file listing shouldn't require downloading and decrypting every `txt` row's own `$files` blob just to show a name. One row per user, `has: 'one'` both sides (same convention as `umkStoreOwner`), rewritten as a whole whenever a name is added or a file is deleted — not per-file. See [crypto.md](crypto.md)'s Filename Index section.

## Notes

### Uniqueness

`umkStoreOwner`'s current `has: 'one'`/`has: 'one'` shape (declared on both `umkStore`'s `owner` label and `$users`' reverse `umkStore` label) is a **deliberate retry** of a shape that previously produced a persistent "already exists" rejection on creating a `umkStore` row for a user — this happened even after confirming there were zero existing `umkStore` rows for that user, no leftover entities from earlier diagnostic renames of the link, and that the request was made with correct auth. The root cause was never conclusively identified. The fallback used at the time (and the one to reach for again if this rejection recurs) was to relax the reverse side to `has: 'many'` on `$users`, and add a client-side check in application code — `queryOwnUmkStoreRow` in `src/db.ts` — that treats getting back more than one row as a fatal error, since the schema itself no longer guarantees at most one. Under the current strict `has: 'one'`/`has: 'one'` shape, `queryOwnUmkStoreRow` gets a single row or `undefined` back, never an array, so that client-side "more than one is fatal" check has nothing left to do — the schema constraint is what's actually being trusted this time, not a fallback still quietly doing the work.

### `txtFileEntry`'s `has: 'one'`/`has: 'one'` is safe despite a transient unlinked moment

A `txt` row's `$files` row is created by a separate `db.storage.uploadFile` call *before* the `db.transact` that links it to that row — so for a moment after upload, before that transact runs, the file exists unlinked. `required: true` isn't set on `txtFileEntry` because it would reject that transient state. The link is still safe as `has: 'one'` on both sides because the eventual link (and the unlink of whatever file it's replacing, on an edit) happens inside one atomic `db.transact` — there is never an externally observable moment with zero or two files linked to a given `txt` row, only ever the single moment right after upload where a *new, not-yet-linked* file exists on its own. See [crypto.md](crypto.md)'s Entry Data File section for how this same atomicity is what makes version history safe to store this way. `bookmarkFileEntry` and `metadataFileEntry` (proposed) are the same shape for the same reason.

### `onDelete: 'cascade'`/`required: true` sit on the dependent side, not the anchor

Across every link in `instant.schema.ts`, the side that should disappear when the other side is deleted is the one carrying `onDelete: 'cascade'` (and, where the link can't exist meaningfully without its anchor, `required: true` too) — e.g. `txtUmkStore` puts both on `txt` (deleted when its `umkStore` is deleted), not on `umkStore`. The two proposed additions follow the same rule: `umkStoreMetadata` puts both on `metadataStore` (deleted when its `umkStore` is deleted), and `txtBookmarks` puts both on `bookmarks` (deleted when its `txt` row is deleted) — in each case the anchor side carries neither flag. Getting this backwards silently inverts which entity survives a deletion, so it's worth checking explicitly against an existing link rather than guessing when adding a new one.
