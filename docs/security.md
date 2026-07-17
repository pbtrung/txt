# Security

## Threat model

- Both the CLI and the web UI connect directly to Turso with the same full-access token — there's no application server mediating access. Whoever holds that token can query/write any row in the database; confidentiality of the *content* rests entirely on the key hierarchy rooted at `root_master_key` (see [crypto.md](crypto.md)), not on Turso access being restricted, but *integrity* (not deleting/corrupting rows) has no protection beyond "don't leak the token."
- The credentials file (containing `turso_auth_token` and the base64 `root_master_key`) must be kept secret and out of version control, same as before. Anyone who has it can unwrap every user's `umk` and therefore every file, regardless of owner — and, separately, can read/write/delete any row via the Turso token, regardless of whose data it is.
- Compression happens before encryption, everywhere, to avoid compression-oracle attacks.

## `user_id` is now a real cryptographic boundary, rooted at `root_master_key`

Per the key hierarchy in [crypto.md](crypto.md), each user's files are wrapped under that user's own `umk`, and each `umk` is itself wrapped under `root_master_key`. Concretely:

- Holding one user's `umk` unwraps that user's `txt_key`s and `txt_metadata` (their file content *and* their filenames) but **not** another user's `umk`, files, or filenames — unless a file has been explicitly shared with them via `txt_shares` (see below). This is real per-user envelope encryption, not an application-layer label.
- Holding `root_master_key` unwraps every user's `umk`, and therefore every file and filename — it remains the single point of total compromise. Anyone with the credentials file has this.

So: per-user isolation holds for both file content and filenames against anything short of `root_master_key`, except for files a user has explicitly been granted via sharing.

## Sharing narrows isolation deliberately, and only for granted files

Per [crypto.md](crypto.md)'s Sharing section, granting access re-wraps a file's `txt_key` under the recipient's own `umk` — it never exposes the owner's `umk`, so nothing else the owner has is affected by a share. Two things worth being explicit about:

- **Sharing requires `root_master_key`.** The grant/revoke operation unwraps both the owner's and the recipient's `umk`, which only something holding `root_master_key` can do. In practice this means sharing is a CLI/admin action (same trust tier as ingest), not something a logged-in browser session can do unilaterally with only its own `umk`. Anyone who can run `--share` can grant themselves — or anyone — access to any file, since they necessarily hold `root_master_key` to do it at all; this isn't a new capability sharing introduces, just a routine exercise of a capability `root_master_key` already had.
- **Revocation has no forward secrecy.** Deleting a `txt_shares` row stops *future* decryption through that grant. It does not invalidate a plaintext copy (or a cached raw `txt_key`) the recipient already obtained before revocation. If that matters, the only real fix is rotating the file's `txt_key` (re-encrypting `txt_parts`/`bookmarks` under a new key and re-granting remaining recipients) — not implemented here, since it's a meaningfully larger operation than a `DELETE`.

## Filename confidentiality changed shape

Previously, each filename had its own salt and an HMAC-based blind index for O(row) dedup lookups without decrypting every name. Now each user has one `txt_metadata` row holding only their own filenames:

- Upside: filenames are now per-user isolated (see above), and within a user's own blob, individual name lengths are hidden inside one aggregate ciphertext rather than each having its own row/size.
- Downside: there is no more blind-index lookup; any dedup check requires decrypting that user's whole `txt_metadata` row (the CLI already holds the keys needed to do this for the user it's ingesting as, so this is not a new capability being granted, just a different code path — see [crypto.md](crypto.md)/[data_model.md](data_model.md)).

## Turso access caveats

- There is no server enforcing "only decrypt what this session's token allows" — whatever key material (a user's `umk`, or `root_master_key`) the browser/CLI holds determines what it can decrypt, per the hierarchy above. All access control over *content* is client-side and trust-dependent on which key(s) that session actually has.
- **A single full-access token means no per-user containment at the database layer.** Since the browser holds the same token as the CLI, a compromised browser session (XSS, a malicious extension, a leaked token) doesn't just risk that one user's data — it can read, modify, or delete *any* row for *any* user, including tables it has no keys to decrypt. Encryption stops it from reading plaintext it shouldn't; nothing stops it from deleting or corrupting rows outright. Turso does support scoped/read-only tokens; this design deliberately doesn't use that, so this containment gap is a known, accepted trade-off rather than an oversight.
- **Query patterns are directly visible to Turso, more so than the earlier paged-HTTP design would have been.** Every operation is a real SQL query/transaction; anyone who can observe Turso's side (its own logs, or a compromised/malicious hosting relationship) sees exact table names and `WHERE` clauses — not just byte ranges — even though the values themselves are ciphertext. Coarse access patterns (which `txt_id`s a session repeatedly queries, when a `--share` grant touches `umk_store` for two specific users) are legible metadata, same category of leakage as before, just more precise.
- The Turso auth token lives in the browser session (loaded from `creds.json` at login, mirroring the original pre-redesign design) — it's exposed to anything that can read browser memory/storage during that session, same inherent trade-off as any client-side full-credential model.
