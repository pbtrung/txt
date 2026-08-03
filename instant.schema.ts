// Schema for the InstantDB + Firebase Auth + R2 design documented in
// docs/data_model.md. Not wired into any running code yet. Verify against a
// real `npx instant-cli@latest push schema` before treating this as final;
// the API shape here is synthesized from InstantDB's own docs, not exercised
// against a live schema.

import { i } from "@instantdb/core";

const _schema = i.schema({
  entities: {
    // $users is InstantDB's own built-in auth entity, but custom attributes
    // on it are allowed like any other -- there's no separate app-level
    // profile entity in this design, so $users is also the one thing every
    // other entity's owner/user link points at directly. Never
    // readable/writable except by isSelf/isAdmin (instant.perms.ts).
    $users: i.entity({
      email: i.string().unique().indexed(),
      // base64, 128 random bytes, generated once per account and wrapped
      // (crypto.md's Blob format) under user_root_key (an external secret
      // from creds.json, never stored in InstantDB). Encrypts this account's
      // own credStore row(s) -- see credStore below. A leaked query result
      // still can't be unwrapped without the external user_root_key.
      umk: i.string().optional(),
      // 'admin' | 'user' -- the permission system's role switch. Only ever
      // admin-writable (instant.perms.ts's $users.update: "isAdmin", no
      // isSelf branch at all), so self-promotion isn't possible through the
      // normal write path.
      type: i.string().optional(),
    }),
    // The encrypted key-material store (docs/data_model.md's credStore
    // entity). One row per (owner, subject) pair -- a single owner can hold
    // multiple rows (see the owner/user links below). content is a
    // Blob-wrapped (crypto.md format) JSON string, encrypted under the
    // owner's own $users.umk.
    credStore: i.entity({
      content: i.string(),
    }),
    // Table of contents for this user's own SQLCipher-encrypted SQLite
    // database, paged remotely via the vendored sqlcipher.wasm + js-vfs.mjs
    // VFS -- pageSize matches that database's own page size (PRAGMA
    // cipher_page_size). The actual app schema (txt/txt_parts/txt_bookmarks,
    // see data_model.md) lives entirely inside that SQLCipher file; none of
    // it is ever visible to InstantDB.
    dbMeta: i.entity({
      currentVersion: i.number().indexed(),
      pageCount: i.number(),
      pageSize: i.number(),
      needsGc: i.boolean(),
    }),
    // One row per (owner, page_no, version) triple of the SQLCipher database
    // above -- a page here is a literal SQLite/SQLCipher page, not an
    // arbitrary document chunk.
    pages: i.entity({
      pageKey: i.string().unique().indexed(), // `${ownerId}:${pageNo}:${version}`
      pageNo: i.number().indexed(),
      version: i.number().indexed(),
      // This page-version's real R2 object key, encrypted and stored
      // directly as base64: base64(Blob(raw_key; IKM = path_key)). The real
      // object address is `${r2Prefix}/${raw_key}`, where r2Prefix is a pure
      // function of the owning account's auth.id and is never itself
      // encrypted or stored (see data_model.md's pages entity).
      path: i.string(),
    }),
    activeReaders: i.entity({
      snapshotVersion: i.number(),
      leaseExpiresAt: i.number().indexed(), // indexed: GC sweeps expired leases by this
    }),
  },
  links: {
    // Every owner/user link below targets $users directly -- auth.id already
    // equals a $users row's own id, so instant.perms.ts's isOwner checks are
    // a single-hop data.ref('owner.id'), never a two-hop traversal through an
    // intermediate profile row. `on`, not `data`, is what's authoritative
    // here: onDelete goes on whichever side of a link has `has: "one"` (the
    // only cardinality it's valid on) and fires when the *other* side's
    // entity is deleted -- so deleting a $users row cascades directly to
    // every dbMeta/pages/activeReaders/credStore row it owns, in one step
    // each, no intermediate entity to cascade through first.
    dbMetaOwner: {
      forward: {
        on: "dbMeta",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "one", label: "dbMeta" },
    },
    pagesOwner: {
      forward: { on: "pages", has: "one", label: "owner", onDelete: "cascade" },
      reverse: { on: "$users", has: "many", label: "pages" },
    },
    activeReadersOwner: {
      forward: {
        on: "activeReaders",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "activeReaders" },
    },
    // Whoever's umk encrypts this row's content -- deleting that account
    // cascades away every row it owns.
    credStoreOwner: {
      forward: {
        on: "credStore",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "credStoreAsOwner" },
    },
    // Which account's key material this row actually describes -- left
    // unlinked when a row describes its own owner (docs/data_model.md's
    // credStore entity). Deleting the described account cascades away rows
    // about it too, even ones owned by someone else (e.g. an admin-held copy
    // of a since-deleted user's keys).
    credStoreUser: {
      forward: {
        on: "credStore",
        has: "one",
        label: "user",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "credStoreAsUser" },
    },
  },
});

export default _schema;
