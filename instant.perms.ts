// Permission rules for the InstantDB + Firebase Auth + R2 design documented
// across docs/data_model.md (entities, this file's own Permission rules
// table), docs/key_hierarchy.md, docs/protocols.md, docs/r2_credentials.md,
// and docs/auth.md. Verify against a real InstantDB app via
// `npx instant-cli@latest push perms` before treating this as final.
//
// There's no separate app-level profile entity in this design -- type lives
// directly on $users, and every other entity's owner/forUser/fromUser/toUser
// link points at $users directly. auth.id already equals a $users row's own
// id, so every isOwner check below is a single-hop data.ref('owner.id'), not
// a two-hop ref through an intermediate profile row -- the one exception is
// isSharedReader on txtParts/txtMetadata, a genuine two-hop
// data.ref('txt.txtShares.toUser.id'), since a share grants access to a
// document, not to its individual parts or metadata row (docs/data_model.md's
// Permission rules).
//
// $users.type 'admin' can act on any user's data; 'user' can only read/write
// its own (or, for txt/txtMetadata/txtParts, read-only what's been shared to
// it) -- see docs/data_model.md's Permission rules table for the exact rule
// per entity. isAdmin reads auth's own $users row's type directly via
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
// custom attributes -- umk and type (docs/key_hierarchy.md) -- alongside the
// system-managed ones -- see its own rules below.
//
// Also confirmed via push (2026-08-01): $users.allow.delete must be the
// literal "false", not a CEL expression -- InstantDB's push API rejects
// anything else with "The $users namespace doesn't support permissions for
// delete."

const ADMIN_BIND = ["isAdmin", "'admin' in auth.ref('$user.type')"];
const OWNER_BIND = ["isOwner", "auth.id in data.ref('owner.id')"];

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
  // Per-account Kyber/X448 keypair (docs/data_model.md's keyStore entity).
  // view lets an owner read their own row; create/update/delete are all
  // admin-only, since provisioning or rotating a keypair is a provisioning
  // action, never a regular user self-service write.
  keyStore: {
    bind: [...ADMIN_BIND, ...OWNER_BIND],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  // Encrypted credential rows (docs/data_model.md's credStore entity).
  // isOwner is whoever's umk wraps this row's credStoreKey. forUser may name
  // a different account for admin-managed recovery rows, but it is only a
  // lookup link and never an access grant. Same view/create/update/delete
  // shape as keyStore above: view lets an owner read their own row, but
  // create/update/delete are all admin-only -- rotating credential content is
  // a provisioning action, never a regular user self-service write.
  credStore: {
    bind: [...ADMIN_BIND, ...OWNER_BIND],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  // One row per document (docs/data_model.md's txt entity). create/update/
  // delete are admin-only (docs/data_model.md's Operating model: only the
  // admin ever owns/writes documents) -- isSharedReader extends view only,
  // never write, to whoever a txtShares row names as toUser.
  txt: {
    bind: [
      ...ADMIN_BIND,
      ...OWNER_BIND,
      "isSharedReader",
      "auth.id in data.ref('txtShares.toUser.id')",
    ],
    allow: {
      view: "isAdmin || isOwner || isSharedReader",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  // One row per document (docs/data_model.md's txtMetadata entity).
  // isSharedReader here is the one genuine two-hop check in this file --
  // txtMetadata links to txt, not directly to txtShares, so a share grants
  // access by way of the document it names, not the metadata row itself.
  txtMetadata: {
    bind: [
      ...ADMIN_BIND,
      ...OWNER_BIND,
      "isSharedReader",
      "auth.id in data.ref('txt.txtShares.toUser.id')",
    ],
    allow: {
      view: "isAdmin || isOwner || isSharedReader",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  // A document's content, chunked into ordered parts (docs/data_model.md's
  // txtParts entity). Carries its own owner link (instant.schema.ts), so
  // isOwner stays single-hop; isSharedReader is the two-hop check here, same
  // reasoning as txtMetadata -- a share grants access to the parent txt, not
  // to any one part directly.
  txtParts: {
    bind: [
      ...ADMIN_BIND,
      ...OWNER_BIND,
      "isSharedReader",
      "auth.id in data.ref('txt.txtShares.toUser.id')",
    ],
    allow: {
      view: "isAdmin || isOwner || isSharedReader",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  // One row per (document, recipient) share grant (docs/data_model.md's
  // txtShares entity). view deliberately includes the recipient
  // (auth.id in data.ref('toUser.id')) -- without it, a recipient could
  // never discover which documents have been shared to them, or fetch the
  // kemCt/txtKey values they need to Decapsulate. Every write stays
  // admin-only: only the admin ever grants or revokes a share
  // (docs/protocols.md's Sharing protocol).
  txtShares: {
    bind: [...ADMIN_BIND, "isRecipient", "auth.id in data.ref('toUser.id')"],
    allow: {
      view: "isAdmin || isRecipient",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
  },
  // One row per user (docs/data_model.md's txtAccess entity) -- a share
  // recipient's own read position for a document they don't own is still
  // gated on isOwner *of this row*, not of the document it references, so
  // tracking your own progress through a shared document never requires
  // write access to the document itself (docs/data_model.md's Design
  // notes).
  txtAccess: {
    bind: [...ADMIN_BIND, ...OWNER_BIND],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin || isOwner",
      update: "isAdmin || isOwner",
      delete: "isAdmin || isOwner",
    },
  },
  // One row per user (docs/data_model.md's txtBookmarks entity) -- same
  // isOwner-of-this-row reasoning as txtAccess above.
  txtBookmarks: {
    bind: [...ADMIN_BIND, ...OWNER_BIND],
    allow: {
      view: "isAdmin || isOwner",
      create: "isAdmin || isOwner",
      update: "isAdmin || isOwner",
      delete: "isAdmin || isOwner",
    },
  },
};

export default rules;
