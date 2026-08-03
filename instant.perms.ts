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
// $users is InstantDB's own auth-managed entity, but it now carries a custom
// umk attribute (docs/data_model.md's Key Hierarchy) alongside the
// system-managed ones -- see its own rules below.
//
// Also confirmed via push (2026-08-01): $users.allow.delete must be the
// literal "false", not a CEL expression -- InstantDB's push API rejects
// anything else with "The $users namespace doesn't support permissions for
// delete."

const ADMIN_BIND = ["isAdmin", "'admin' in auth.ref('$user.profile.type')"];

const rules = {
  $users: {
    // isSelf is a direct id comparison here, not a ref traversal like every
    // other entity in this file -- $users *is* the auth identity, so
    // auth.id already equals this row's own id. view lets a session read
    // and locally decrypt its own umk after unlock; update is admin-only,
    // since setting/rotating umk is a provisioning action
    // (AdminInitializer-equivalent), never a regular user self-service
    // write.
    //
    // create MUST be unconditional ("true"), confirmed against a real
    // sign-in attempt: InstantDB enforces this rule for its own internal
    // $users row creation during the oauth/id_token exchange (not
    // exempted for platform-internal writes as assumed), and the row
    // doesn't exist yet at that point -- so create: "isAdmin" made every
    // first-time sign-in fail ("Permission denied"), including the very
    // first admin's own, a bootstrap deadlock (no $users row -> no users
    // row -> never isAdmin -> can never create the $users row). Firebase's
    // own token verification is the real gate on who can trigger this in
    // the first place; umk itself stays protected by update: isAdmin
    // regardless of how permissive create is.
    bind: [...ADMIN_BIND, "isSelf", "auth.id == data.id"],
    allow: {
      view: "isAdmin || isSelf",
      create: "true",
      update: "isAdmin",
      // $users doesn't support a delete permission at all -- InstantDB's own
      // push API rejects anything but the literal "false" here (confirmed:
      // "The $users namespace doesn't support permissions for delete. Set
      // `$users.allow.delete` to `false`."). Deleting the auth entity itself
      // isn't something this app's rules can gate either way.
      delete: "false",
    },
  },
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
    bind: [
      ...ADMIN_BIND,
      "isOwner",
      "auth.id in data.ref('owner.authUser.id')",
    ],
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
    bind: [
      ...ADMIN_BIND,
      "isOwner",
      "auth.id in data.ref('owner.authUser.id')",
    ],
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
  credStore: {
    // isOwner here is whoever's umk encrypts this row's content (the owner
    // link, docs/data_model.md's credStore entity) -- not the `user` link,
    // which only says which account's key material the row describes and
    // has no bearing on who can decrypt or should be allowed to view it.
    // view lets an owner read and locally decrypt their own row(s); create/
    // update/delete are admin-only, same rationale as $users.umk above --
    // provisioning/rotating key material is a provisioning action, never a
    // regular user self-service write.
    bind: [
      ...ADMIN_BIND,
      "isOwner",
      "auth.id in data.ref('owner.authUser.id')",
    ],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  activeReaders: {
    bind: [
      ...ADMIN_BIND,
      "isOwner",
      "auth.id in data.ref('owner.authUser.id')",
    ],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin || isOwner",
      update: "isAdmin || isOwner", // renewing the lease
      delete: "isAdmin || isOwner", // clean close releases it early
    },
  },
};

export default rules;
