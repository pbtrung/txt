// Permission rules for the InstantDB + Firebase Auth + R2 design documented
// in docs/data_model.md. Verified against a real InstantDB app via
// `npx instant-cli@latest push perms` (2026-08-01): `auth.ref(...)`, like
// `data.ref(...)`, returns a list even across a "has one" link, so the
// isAdmin check has to be list membership (`'admin' in auth.ref(...)`), not
// equality -- an initial `auth.ref(...) == 'admin'` draft failed the
// server-side CEL type check with "found no matching overload for '_==_'
// applied to '(list(dyn), string)'" on every single rule. Confirmed push
// succeeds with the membership form below.
//
// users.type 'admin' can act on any user's data; 'user' can only read/write
// its own -- every rule below is `isAdmin || isOwner` (or admin-only where
// noted). isAdmin traverses auth -> $users.profile (the reverse of this
// schema's usersAuth link) -> users.type.
//
// $users has no rules here -- it's InstantDB's own auth-managed entity, not
// something this app writes to directly.

const ADMIN_BIND = ["isAdmin", "'admin' in auth.ref('$user.profile.type')"];

const rules = {
  users: {
    bind: [...ADMIN_BIND, "isSelf", "auth.id in data.ref('authUser.id')"],
    allow: {
      view: "isAdmin || isSelf",
      create: "isAdmin", // provisioning a new profile row is an admin/server-side action
      // isSelf can update its own row EXCEPT the type field -- otherwise a
      // plain user could self-promote to admin by writing type: 'admin'.
      update: "isAdmin || (isSelf && !('type' in request.modifiedFields))",
      delete: "isAdmin",
    },
  },
  dbMeta: {
    bind: [...ADMIN_BIND, "isOwner", "auth.id in data.ref('owner.authUser.id')"],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin || isOwner",
      // The CAS: a concurrent writer that already advanced currentVersion
      // makes this whole transact() fail, since the rule evaluates against
      // the record's state at commit time (see data_model.md's commit
      // protocol -- unverified whether transact() is truly serializable
      // per-record, confirm before relying on this for real). Admin bypasses
      // the version-match check entirely -- a deliberate escape hatch for
      // manual repair, not something a normal commit path should ever need.
      update:
        "isAdmin || (isOwner && newData.currentVersion == data.currentVersion + 1)",
      delete: "isAdmin",
    },
  },
  pages: {
    bind: [...ADMIN_BIND, "isOwner", "auth.id in data.ref('owner.authUser.id')"],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin || isOwner",
      // Append-only MVCC: an ordinary owner never updates/deletes a page row
      // (new versions are new rows) -- isAdmin is a deliberate override of
      // that invariant for support/repair, not part of the normal write path.
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  "$files": {
    // $files rows are only ever created via db.storage.uploadFile(path, ...)
    // (instantdb.com/docs/storage#link-files), which happens before any link
    // to another entity exists -- so ownership can't be a ref traversal here
    // the way it is for every other entity in this file. path is always
    // "${auth.id}:${pageNo}:${version}" (docs/data_model.md's commit
    // protocol, same value as pages.pageKey), so ownership is checked by
    // string prefix instead. isOwnPath covers both create (governs the
    // upload itself) and view (must hold both before and after the file
    // gets linked to its pages row, so it can't switch to a ref-based check
    // post-link).
    bind: [...ADMIN_BIND, "isOwnPath", "data.path.startsWith(auth.id + ':')"],
    allow: {
      view: "isAdmin || isOwnPath",
      create: "isAdmin || isOwnPath",
      update: "isAdmin",
      delete: "isAdmin", // ordinary GC still goes through the Admin SDK, bypassing rules entirely
    },
  },
  activeReaders: {
    bind: [...ADMIN_BIND, "isOwner", "auth.id in data.ref('owner.authUser.id')"],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin || isOwner",
      update: "isAdmin || isOwner", // renewing the lease
      delete: "isAdmin || isOwner", // clean close releases it early
    },
  },
};

export default rules;
