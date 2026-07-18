# Tech Stack

## Admin CLI (`cli/`)

| Component | Choice | Notes |
|-----------|--------|-------|
| Language | Node.js / TypeScript | Moved off Python: InstantDB's admin SDK (`@instantdb/admin`) is JS/TS-only, and the CLI is the only place that needs admin-privileged InstantDB access. |
| DB access | `@instantdb/admin`, connecting directly to InstantDB's cloud API | Bypasses `instant.perms.ts` entirely — every operation (create/delete user, ingest/delete entry) is a live admin-privileged call. |
| Auth (identity) | `firebase-admin` | Creates/looks up Firebase accounts at user-provisioning time; never used for ongoing per-request auth (see architecture.md's Provisioning pipeline). |
| Storage | InstantDB Storage (`db.storage.uploadFile`/`.delete`), backed by Cloudflare R2 | The CLI never holds R2 credentials directly — R2 is InstantDB's storage provider, not something this app talks to itself. |
| Compression | `brotli` | Unchanged from before; applied before encryption. |
| Crypto | `leancrypto`, via ctypes/native bindings or an N-API wrapper | Unchanged algorithm choices; binding mechanism TBD now that the CLI is Node instead of Python — not yet settled, flagged here rather than assumed. |
| CLI parsing | TBD (e.g. `commander`) | Replaces `click`; not yet chosen. |

## Web UI (`ui/`)

| Component | Choice | Notes |
|-----------|--------|-------|
| Framework | React + Bootstrap | Unchanged. |
| Build tool | Vite | Unchanged. |
| DB access | `@instantdb/react`, connecting directly from the browser | No application server, no local file. Every query/write is scoped by `instant.perms.ts`'s owner-only rules — the browser can only ever see and touch its own signed-in user's rows, a real change from the old single-shared-full-access-token model (see security.md). |
| Auth (identity) | Firebase client SDK, plus a one-time import of the admin-delivered `{ instant_token, user_root_key }` bundle | See crypto.md's User Identity, Login, and Provisioning section for the full bootstrap flow and why Firebase login isn't the thing that's actually authorizing ongoing InstantDB access. |
| Storage | InstantDB Storage, backed by Cloudflare R2 | Entry content + history download as a single file per entry (see crypto.md's Entry Data File section) — no more per-part rows. |
| Crypto | `leancrypto` compiled to WebAssembly | Unchanged — decryption still happens entirely client-side. |

## Things to guard against with InstantDB — flagged proactively, not yet hit

Unlike the two `libsql` client bugs the old stack actually ran into (kept here for reference below), nothing InstantDB-specific has caused a real incident in this project yet. These are worth building defenses for anyway, since they're the kind of thing this project has been burned by before with a new client library:

1. **Schema/perms drift between the dashboard and the checked-in files.** `instant.schema.ts`/`instant.perms.ts` are pulled from the live app, not hand-authored (see data_model.md) — a manual dashboard change that isn't re-pulled will silently diverge from what's checked in. Re-run `npx instant-cli@latest pull schema`/`pull perms` after any dashboard-side edit, and treat an unpulled dashboard change as a bug waiting to happen, not a convenience.
2. **`has: 'one'`/`has: 'one'` link uniqueness rejections.** See data_model.md's Uniqueness note — this exact shape has already produced a spurious "already exists" rejection once on `umkStoreOwner`, root cause never conclusively identified. The documented fallback (relax to `has: 'many'` on one side, add a client-side "more than one row is fatal" check) is worth keeping in mind for any *new* 1:1 link this redesign adds, not just the ones that already hit it.

### Superseded: the two `libsql`-specific bugs from the Turso design

No longer applicable now that the DB layer is InstantDB, kept for history since they were real incidents in this project: a single Turso connection/stream could be invalidated mid-run on long operations ("Hrana stream expiry"), and the installed `libsql` Python client's `Cursor` wasn't iterable (`for row in cursor` failed; needed an explicit `fetchone()`/`fetchall()` loop instead).
