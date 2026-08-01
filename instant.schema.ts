// Schema for the InstantDB + Firebase Auth + R2 design documented in
// docs/data_model.md. Not wired into any running code yet. Verify against a
// real `npx instant-cli@latest push schema` before treating this as final;
// the API shape here is synthesized from InstantDB's own docs, not exercised
// against a live schema.

import { i } from "@instantdb/core";

const _schema = i.schema({
  entities: {
    // Confirmed: url/the storage-upload API aren't used at all here -- path
    // is a plain attribute holding the encrypted pointer blob directly, set
    // and read like any other field via transact()/queries.
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
    // Direct owner link, separate from the pages->$files link above: keeps
    // $files' permission rules from depending on operation ordering within
    // the single multi-op transact() that creates $files, pages, and bumps
    // dbMeta together (docs/data_model.md's commit protocol) -- $files can
    // prove ownership on its own, regardless of when the pages link lands.
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
