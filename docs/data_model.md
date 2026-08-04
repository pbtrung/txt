# Data Model — InstantDB

This project stores data in a single InstantDB app — isolation between users is enforced entirely by InstantDB's permission rules (CEL expressions). Identity comes from Firebase Auth; InstantDB maps a verified Firebase ID token to an InstantDB user by its email claim.

Documents, their content, shares, read-position, and bookmarks are all literal InstantDB entities. Only one thing is stored outside InstantDB: a document part's actual text, which lives as a single encrypted object in Cloudflare R2, addressed by a random key that only an encrypted `txt_parts.path` value (below) points to.

Every column that holds user content, a wrapped key, or anything else sensitive stores an opaque encrypted blob in the wire format defined in [crypto.md](crypto.md) — `magic || version || salt || ciphertext || tag`. InstantDB and R2 both only ever see ciphertext; all encryption/decryption and key unwrapping happens in the client (or admin tooling), never in the database.

Exact InstantDB API names below (`i.entity`, `unique()`, `.ref()`, permission rule shape) come from InstantDB's own docs (`instantdb.com/docs/modeling-data`, `/docs/permissions`, `/docs/auth/firebase`) — verify against a real `npx instant-cli@latest push schema` before treating any of this as final.

## Operating model: admin owns content, users only ever read shared documents

Only an `admin`-typed account ever creates a `txt` row (a document) or its `txtParts` — a `user`-typed account has no ingest path of its own. A `user` account gets read access to a specific document exclusively through a `txtShares` row the admin creates for them (see "Sharing protocol" below); everything else about a `user` account (their own `txtAccess`/`txtBookmarks` rows, their own `keyStore` keypair) exists to support reading documents shared to them, not to own any of their own. This is a real behavioral asymmetry between the two roles, not just a permission-rule detail — worth keeping in mind when reading every entity below.

## Entities

There's no app-level profile entity in this design — `$users` (InstantDB's own built-in auth entity) is the only account-identity entity, and every other entity's `owner`/`user` link points directly at it. `auth.id` already equals a `$users` row's own id, so ownership checks below are always a single-hop `data.ref('owner.id')`, never a two-hop traversal through an intermediate row.

- **`$users`** — one row per Firebase-authenticated identity, keyed by email. Carries two custom attributes beyond the built-in ones:
  - **`umk`** — base64, 128 random bytes, generated once per account and wrapped (`crypto.md`'s Blob format) under `user_root_key` — an external secret supplied by `creds.json`, never stored in InstantDB. `umk` is the encryption key for this account's `keyStore.privKey` and `credStore.config` rows (below).
  - **`type`** — `'admin' | 'user'`. `'admin'` can create/update/delete any `txt`/`txtParts`/`txtShares` row and act on any account's data, full stop; `'user'` can only view/create/update their own `keyStore`/`credStore`/`txtAccess`/`txtBookmarks` rows (every rule on those is `isAdmin || isOwner`) and read (never write) a `txt`/`txtParts` row they have a `txtShares` grant for. Only ever writable via `instant.perms.ts`'s `$users.update: "isAdmin"` — there's no `isSelf` branch, so a plain user can never touch their own `type` (or anything else on their own `$users` row) through the normal write path, let alone self-promote to admin.

  **Unverified — confirm before relying on this:** whether `auth.ref('$user.type')` (`instant.perms.ts`'s `isAdmin` check) resolves a plain, non-linked attribute on the current session's own `$users` row the same way `auth.ref`/`data.ref` resolve an attribute reached across a real link.

- **`keyStore`** — one row per user (`owner`, unique link to `$users`), holding that account's `lc_kyber_1024_x448` composite keypair (see `crypto.md`'s Composite KEM Key Sizes). `pubKey` is stored raw (1624 bytes, not sensitive); `privKey` is wrapped under the owner's `umk`. This keypair exists purely so the admin can share a document with this account without ever needing that account's `umk` — see `txtShares` below. Provisioned for every account, admin included (the admin needs a `keyStore` row too, in case anyone ever needs to share _to_ the admin, though in practice the admin is always the sharer, never the recipient, today).

- **`credStore`** — one row per user (`owner`, unique link to `$users`): `config`, a single encrypted JSON blob (wrapped under `owner`'s `umk`) holding that account's R2 connection info plus a display label. The only thing this account-scoped R2 config is used for is reading (and, for the admin, writing) `txtParts` objects directly, addressed by `txtParts.path` itself (below).

  For a `user`-role account:

  ```json
  {
    "r2_config": {
      "endpoint": "",
      "region": "",
      "bucket": ""
    },
    "display_name": ""
  }
  ```

  For the admin's own row:

  ```json
  {
    "r2_config": {
      "endpoint": "",
      "read_only_access_key_id": "",
      "read_only_secret_access_key": "",
      "read_write_access_key_id": "",
      "read_write_secret_access_key": "",
      "region": "",
      "bucket": ""
    },
    "display_name": ""
  }
  ```

  A `user`-role row's `r2_config` carries no access keys at all, since a `user` session never holds a static R2 credential of any kind, only a short-lived, prefix-scoped temporary one minted on demand (see "Temporary, prefix-scoped R2 credentials" below) — and, per the operating model above, that temporary credential is always scoped **read-only**, since a `user` account never writes to R2. The admin's row carries the real, permanent R2 keys — used by CLI tooling (`--migrate`, `--clean-bucket`, `--collect-garbage`) and the planned admin-session frontend GC counterpart (see "Garbage collection" below), which deliberately use the admin's real credential directly rather than a temporary one.

- **`txt`** — one row per document. Fields: `owner` (link to `$users` — always the admin account today, per the operating model above), `txtKey` (128 random bytes, wrapped under `owner`'s `umk`), `prefix` — this document's own R2 prefix: a Crockford-base32-lowercase encoding of 32 random bytes, generated once when the document is created and wrapped under this row's own `txtKey` — and `content` — a single encrypted JSON blob (wrapped under this row's own unwrapped `txtKey`, brotli-compressed):

  ```json
  {
    "name": "original filename",
    "metadata": { "...": "opf sidecar fields, when present" },
    "last_part_num": 3,
    "last_accessed": 1738368000000,
    "created_at": 1738368000000
  }
  ```

  Putting a document's own name/metadata/read-position directly on its own `txt` row means there's no reason to wrap this JSON under anything but that row's own `txtKey`, and no reason to fan it out across a second entity. `last_part_num`/`last_accessed` are the _owning_ account's own read position for this document — a share recipient's read position for the same document lives in their own `txtAccess` row instead (below), not here.

  `prefix` is what actually addresses this document's content in R2 (see `txtParts` below and "Temporary, prefix-scoped R2 credentials"): unlike a value derived from `auth.id`, it's random and only ever recoverable by decrypting it under `txtKey` — so knowing which account owns a document, or even that account's `auth.id`, gives an attacker no way to compute where that document's parts live in the bucket.

- **`txtParts`** — a document's content, chunked into ordered parts. Fields: `txt` (link to `txt`), `partNum`, `path` — wrapped (under this document's `txtKey`) Crockford-base32-lowercase encoding of 32 random bytes, and a synthetic `partKey = "${txtId}:${partNum}"` (`unique().indexed()` — see "The composite-uniqueness problem" below). The actual part content is **not** in InstantDB: `path`, once decrypted, is a fresh random key `raw_key`, and the real R2 object lives at `raw_path = "${prefix}/${raw_key}"`, where `prefix` is this part's own `txt` row's `prefix` field, decrypted under the same `txtKey` that unwraps `path` itself. The R2 object body is `Blob.encrypt(txtKey, brotli(cleaned part text))` — the same `txtKey` that wraps `path` and `prefix`, just a third, independent application of it. This is the one place two layers of encryption protect the same content for two different reasons: `path`/`prefix` hide which random R2 key belongs to which part/document; the object body's own wrap hides the actual text from anyone who only has R2 access (a temporary credential holder) but not `txtKey`.

- **`txtShares`** — one row per (document, recipient) share grant. Fields: `txt` (link to `txt`), `fromUser` (link to `$users` — always the admin, since only the admin can share), `toUser` (link to `$users`, the recipient), `saltKemCt` (`salt` (64 random bytes) `|| lc_kyber_1024_x448` KEM ciphertext (1624 bytes), raw/public), `txtKey` (the same `txt.txtKey` bytes, rewrapped for this recipient via `HKDF-SHA3-512(IKM=ss, salt) -> 128-byte OKM` — see `crypto.md`'s Encapsulate/Decapsulate — where `ss` is the raw, uncombined shared secret from `lc_kyber_1024_x448_enc`/`_dec`, never itself stored), and a synthetic `shareKey = "${txtId}:${fromUserId}:${toUserId}"` (`unique().indexed()`). A recipient's read access to a `txt`/`txtParts` row is gated on the existence of a `txtShares` row with `toUser.id == auth.id` for that `txt` — see "Sharing protocol" below for the actual Encapsulate/Decapsulate flow.

- **`txtAccess`** — one row per (user, document) pair the user has ever opened, owner or share recipient alike. Fields: `owner` (link to `$users` — the reading account, not necessarily the document's own `owner`), `txt` (link to `txt`), `txtAccessKey` (128 random bytes, wrapped under `owner`'s `umk`, generated fresh per row), `content` — a small encrypted JSON blob (wrapped under this row's own `txtAccessKey`) `{"last_part_num": int, "last_accessed": int}`, and a synthetic `accessKey = "${userId}:${txtId}"` (`unique().indexed()`). One real row per document lets the "capped at 10 documents" eviction rule stay a plain row operation: count this user's `txtAccess` rows, delete the one with the oldest `last_accessed` before inserting an 11th. Enforced client-side only — no DB-level cap.

- **`txtBookmarks`** — one row per user (`owner`, unique link to `$users`), holding that user's bookmarks across every document they've opened — owner or share recipient alike. `txtBookmarkKey` (128 random bytes, wrapped under `owner`'s `umk`) protects `content`, a single encrypted JSON blob keyed by `txt_id`: `{"<txt_id>": [{"part_num": int, "line": int, "txt_preview": str, "created_at": int (unix ms)}, ...], ...}`, each `txt_id`'s list capped at 20 entries (client evicts the oldest `created_at` before exceeding the cap — no DB-level enforcement).

## The composite-uniqueness problem (guarded insert)

InstantDB's `unique()` constraint is per-attribute, whole-namespace — it cannot express "unique per (a, b, c)" directly. Three entities above need a composite key for exactly this reason, and each follows the same fix: compute a synthetic key client-side and mark it `unique().indexed()`, so a concurrent duplicate insert fails outright rather than needing a hand-rolled existence check first.

| Entity      | Synthetic key                                     | Guards against                                                            |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `txtParts`  | `partKey = "${txtId}:${partNum}"`                 | two concurrent ingests writing the same part twice                        |
| `txtShares` | `shareKey = "${txtId}:${fromUserId}:${toUserId}"` | double-sharing the same document to the same recipient                    |
| `txtAccess` | `accessKey = "${userId}:${txtId}"`                | two concurrent opens of the same document creating two read-position rows |

Every synthetic key is deterministic and plaintext by design (it only needs to be unique and computable, never secret) — unlike the values it helps guard (`txtParts.path`, `txtShares.txtKey`/`saltKemCt`, `txtAccess.content`), which are wrapped precisely because they're either a real R2 address or real key material.

## Key hierarchy

```
user_root_key
    (per-account config secret, >=256 random bytes, base64; not
    stored in InstantDB)
    |  IKM for HKDF, wraps/unwraps --
    v
$users.umk
    (128 random bytes, generated once per account)
    |  used directly as IKM for HKDF, wraps/unwraps --
    +--> keyStore.privKey
    |        (lc_kyber_1024_x448 composite private key, 3224 raw
    |        bytes -- pubKey stored raw/public, not wrapped)
    |
    +--> credStore.config
    |        (r2_config + display_name; used directly as IKM, no
    |        intermediate key)
    |
    +--> txt.txtKey            (per document, 128 random bytes, owner-only)
    |        |  used directly as IKM --
    |        +--> txt.content       (name/metadata/read-position)
    |        +--> txt.prefix        (this document's own R2 prefix)
    |        +--> txtParts.path     (per part, wraps the R2 raw_key)
    |        +--> txtParts R2 object body (independent third wrap)
    |
    +--> txtAccess.txtAccessKey   (per (user, document) row, 128 random bytes)
    |        |  used directly as IKM --
    |        +--> txtAccess.content   (that row's own read position)
    |
    +--> txtBookmarks.txtBookmarkKey   (per user, 128 random bytes)
             |  used directly as IKM --
             +--> txtBookmarks.content   (bookmarks, keyed by txt_id)

txt.txtKey, in parallel, is also wrapped a second way -- not under
umk -- once per share recipient:

    admin Encapsulates (crypto.md) against recipient's keyStore.pubKey
        |
        v
    txtShares.{saltKemCt, txtKey}
        (txtKey here is the same bytes as txt.txtKey, wrapped via
        HKDF-SHA3-512(IKM=ss, salt) -> 128-byte OKM instead of umk)
        |
        |  recipient Decapsulates using their own keyStore.privKey
        v
    (recipient now holds txt.txtKey, unwrapped, without ever
    learning the admin's umk)
```

Every wrapped-key and content blob uses the blob format, AEAD, and KDF mechanics from [crypto.md](crypto.md) uniformly. `txtShares.txtKey` is the one value in this hierarchy wrapped via Encapsulate/Decapsulate (asymmetric) instead of a plain Encrypt/Decrypt under a key both sides already hold.

## Ingest / write path

There is no MVCC/version CAS: a `txtParts` row is written exactly once and never revised in place, so there's no concurrent-writer conflict to resolve on write.

1. (Admin only.) Clean and split the source text into ordered parts (target size per `constants.PART_TARGET`). For a brand-new document, generate its `txtKey` and its `prefix = crockford_base32_lowercase(32 random bytes)` at this point too — `prefix` is generated once per document and reused for every part.
2. For each part: brotli-compress the cleaned text, encrypt it under the document's `txtKey` (`crypto.md`'s Encrypt), and `PUT` the resulting ciphertext to R2 at `"${prefix}/${raw_key}"` for a freshly generated `raw_key = crockford_base32_lowercase(32 random bytes)`.
3. Encrypt `raw_key` alone under `txtKey` and base64-encode the result — this becomes the new `txtParts` row's `path` value.
4. `db.transact([...])`: create the `txt` row (first part of a new document — `prefix` from step 1, wrapped under `txtKey`) or the new `txtParts` row (`partKey` from the table above, `path` from step 3, linked to `txt`).

**The one failure mode:** step 2 (the R2 `PUT`) and step 4 (the InstantDB `transact`) are two separate operations. A crash between them leaves a real R2 object with no `txtParts` row pointing at it. Garbage collection's orphan sweep (below) cleans this up.

## Read path

Query `txtParts` for `txt = target, partNum = N` (or a range) — the result already includes `path`. Decrypt the target `txt` row's `prefix` and this part's `path` with the document's `txtKey` to recover `prefix` and `raw_key`, reassemble `raw_path = "${prefix}/${raw_key}"`, `GET` that object from R2, then decrypt the object body under the same `txtKey` and brotli-decompress. Two hops: one InstantDB query, one R2 fetch — same shape whether the reader owns the document or is reading it via a `txtShares` grant; only how they obtained `txtKey` differs (own `umk` vs. Decapsulate).

## Sharing protocol

Only the admin ever grants a share (`fromUser` is always the admin's own `$users` row):

1. Admin looks up the recipient's `keyStore.pubKey` (raw, not sensitive).
2. Admin generates a random 64-byte `salt` and Encapsulates against that `pubKey` (`crypto.md`'s Encapsulate) — this yields a KEM ciphertext `ct` and a shared secret `ss`, and wraps the document's already-unwrapped `txtKey` using `HKDF-SHA3-512(IKM=ss, salt)` reusing that same `salt`, producing a standard blob.
3. Admin writes the new `txtShares` row: `shareKey`, `txt` (link), `fromUser` = admin, `toUser` = recipient, `saltKemCt = salt || ct`, `txtKey` = the blob from step 2.
4. The recipient's own read path (above) tries their own-owned `txt` lookup first and falls back to Decapsulating a `txtShares` row scoped by `toUser.id == auth.id` when the document isn't their own — same pattern as the admin's own lookup, scoped by `owner.id` instead.

Revoking a share is a straight delete of the `txtShares` row; nothing else needs to change, since the recipient's own `txtAccess`/`txtBookmarks` rows for that document simply become unreadable (no path to `txtKey` survives) rather than needing to be scrubbed themselves.

## Temporary, prefix-scoped R2 credentials

No account holds a static R2 access key in the browser, admin included — the admin's own `read_write_access_key_id`/`secret` is the only permanent R2 credential in this design, and it lives only as a Cloudflare Worker secret (`worker/r2Creds.ts`'s `env.READ_WRITE_ACCESS_KEY_ID`/`SECRET`), never in any client session. Every read/write goes through a short-lived, prefix-scoped temporary credential instead.

Every document's `raw_path` values live under its own `txt.prefix` — random, wrapped under that document's `txtKey`, and recoverable only by whoever can unwrap `txtKey` (the owner, or a share recipient via Decapsulate). This means a temporary credential can be scoped to exactly one document at a time, not to everything a given account can see: a `user` reading a shared document only ever needs (and only ever requests) a credential scoped to that one document's own `prefix`.

1. The client calls Firebase's `getIdToken()` and sends `{idToken, prefix, bucket, endpoint}` to the Worker's `POST /api/r2-creds`, where `prefix` is a document's own decrypted `txt.prefix`.
2. The Worker verifies the token itself — RS256 signature against Firebase's own public JWKS via `jose`, issuer/audience pinned to a Worker-configured Firebase project ID never accepted from the request itself.
3. **The Worker decides `scope` from the verified identity alone, never from which `prefix` is requested:** `scope: "object-read-write"` when the verified identity is the admin account (a Worker-configured admin identity — e.g. `env.ADMIN_UID` — compared against the token's own subject), `scope: "object-read"` for every other identity, regardless of which document's `prefix` they ask for. Since only the admin ever creates or writes `txtParts`, this is the whole rule: there's no per-document ownership check to perform, because only one account is ever allowed to write, full stop. **Unverified — confirm before relying on this:** this identity-only scope rule is a design requirement for this data model, not yet implemented in `worker/r2Creds.ts`.
4. The Worker mints the temporary credential via R2's Temporary Credentials local-signing path (see the current `worker/r2Creds.ts` implementation notes for the exact JWT claim shapes) using whichever `scope` step 3 decided, and returns `{accessKeyId, secretAccessKey, sessionToken, expiresAtMs}`.
5. The client re-requests a fresh temporary credential before `expiresAtMs`; no long-lived secret is ever cached client-side.

This is the one place this design needs a server component — every other unlock/read/write path is a direct client-to-InstantDB or client-to-R2 call. The Worker only ever verifies identity and brokers scoped, time-limited credentials; it never sees page content or any account's `umk`/`txtKey`.

**Planned exception:** a frontend counterpart to `txt.ts --collect-garbage` is intended to use the admin's real, decrypted `r2_config` directly in an admin-logged-in browser session, not a temporary credential — the admin's own `r2_config` is already recoverable client-side regardless (decrypt `umk` -> the admin's own `credStore` row), so this doesn't expose anything not already reachable.

### Provisioning a `user` account

Creating a `user` account is an admin-side action: the admin generates that user's `user_root_key` (delivered to them out-of-band via their own `creds.json`), generates their `umk` and wraps it under that `user_root_key`, generates their `keyStore` keypair (`privKey` wrapped under their `umk`), and writes their `credStore` row (`r2_config` with no access keys, plus `display_name`). There is no per-user database to initialize and no initial page upload — a fresh `user` account owns no documents at all until the admin shares one with them. From that point on, the user reads shared documents entirely through the temporary-credential flow above; the admin never needs to touch their account again for ordinary use.

## Garbage collection

Only the admin ever writes to R2, but there is no single admin-wide prefix to sweep anymore — every document has its own `prefix`, so both sweeps below iterate over every `txt` row (the admin can enumerate all of them; a `user` account never needs to run GC at all, since it never writes) rather than listing one shared namespace.

1. **Document/part deletion.** Deleting a `txt` row must delete every R2 object its `txtParts` rows point at — but InstantDB's own cascade-delete (`onDelete: "cascade"` on the `txt` link) will remove those `txtParts` rows the moment the `txt` row itself is deleted, which would destroy the only record of which `raw_key`s need deleting. Order matters: first decrypt the document's own `prefix` and every `txtParts.path` (recovering every `raw_key`), delete those R2 objects, and only then delete the `txt` row (letting cascade clean up `txtParts`/`txtShares` for free). A crash between the R2 deletes and the `txt` row delete leaves a real document with dangling, already-gone R2 objects — recoverable by re-running the same delete (idempotent: deleting an already-gone R2 object is a no-op).
2. **Orphan sweep**, for the ingest path's one failure mode (above): for each `txt` row, decrypt its `prefix`, list every R2 object under that one prefix, diff against that document's own `txtParts` rows' decrypted `raw_key`s, and delete whatever's left over after a grace period long enough to outlast any in-flight ingest's PUT-to-transact gap. Structurally the same shape as `txt.ts --clean-bucket`, just per-document instead of over one flat namespace.

`txt.ts --migrate` implements a version of sweep 2 scoped to its own target account, run at the start of every invocation (no grace period needed, since it's the same operator re-running the same command, not a background job racing an in-flight ingest): for each document already migrated, decrypt its `prefix`, list R2 objects under it, diff against that document's `txtParts` rows' decrypted `raw_key`s, and delete leftovers from a previous crashed run. This is what makes `--migrate` resumable without duplicating documents: each migrated document keeps its source `txt_id` as its target `txt_id`, so a re-run only needs `SELECT id FROM txt` (source-side schema, see `txt/owner.ts`) against the target to know which source documents already made it across.

**Planned: a frontend counterpart.** The same two sweeps, triggerable from an admin-logged-in browser session instead of the CLI tool, using the real client SDK and the admin's own decrypted `r2_config` directly rather than a Worker-minted temporary credential (see "Temporary, prefix-scoped R2 credentials" above). Not yet implemented.

## Auth

Every unlock requires a live Firebase sign-in (`getIdToken()` -> `db.auth.signInWithIdToken()`), since InstantDB resolves identity from the token's email claim at session-creation time, not from a long-lived static credential. After sign-in, the client reads its own `$users.umk`, unwraps it under `user_root_key`, then reads its own `keyStore`/`credStore`/`txtAccess`/`txtBookmarks` rows as needed. A `user`-role session additionally depends on the temporary-credential intermediary (above), always read-only, for any R2 access at all — it never writes to R2, since it never owns content.

## Design Notes

- **Isolation depends entirely on permission rules, not physical separation** — a rules bug is a cross-user data leak across the whole app, not contained to a single account.
- **Per-document R2 prefixes bound a compromised or malicious `user` session to exactly one document.** A share recipient's temporary credential is scoped to that one document's own `prefix`, never the admin's whole corpus — the identity-only `scope` rule in "Temporary, prefix-scoped R2 credentials" above (only the admin ever gets `object-read-write`) is what keeps even that one document safe from being overwritten or deleted by the recipient it was shared to.
- **Three independent layers of encryption protect a part, deliberately**: `txt.prefix` and `txtParts.path` together protect the R2 _address_ a part lives at (both wrapped under the same `txtKey`, but two separate applications of it); the R2 object body's own independent wrap (same `txtKey` again) protects the part's _content_. Compromising R2 list/read access alone (without `txtKey`) yields neither the mapping from part to object nor the ability to decrypt any object it did manage to guess.
- **`txtAccess`'s per-row shape vs. `txtBookmarks`'s per-user shape is a deliberate asymmetry, not an oversight** — `txtAccess` is one row per (user, document) specifically so its "capped at 10" eviction rule is a plain row-count-and-delete-oldest operation; `txtBookmarks` stays a single per-user JSON blob, since its own cap doesn't need that treatment.
