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
    // path is set to the same value as pages.pageKey below and is a plain
    // routing key, not secret: the actual AEAD pointer blob (crypto.md's blob
    // format) is the *uploaded file content*, not this attribute. Because no
    // link to any other entity exists yet at upload time, instant.perms.ts
    // can't gate `create`/`view` by ref traversal (the filesOwner-style
    // direct-link trick doesn't apply here) -- it checks this path's prefix
    // against auth.id instead.
    $files: i.entity({
      path: i.string().unique().indexed(),
    }),
    $users: i.entity({
      email: i.string().unique().indexed(),
    }),
    users: i.entity({
      type: i.string(), // 'admin' | 'user'
    }),
    dbMeta: i.entity({
      currentVersion: i.number().indexed(),
      pageCount: i.number(),
      pageSize: i.number(),
      needsGc: i.boolean(),
    }),
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
    usersAuth: {
      forward: { on: "users", has: "one", label: "authUser" },
      reverse: { on: "$users", has: "one", label: "profile" },
    },
    dbMetaOwner: {
      forward: { on: "dbMeta", has: "one", label: "owner" },
      reverse: { on: "users", has: "one", label: "dbMeta" },
    },
    pagesOwner: {
      forward: { on: "pages", has: "one", label: "owner" },
      reverse: { on: "users", has: "many", label: "pages" },
    },
    pagesPointer: {
      forward: { on: "pages", has: "one", label: "pointerFile" },
      reverse: { on: "$files", has: "one", label: "page" },
    },
    filesOwner: {
      forward: { on: "$files", has: "one", label: "owner" },
      reverse: { on: "users", has: "many", label: "files" },
    },
    activeReadersOwner: {
      forward: { on: "activeReaders", has: "one", label: "owner" },
      reverse: { on: "users", has: "many", label: "activeReaders" },
    },
  },
});

export default _schema;
