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
    // create MUST be unconditional ("true"), confirmed against a real
    // end-to-end run of --init-admin (2026-08-03) -- and confirmed to still
    // be necessary even with this account's $users row pre-created via the
    // Admin SDK first (adminInit.ts's provisionAuthUser, using
    // db.auth.createToken/verifyToken -- which, like all Admin SDK calls,
    // bypasses instant.perms.ts entirely) and already carrying type: "admin"
    // by the time the real Firebase sign-in happens: create: "isAdmin" still
    // made that live sign-in's oauth/id_token exchange fail ("Permission
    // denied: not perms-pass?"), row already existing or not. So this isn't
    // only about the row not existing yet -- auth apparently isn't (fully)
    // bound for self-referential CEL checks (isSelf's auth.id == data.id,
    // isAdmin's auth.ref('$user.type')) during this specific internal
    // operation at all, existing row or not. Firebase's own token
    // verification is the real gate on who can trigger this in the first
    // place; umk/type themselves stay protected by update: isAdmin
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
