// Schema for the InstantDB + Firebase Auth + R2 design documented in
// docs/data_model.md. Not wired into any running code yet. Verify against a
// real `npx instant-cli@latest push schema` before treating this as final;
// the API shape here is synthesized from InstantDB's own docs, not exercised
// against a live schema.

import { i } from "@instantdb/core";

const _schema = i.schema({
  entities: {
    // $files rows can only ever be created via db.storage.uploadFile(path,
    // file) -- never via transact() (instantdb.com/docs/storage#link-files).
    // path = "${auth.id}:" + a path_key-encrypted raw_path (crockford base32
    // of 32 random bytes, crypto.md's Blob format, base64url-encoded) --
    // NOT the same value as pages.pageKey below (that one stays plaintext,
    // for pages' own composite-uniqueness constraint; this one is random and
    // encrypted, since it doubles as this page-version's real R2 object key
    // in the user's own bucket). The auth.id prefix stays plaintext
    // deliberately: instant.perms.ts checks it via string-prefix, since no
    // link to any other entity exists yet at upload time to ref-traverse
    // instead. Uploaded file *content* is a trivial placeholder -- the real
    // page bytes (already SQLCipher/Ascon-Keccak-encrypted under db_key at
    // the SQLite page level) live directly in R2, never in InstantDB;
    // "InstantDB only ever holds client-encrypted paths" (data_model.md).
    $files: i.entity({
      path: i.string().unique().indexed(),
    }),
    // umk/creds carry this account's whole key hierarchy on the auth entity
    // itself (docs/data_model.md's Key Hierarchy) -- InstantDB's own
    // built-in entity, but custom attributes on it are allowed like any
    // other. Neither is ever readable/writable except by isSelf/isAdmin
    // (instant.perms.ts) -- a leaked query result still can't be unwrapped
    // without the external user_root_key (never stored here).
    $users: i.entity({
      email: i.string().unique().indexed(),
      // base64, 128 random bytes, generated once per account and wrapped
      // (crypto.md's Blob format) under user_root_key (an external secret
      // from creds.json, never stored in InstantDB).
      umk: i.string().optional(),
      // base64, itself a Blob-wrapped JSON payload under umk -- shape
      // differs by role (admin: r2_config + path_key + db_key; user: same
      // minus any R2 access key, since a user session gets R2 access only
      // via a short-lived prefix-scoped temporary credential, never a
      // stored one) -- see data_model.md's $users bullet and "Non-admin
      // (user-role) accounts" section.
      creds: i.string().optional(),
    }),
    users: i.entity({
      type: i.string(), // 'admin' | 'user'
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
    }),
    activeReaders: i.entity({
      snapshotVersion: i.number(),
      leaseExpiresAt: i.number().indexed(), // indexed: GC sweeps expired leases by this
    }),
  },
  links: {
    // Cascade chain rooted at $users: deleting the auth identity deletes its
    // users profile (below), which in turn deletes everything that profile
    // owns (dbMetaOwner/pagesOwner/filesOwner/activeReadersOwner) -- one
    // delete cleans up the whole account's InstantDB-side footprint. `on`,
    // not `data`, is what's authoritative here: onDelete goes on whichever
    // side of a link has `has: "one"` (the only cardinality it's valid on)
    // and fires when the *other* side's entity is deleted.
    usersAuth: {
      forward: {
        on: "users",
        has: "one",
        label: "authUser",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "one", label: "profile" },
    },
    dbMetaOwner: {
      forward: {
        on: "dbMeta",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "users", has: "one", label: "dbMeta" },
    },
    pagesOwner: {
      forward: { on: "pages", has: "one", label: "owner", onDelete: "cascade" },
      reverse: { on: "users", has: "many", label: "pages" },
    },
    // Deliberately NOT cascaded: garbage collection (data_model.md) deletes
    // `pages` and `$files` as two explicit, separately-ordered steps
    // (pages first, then $files + its R2 object), specifically so a crash
    // mid-GC can never leave a pages row pointing at an already-deleted
    // $files row. An automatic cascade here would collapse that ordering
    // back into one implicit step and still wouldn't clean up the R2 object
    // (cascade only ever touches InstantDB rows) -- GC needs to keep doing
    // this explicitly either way.
    pagesPointer: {
      forward: { on: "pages", has: "one", label: "pointerFile" },
      reverse: { on: "$files", has: "one", label: "page" },
    },
    filesOwner: {
      forward: {
        on: "$files",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "users", has: "many", label: "files" },
    },
    activeReadersOwner: {
      forward: {
        on: "activeReaders",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "users", has: "many", label: "activeReaders" },
    },
  },
});

export default _schema;
