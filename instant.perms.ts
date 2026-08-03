// Permission rules for the InstantDB + Firebase Auth + R2 design documented
// in docs/data_model.md. Verify against a real InstantDB app via
// `npx instant-cli@latest push perms` before treating this as final.
//
// There's no separate app-level profile entity in this design -- type lives
// directly on $users, and every other entity's owner/user link points at
// $users directly. auth.id already equals a $users row's own id, so every
// isOwner check below is a single-hop data.ref('owner.id'), not a two-hop
// ref through an intermediate profile row.
//
// $users.type 'admin' can act on any user's data; 'user' can only read/write
// its own -- every rule below is `isAdmin || isOwner` (or admin-only where
// noted). isAdmin reads auth's own $users row's type directly via
// auth.ref('$user.type') -- UNVERIFIED whether this resolves a plain,
// non-linked attribute the same way auth.ref/data.ref resolve one reached
// across a real link (a prior design routed type through a separate profile
// entity specifically so this never had to be answered -- confirmed there,
// on 2026-08-01, that `auth.ref(...)`/`data.ref(...)` return a list even
// across a "has one" link, so isAdmin has to be list membership
// (`'admin' in auth.ref(...)`), not equality -- an initial
// `auth.ref(...) == 'admin'` draft failed the server-side CEL type check
// with "found no matching overload for '_==_' applied to '(list(dyn),
// string)'" on every single rule; that finding should still hold here, but
// re-confirm against a real push before relying on it for this collapsed
// shape).
//
// $users is InstantDB's own auth-managed entity, but it now carries two
// custom attributes -- umk and type (docs/data_model.md's Key Hierarchy) --
// alongside the system-managed ones -- see its own rules below.
//
// Also confirmed via push (2026-08-01): $users.allow.delete must be the
// literal "false", not a CEL expression -- InstantDB's push API rejects
// anything else with "The $users namespace doesn't support permissions for
// delete."

const ADMIN_BIND = ["isAdmin", "'admin' in auth.ref('$user.type')"];

const rules = {
  $users: {
    // isSelf is a direct id comparison here, not a ref traversal like every
    // other entity in this file -- $users *is* the auth identity, so
    // auth.id already equals this row's own id. view lets a session read
    // and locally decrypt its own umk (and see its own type) after unlock;
    // update is admin-only, since setting/rotating umk or type is a
    // provisioning action (AdminInitializer-equivalent), never a regular
    // user self-service write -- there's no isSelf branch on update at all,
    // which alone is what keeps a plain user from self-promoting to admin.
    //
    // create: "isAdmin" (not unconditional "true") -- confirmed working
    // against a real InstantDB app: every account's $users row is always
    // created via the Admin SDK first (adminInit.ts's provisionAuthUser,
    // using db.auth.createToken/verifyToken -- like all Admin SDK calls,
    // this bypasses instant.perms.ts entirely, InstantDB's own backend docs:
    // "Permission checks will not run for queries and writes from our admin
    // API"), *before* the real Firebase sign-in ever happens. That live
    // sign-in's own oauth/id_token exchange then only ever resolves that
    // already-existing row by email -- it never attempts to create one, and
    // resolving an existing row doesn't evaluate the create rule at all. So
    // as long as an account is always provisioned this way first (this
    // design's Provisioning section assumes exactly that, admin included),
    // create's value only matters for a stray sign-in attempt against an
    // email nobody provisioned, which isAdmin correctly rejects.
    //
    // A prior version of this design routed $users row creation through
    // that live oauth/id_token exchange itself instead (no Admin SDK
    // pre-creation step), which genuinely did deadlock under create:
    // "isAdmin" -- confirmed against a real sign-in attempt back then,
    // InstantDB enforces the create rule for its own internal $users row
    // creation during that exchange (not exempted for platform-internal
    // writes, as had been assumed), and there's no way to satisfy isAdmin
    // before any users row exists to admin-promote. create: "true" was the
    // fix at the time; provisioning the row via the Admin SDK first removes
    // the need for that unconditional escape hatch entirely.
    bind: [...ADMIN_BIND, "isSelf", "auth.id == data.id"],
    allow: {
      view: "isAdmin || isSelf",
      create: "isAdmin",
      update: "isAdmin",
      // $users doesn't support a delete permission at all -- InstantDB's own
      // push API rejects anything but the literal "false" here (confirmed:
      // "The $users namespace doesn't support permissions for delete. Set
      // `$users.allow.delete` to `false`."). Deleting the auth entity itself
      // isn't something this app's rules can gate either way.
      delete: "false",
    },
  },
  dbMeta: {
    bind: [...ADMIN_BIND, "isOwner", "auth.id in data.ref('owner.id')"],
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
    bind: [...ADMIN_BIND, "isOwner", "auth.id in data.ref('owner.id')"],
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
    bind: [...ADMIN_BIND, "isOwner", "auth.id in data.ref('owner.id')"],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  activeReaders: {
    bind: [...ADMIN_BIND, "isOwner", "auth.id in data.ref('owner.id')"],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin || isOwner",
      update: "isAdmin || isOwner", // renewing the lease
      delete: "isAdmin || isOwner", // clean close releases it early
    },
  },
};

export default rules;
