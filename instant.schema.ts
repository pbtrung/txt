// Schema for the InstantDB + Firebase Auth + R2 design documented across
// docs/data_model.md (entities, permission rules), docs/key_hierarchy.md
// (how the encryption keys below nest), docs/protocols.md (ingest/read/
// share/GC flows), docs/r2_credentials.md (R2 credential broker, account
// provisioning), and docs/auth.md (sign-in flow). Not wired into any running
// code yet. Verify against a real `npx instant-cli@latest push schema`
// before treating this as final; the API shape here is synthesized from
// InstantDB's own docs, not exercised against a live schema.
//
// Only the admin account ever creates txt/txtMetadata/txtParts/txtShares
// rows (docs/data_model.md's Operating model) -- a `user`-role account only
// ever reads them via a txtShares grant, and otherwise only ever
// creates/reads/writes its own keyStore/credStore/txtAccess/txtBookmarks
// rows. See instant.perms.ts for the isAdmin/isOwner/isSharedReader rules
// this schema's links exist to support.

import { i } from "@instantdb/core";

const _schema = i.schema({
  entities: {
    // $users is InstantDB's own built-in auth entity, but custom attributes
    // on it are allowed like any other -- there's no separate app-level
    // profile entity in this design, so $users is also the one thing every
    // other entity's owner/forUser/fromUser/toUser link points at directly.
    // Never readable/writable except by isSelf/isAdmin (instant.perms.ts).
    $users: i.entity({
      email: i.string().unique().indexed(),
      // base64, 128 random bytes, generated once per account and wrapped
      // (crypto.md's Blob format) under user_root_key (an external secret
      // from creds.json, never stored in InstantDB). Encrypts this
      // account's own keyStore.keyStoreKey and every credStore.credStoreKey
      // on a row this account owns -- see docs/key_hierarchy.md. A leaked
      // query result still can't be unwrapped without the external
      // user_root_key.
      umk: i.string().optional(),
      // 'admin' | 'user' -- the permission system's role switch. Only ever
      // admin-writable (instant.perms.ts's $users.update: "isAdmin", no
      // isSelf branch at all), so self-promotion isn't possible through the
      // normal write path.
      type: i.string().optional(),
    }),
    // Per-account lc_kyber_1024_x448 composite keypair (docs/data_model.md's
    // keyStore entity) -- lets the admin share a document with this account
    // without ever needing that account's own umk (see txtShares below).
    // One row per user; provisioned for every account, admin included.
    keyStore: i.entity({
      // Raw 1624-byte composite public key -- not sensitive, stored as-is.
      pubKey: i.string(),
      // 128 random bytes, wrapped under owner's umk; the intermediate key
      // that in turn wraps privKey (docs/key_hierarchy.md), rather than
      // wrapping privKey directly under umk.
      keyStoreKey: i.string(),
      // Wrapped composite private key (3224 raw bytes once decrypted).
      privKey: i.string(),
    }),
    // Encrypted credential rows (docs/data_model.md's credStore entity).
    // owner is the account whose umk wraps this row's credStoreKey; forUser
    // identifies the account this row is about. A user's self row has
    // owner == forUser; an admin-managed recovery row has owner == admin and
    // forUser == target user. content is a Blob-wrapped (crypto.md format)
    // JSON string.
    credStore: i.entity({
      // 128 random bytes, freshly generated per row and wrapped under this
      // row owner's umk. Two rows can intentionally hold the same plaintext
      // credential payload, but never share a credStoreKey.
      credStoreKey: i.string(),
      content: i.string(),
    }),
    // One row per document (docs/data_model.md's txt entity). Only ever
    // owned by the admin today (docs/data_model.md's Operating model).
    txt: i.entity({
      // 128 random bytes, wrapped under owner's umk. Root of this
      // document's own key chain (docs/key_hierarchy.md) -- also rewrapped
      // per share recipient via Encapsulate/Decapsulate, see txtShares.
      txtKey: i.string(),
      // This document's own R2 prefix: Crockford-base32-lowercase encoding
      // of 32 random bytes, wrapped under txtKey. Random rather than
      // derived from auth.id, so it's only ever recoverable by whoever can
      // unwrap txtKey (docs/r2_credentials.md).
      prefix: i.string(),
      // Plaintext, present only on a migrated document: the source
      // snapshot's own integer txt_id (txt/owner.ts's legacy schema).
      // InstantDB rows have no integer primary key to reuse the way the
      // legacy design reused txt_id directly as its own target row id
      // (docs/protocols.md's Ingest/write path), so this is what
      // txt.ts --migrate queries by instead to make a re-run resumable:
      // whether a given source document has already landed, and (via a
      // COUNT of its txtParts) how many of its parts have. Not sensitive
      // (a document's original position in an already-admin-only-readable
      // source snapshot), same category as partKey/shareKey below.
      sourceTxtId: i.number().indexed().optional(),
    }),
    // One row per document (docs/data_model.md's txtMetadata entity).
    // content is the full name/OPF-sidecar metadata; catalog is the
    // lightweight {name, authors, subjects, publishers} projection for
    // library loading. Both are wrapped directly under the document's own
    // txtKey (no intermediate key, unlike keyStore/credStore/txtAccess/
    // txtBookmarks).
    txtMetadata: i.entity({
      content: i.string(),
      catalog: i.string(),
    }),
    // A document's content, chunked into ordered parts (docs/data_model.md's
    // txtParts entity). Like txtMetadata, carries its own owner link (same
    // account as txt.owner) so instant.perms.ts's isOwner check stays a
    // single-hop data.ref('owner.id') instead of traversing txt.owner --
    // isSharedReader is the only two-hop check either entity needs.
    // partKey is the synthetic composite-uniqueness guard
    // (docs/data_model.md's composite-uniqueness problem) -- InstantDB's
    // unique() is per-attribute, whole-namespace, so "unique per (txt,
    // partNum)" has to be computed client-side as a single string instead.
    txtParts: i.entity({
      partNum: i.number().indexed(), // supports the Read path's `partNum = N` (or a range) query
      // 128 random bytes, wrapped under this document's own txtKey. Wraps
      // path and the R2 object body (docs/key_hierarchy.md) -- a single
      // part's key being compromised never exposes another part.
      txtPartKey: i.string(),
      // Wrapped (under this row's own txtPartKey) Crockford-base32-lowercase
      // encoding of 32 random bytes -- the real R2 object lives at
      // "${prefix}/${raw_key}" once decrypted (docs/protocols.md's Read
      // path).
      path: i.string(),
      partKey: i.string().unique().indexed(), // `${txtId}:${partNum}`
    }),
    // One row per (document, recipient) share grant (docs/data_model.md's
    // txtShares entity). Only the admin ever creates one (fromUser is
    // always the admin's own $users row) -- see docs/protocols.md's Sharing
    // protocol.
    txtShares: i.entity({
      // salt (64 random bytes) || lc_kyber_1024_x448 KEM ciphertext (1624
      // bytes), raw/public -- what the recipient needs to Decapsulate.
      saltKemCt: i.string(),
      // The same txt.txtKey bytes, rewrapped for this recipient via
      // HKDF-SHA3-512(IKM=ss, salt) -> 128-byte OKM (crypto.md's
      // Encapsulate/Decapsulate) instead of the owner's umk.
      txtKey: i.string(),
      shareKey: i.string().unique().indexed(), // `${txtId}:${fromUserId}:${toUserId}`
    }),
    // One row per user (docs/data_model.md's txtAccess entity), holding that
    // user's read position across every document they've opened -- owner or
    // share recipient alike.
    txtAccess: i.entity({
      // 128 random bytes, wrapped under owner's umk.
      txtAccessKey: i.string(),
      // JSON keyed by txt_id: {"<txt_id>": {"last_part_num": int,
      // "last_accessed": int}, ...}, capped at 10 txt_id entries
      // (client-enforced, no DB-level cap).
      content: i.string(),
    }),
    // One row per user (docs/data_model.md's txtBookmarks entity), holding
    // that user's bookmarks across every document they've opened -- owner
    // or share recipient alike.
    txtBookmarks: i.entity({
      // 128 random bytes, wrapped under owner's umk.
      txtBookmarkKey: i.string(),
      // JSON keyed by txt_id: {"<txt_id>": [{"part_num": int, "line": int,
      // "txt_preview": str, "created_at": int}, ...], ...}, each txt_id's
      // list capped at 20 entries (client-enforced, no DB-level cap).
      content: i.string(),
    }),
  },
  links: {
    // Every owner/forUser/fromUser/toUser link below targets $users directly
    // -- auth.id already equals a $users row's own id, so
    // instant.perms.ts's isOwner checks are a single-hop
    // data.ref('owner.id'), never a two-hop traversal through an
    // intermediate profile row. `on`, not `data`, is what's authoritative
    // here: onDelete goes on whichever side of a link has `has: "one"` (the
    // only cardinality it's valid on) and fires when the *other* side's
    // entity is deleted -- so deleting a $users row cascades directly to
    // every row it owns, one step each, no intermediate entity to cascade
    // through first.
    keyStoreOwner: {
      // has: "one" on both sides -- exactly one keyStore row per $users row.
      forward: {
        on: "keyStore",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "one", label: "keyStore" },
    },
    credStoreOwner: {
      // reverse has: "many" (not "one") -- the admin's owner link is
      // deliberately not unique, so more than one credStore row can point
      // back at the same $users row. "Exactly one self row per account" and
      // "at most one admin-managed recovery row per user" are provisioning/UI
      // invariants, not enforced here.
      forward: {
        on: "credStore",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "credStore" },
    },
    credStoreForUser: {
      // Plaintext management index only: lets admin flows query the
      // admin-owned recovery row for one target user directly. Permission
      // rules still use owner/isAdmin; forUser is never an access grant.
      forward: {
        on: "credStore",
        has: "one",
        label: "forUser",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "credStoreForUser" },
    },
    txtOwner: {
      forward: { on: "txt", has: "one", label: "owner", onDelete: "cascade" },
      reverse: { on: "$users", has: "many", label: "txt" },
    },
    // txtMetadata's own single-hop owner link (docs/data_model.md: "kept as
    // its own single-hop link for permission rules rather than traversing
    // txt.owner").
    txtMetadataOwner: {
      forward: {
        on: "txtMetadata",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "txtMetadataAsOwner" },
    },
    // has: "one" on both sides -- exactly one txtMetadata row per txt row.
    txtMetadataTxt: {
      forward: {
        on: "txtMetadata",
        has: "one",
        label: "txt",
        onDelete: "cascade",
      },
      reverse: { on: "txt", has: "one", label: "txtMetadata" },
    },
    txtPartsTxt: {
      forward: {
        on: "txtParts",
        has: "one",
        label: "txt",
        onDelete: "cascade",
      },
      reverse: { on: "txt", has: "many", label: "txtParts" },
    },
    // txtParts' own single-hop owner link, same rationale as
    // txtMetadataOwner above.
    txtPartsOwner: {
      forward: {
        on: "txtParts",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "txtPartsAsOwner" },
    },
    // reverse label "txtShares" here is what instant.perms.ts's
    // isSharedReader traverses from txt itself
    // (data.ref('txtShares.toUser.id')) and, one hop further, from
    // txtParts/txtMetadata (data.ref('txt.txtShares.toUser.id')).
    txtSharesTxt: {
      forward: {
        on: "txtShares",
        has: "one",
        label: "txt",
        onDelete: "cascade",
      },
      reverse: { on: "txt", has: "many", label: "txtShares" },
    },
    txtSharesFromUser: {
      forward: {
        on: "txtShares",
        has: "one",
        label: "fromUser",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "txtSharesFrom" },
    },
    // forward label "toUser" here is what instant.perms.ts's txtShares.view
    // rule checks directly (data.ref('toUser.id')), and what isSharedReader
    // checks one or two hops away from txt/txtParts/txtMetadata.
    txtSharesToUser: {
      forward: {
        on: "txtShares",
        has: "one",
        label: "toUser",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "many", label: "txtSharesTo" },
    },
    // has: "one" on both sides -- exactly one txtAccess row per $users row.
    txtAccessOwner: {
      forward: {
        on: "txtAccess",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "one", label: "txtAccess" },
    },
    // has: "one" on both sides -- exactly one txtBookmarks row per $users
    // row.
    txtBookmarksOwner: {
      forward: {
        on: "txtBookmarks",
        has: "one",
        label: "owner",
        onDelete: "cascade",
      },
      reverse: { on: "$users", has: "one", label: "txtBookmarks" },
    },
  },
});

export default _schema;
