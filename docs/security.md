# Security

## Threat model

- The `.db` file — the whole file, wholesale — is what leaves the trust boundary: the CLI writes it locally, then it's pushed to Cloudflare R2 for the web UI to read. There's no application server enforcing access on the read path, so whoever can reach the R2 object gets exactly the ciphertext it contains, page by page over HTTP; confidentiality rests entirely on the key hierarchy rooted at `root_master_key` (see [crypto.md](crypto.md)), not on R2 access being restricted.
- The credentials file (containing the base64 `root_master_key`) must be kept secret and out of version control, same as before. Anyone who has it can unwrap every user's `umk` and therefore every file, regardless of owner.
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

## R2 distribution caveats

- There is no server enforcing "only decrypt what this session's token allows" — whatever key material (a user's `umk`, or `root_master_key`) the browser/CLI holds determines what it can decrypt, per the hierarchy above. All access control is client-side and trust-dependent on which key(s) that session actually has.
- **Whether the R2 object itself needs access control (signed URLs, a bucket policy, etc.) is an open decision, not yet made.** Ciphertext confidentiality doesn't depend on R2 being private — the content stays encrypted either way — but if the object is fully public, anyone can download the whole `.db` (or fetch arbitrary ranges of it) without ever needing `root_master_key`. That's not a break of content confidentiality, but it is a meaningfully different exposure than "an attacker needs to find the file on someone's disk."
- **Paged HTTP reads can leak access patterns that a single local file wouldn't.** Every query becomes one or more `Range` GET requests against R2; anyone who can observe that traffic (R2's own access logs, a network intermediary, a CDN in front of it) sees the byte ranges and timing of requests, even though the payload itself is ciphertext. Ranges roughly correspond to which SQLite pages — and therefore which rows/tables — are being touched, so coarse query patterns (e.g. "this session is repeatedly hitting the same file's `txt_parts` rows" vs. "this session just fetched `umk_store` once at login") are visible to whoever can see that traffic, even without decrypting anything. This is a real, if minor, form of metadata leakage the previous local-file-only design didn't have.
