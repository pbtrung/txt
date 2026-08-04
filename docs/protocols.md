# Protocols

The operational read/write/share/garbage-collection flows against the entities in [data_model.md](data_model.md), using the key hierarchy in [key_hierarchy.md](key_hierarchy.md). See [r2_credentials.md](r2_credentials.md) for how the R2 access these flows depend on is actually brokered.

## Ingest / write path

There is no MVCC/version CAS: a `txtParts` row is written exactly once and never revised in place, so there's no concurrent-writer conflict to resolve on write.

1. (Admin only.) Clean and split the source text into ordered parts (target size per `constants.PART_TARGET`). For a brand-new document, generate its `txtKey` and its `prefix = crockford_base32_lowercase(32 random bytes)` at this point too — both are generated once per document and reused for every part/update. For each part, also generate a fresh `txtPartKey` (128 random bytes).
2. For each part: brotli-compress the cleaned text, encrypt it under that part's own `txtPartKey` (`crypto.md`'s Encrypt), and `PUT` the resulting ciphertext to R2 at `"${prefix}/${raw_key}"` for a freshly generated `raw_key = crockford_base32_lowercase(32 random bytes)`, using the admin's own real, static read-write R2 credential (from the admin's own `credStore` row) — never a Worker-minted temporary one, since `worker/r2Creds.ts` only ever mints read-only credentials (see [r2_credentials.md](r2_credentials.md)).
3. Encrypt `raw_key` alone under that same `txtPartKey` and base64-encode the result — this becomes the new `txtParts` row's `path` value.
4. `db.transact([...])`: for a brand-new document, create the `txt` row (`prefix` from step 1, wrapped under `txtKey`) and its `txtMetadata` row (`content` — name plus any OPF sidecar fields — wrapped directly under `txtKey`) in the same transaction; either way, create the new `txtParts` row (`partKey` from `data_model.md`'s composite-uniqueness table, `txtPartKey` from step 1 wrapped under `txtKey`, `path` from step 3, linked to `txt`).

**The one failure mode:** step 2 (the R2 `PUT`) and step 4 (the InstantDB `transact`) are two separate operations. A crash between them leaves a real R2 object with no `txtParts` row pointing at it. Garbage collection's orphan sweep (below) cleans this up.

## Read path

Query `txtParts` for `txt = target, partNum = N` (or a range) — the result already includes `txtPartKey` and `path`. Decrypt the target `txt` row's `prefix` directly under `txtKey`, decrypt this part's `txtPartKey` under that same `txtKey`, then decrypt `path` under that `txtPartKey` to recover `raw_key`; reassemble `raw_path = "${prefix}/${raw_key}"`, `GET` that object from R2, then decrypt the object body under the same `txtPartKey` and brotli-decompress. Two hops: one InstantDB query, one R2 fetch — same shape whether the reader owns the document or is reading it via a `txtShares` grant; only how they obtained `txtKey` (the root of this part's own key chain) differs (own `umk` vs. Decapsulate).

## Sharing protocol

Only the admin ever grants a share (`fromUser` is always the admin's own `$users` row):

1. Admin looks up the recipient's `keyStore.pubKey` (raw, not sensitive).
2. Admin generates a random 64-byte `salt` and Encapsulates against that `pubKey` (`crypto.md`'s Encapsulate) — this yields a KEM ciphertext `ct` and a shared secret `ss`, and wraps the document's already-unwrapped `txtKey` using `HKDF-SHA3-512(IKM=ss, salt)` reusing that same `salt`, producing a standard blob.
3. Admin writes the new `txtShares` row: `shareKey`, `txt` (link), `fromUser` = admin, `toUser` = recipient, `saltKemCt = salt || ct`, `txtKey` = the blob from step 2.
4. The recipient's own read path (above) tries their own-owned `txt` lookup first and falls back to Decapsulating a `txtShares` row scoped by `toUser.id == auth.id` when the document isn't their own — same pattern as the admin's own lookup, scoped by `owner.id` instead.

Revoking a share is a straight delete of the `txtShares` row; nothing else needs to change. `txtAccess`/`txtBookmarks` entries are never wrapped under `txtKey` (they're wrapped under the reading account's own `txtAccessKey`/`txtBookmarkKey`, unaffected by the revoke either way), so any entry they hold for that `txt_id` simply becomes a reference to a document that account can no longer actually open — nothing to scrub. [data_model.md](data_model.md)'s Permission rules are what actually stop the read access, immediately, on delete.

## Garbage collection

Only the admin ever writes to R2, but there is no single admin-wide prefix to sweep anymore — every document has its own `prefix`, so both sweeps below iterate over every `txt` row (the admin can enumerate all of them; a `user` account never needs to run GC at all, since it never writes) rather than listing one shared namespace.

1. **Document/part deletion.** Deleting a `txt` row must delete every R2 object its `txtParts` rows point at — but InstantDB's own cascade-delete (`onDelete: "cascade"` on the `txt` link) will remove those `txtParts` rows the moment the `txt` row itself is deleted, which would destroy the only record of which `raw_key`s need deleting. Order matters: first decrypt the document's own `prefix` directly under `txtKey`, then each `txtParts` row's own `txtPartKey` (under that same `txtKey`) and its `path` (under that row's `txtPartKey`) to recover every `raw_key`, delete those R2 objects, and only then delete the `txt` row (letting cascade clean up `txtParts`/`txtMetadata`/`txtShares` for free). A crash between the R2 deletes and the `txt` row delete leaves a real document with dangling, already-gone R2 objects — recoverable by re-running the same delete (idempotent: deleting an already-gone R2 object is a no-op).
2. **Orphan sweep**, for the ingest path's one failure mode (above): for each `txt` row, decrypt its `prefix`, list every R2 object under that one prefix, diff against that document's own `txtParts` rows' decrypted `raw_key`s (each recovered via that row's own `txtPartKey`, unwrapped under `txtKey`), and delete whatever's left over after a grace period long enough to outlast any in-flight ingest's PUT-to-transact gap. Structurally the same shape as `txt.ts --clean-bucket`, just per-document instead of over one flat namespace.

`txt.ts --migrate` implements a version of sweep 2 scoped to its own target account, run at the start of every invocation (no grace period needed, since it's the same operator re-running the same command, not a background job racing an in-flight ingest): for each document already migrated, decrypt its `prefix`, list R2 objects under it, diff against that document's `txtParts` rows' decrypted `raw_key`s (via each row's own `txtPartKey`, as above), and delete leftovers from a previous crashed run. This is what makes `--migrate` resumable without duplicating documents: each migrated document keeps its source `txt_id` as its target `txt_id`, so a re-run only needs `SELECT id FROM txt` (source-side schema, see `txt/owner.ts`) against the target to know which source documents already made it across.

**Planned: a frontend counterpart.** The same two sweeps, triggerable from an admin-logged-in browser session instead of the CLI tool, using the real client SDK and the admin's own decrypted `r2_config` directly rather than a Worker-minted temporary credential (see [r2_credentials.md](r2_credentials.md)). Not yet implemented.
