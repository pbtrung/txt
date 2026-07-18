# Architecture

## Overview

`txt` is a fully client-side-encrypted text vault. There is one database — InstantDB — and one storage tier — Cloudflare R2, accessed exclusively through InstantDB's built-in Storage feature — but the two components that talk to them have very different privileges now:

- **Admin CLI** — the only place administrative operations happen: create/list/delete users, and ingest/delete entries on any user's behalf. It authenticates against InstantDB with the **admin** SDK (`@instantdb/admin`), which bypasses `instant.perms.ts` entirely, and against Firebase with the Firebase Admin SDK. Regular users never run it and never see its config.
- **Web UI (`ui/`)** — a browser app that connects to InstantDB directly (`@instantdb/react`), constrained entirely by `instant.perms.ts`'s owner-only rules. It lets a logged-in user browse, search, read, bookmark, and track read-position on their own entries — all encryption/decryption still happening client-side. InstantDB and R2 only ever see ciphertext.

There is still no bespoke application server mediating access — but "no server" now means something more precise than it used to: Firebase (identity) and InstantDB (data + permissions) are both managed third-party services the browser talks to directly, the same category of thing Turso was before; this project still doesn't run or host a server of its own. See [tech_stack.md](tech_stack.md) for the credentials/config shape and for what to watch for with InstantDB, and [security.md](security.md) for the resulting threat model — which is meaningfully different from before, since InstantDB's permission rules now provide real per-row access control at the database layer, not just at the crypto layer.

## Components

```
cli/                     admin CLI (Node/TypeScript)
  index.ts               command definitions (users, entries)
  instantAdmin.ts         @instantdb/admin client, all admin-privileged operations
  firebaseAdmin.ts        firebase-admin client, account creation/lookup
  crypto.ts               all cryptographic operations (see crypto.md)
  keyring.ts              loads/writes the local config's user_root_keys keyring
  downloader.ts           decrypt + export to plaintext .txt files

ui/
  src/                    React app; @instantdb/react + Firebase client SDK +
                          leancrypto-wasm for client-side DB access, auth, and
                          decryption
```

`txt.py`/`txt/` (Python) is retired along with Turso — InstantDB's admin SDK is JS/TS-only, so the CLI moves to Node/TypeScript. See [tech_stack.md](tech_stack.md).

## Ingest pipeline (Admin CLI)

```
for each .txt file under --src, ingesting on behalf of a given user:
  1. Look up that user's user_root_key in the CLI's local keyring; unwrap
     their umk (see data_model.md's Key Hierarchy).
  2. Fetch and decrypt that user's metadataStore content file to check for
     an existing entry by filename (direct dictionary lookup, scoped to
     that user's own entries -- there's no shared-to-them case anymore).
  3. No match  → generate a fresh txtKeyBlob key, wrap it under this
     user's umk, CREATE a new txt row (via the InstantDB admin SDK,
     linked to their umkStore via txtUmkStore).
     Match, no --force → skip.
     Match + --force   → reuse the existing txt row and its txtKeyBlob.
  4. Preprocess (normalise paragraph spacing).
  5. Brotli-compress + AEAD-encrypt the file's content, keyed off this
     entry's txtKeyBlob; db.storage.uploadFile it, then atomically link it
     via txtPartFile (see data_model.md's note on this link) -- on
     --force, the prior content is appended to that file's history rather
     than discarded.
  6. Add/refresh this entry's name in the user's metadataStore content.
  7. Re-encrypt the whole metadata index and swap it into the user's
     metadataStore via txtMetadataFile once per ingest run (not once per
     file — see data_model.md), the same atomic upload-then-relink
     db.transact as step 5.
```

Since the admin CLI uses the InstantDB admin SDK, every write above bypasses `instant.perms.ts` — it is trusted to only ever touch the user it's ingesting on behalf of, same trust assumption the old CLI had with `root_master_key`.

## Read pipeline (Web UI)

```
1. User completes Firebase login, then (first time on this browser/device
   only) imports the admin-delivered { instant_token, user_root_key }
   bundle; see the Provisioning pipeline below.
2. UI calls db.auth.signInWithToken(instant_token); from then on every
   query/write is scoped by instant.perms.ts's isOwner rules -- the browser
   physically cannot fetch another user's rows, regardless of what it can
   decrypt.
3. UI unwraps this user's umk (user_root_key, from local storage), then
   fetches and decrypts their metadataStore's linked content file to get
   their entryId → name map.
4. Opening an entry: unwrap its txtKeyBlob via the owning umk, fetch its
   linked $files row's content (via txtPartFile), decrypt + brotli-decompress
   to get { name, current, history }.
5. Read-position: fetch that entry's linked txtAccess row (if any) and its
   own linked $files content (via txtAccessFileEntry), decrypt it the same
   way, keyed off the same txtKeyBlob. Advancing it is an upload-then-relink
   db.transact, same shape as step 4 -- not a plain field write, since
   read-position is blob-encrypted too, not a bare number on the txt row.
6. Bookmarks are the same shape as read-position (a linked $files row off
   the owning txt row via bookmarkFileEntry, keyed off txtKeyBlob) -- just
   many per txt row instead of one.
```

## Provisioning pipeline (Admin CLI)

Replaces the old Share pipeline — this redesign drops cross-user sharing entirely (see Role model below and [security.md](security.md)); there is nothing to grant or revoke between two regular users anymore.

```
txt-admin users create --email <user>     # provision a new user
txt-admin users delete --email <user>     # deprovision
```

```
Create:
  1. Create a Firebase account for the user.
  2. Generate umk + user_root_key; CREATE umkStore + $users (type: "user")
     + an empty metadataStore, via the InstantDB admin SDK.
  3. Mint an InstantDB token (admin_auth.createToken(email)).
  4. Add user_root_key to the CLI config's keyring.
  5. Deliver { instant_token, user_root_key } to the user once, out-of-band.

Delete:
  1. DELETE the $users row via the admin SDK.
  2. onDelete: 'cascade' wipes umkStore -> txt/metadataStore -> $files/bookmarks
     (and their own linked $files) in one operation.
  3. Remove the user's entry from the CLI config's keyring.
```

See [security.md](security.md) for what deleting a user does and does not guarantee (in particular: whether an already-issued `instant_token` can be invalidated short of deleting the user is currently unverified/TBD, not asserted here).

## Role model

- **admin** (`$users.type === "admin"`) — CLI-only. Never logs into the web UI, never holds an `instant_token`/`user_root_key` bundle the way a regular user does. Full CRUD over `$users` and `txt` via the InstantDB admin SDK, which bypasses `instant.perms.ts` entirely — same trust tier as holding `root_master_key` before, just relabeled and now scoped to whoever runs the CLI rather than whoever has `creds.json`.
- **user** (`$users.type === "user"`) — web-UI-only, no CLI access at all. Every query and write goes through `instant.perms.ts`'s owner-only rules. Can read/search/decrypt their own entries, update their own read-position, and CRUD their own bookmarks — nothing else. This is a real, DB-enforced boundary, not just an application-layer filter: see [security.md](security.md)'s InstantDB access model section for why that's a genuine improvement over the old single-shared-Turso-token model.

There is no third role and no cross-user sharing in this redesign — an admin who wants to hand a user a specific file's content has no in-band mechanism to do so; they would have to ingest a fresh copy on that user's behalf via the Ingest pipeline above, same as any other file.
