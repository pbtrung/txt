# Security

## Threat model

- The `.db` file is the only thing that leaves the trust boundary of the machine running the CLI or the browser tab — it's a local file, not a server, so there's no separate access-control layer like an account/token model to lean on. Anyone who obtains the `.db` file gets exactly the ciphertext it contains; confidentiality rests on the key hierarchy rooted at `root_master_key` (see [crypto.md](crypto.md)).
- The credentials file (containing the base64 `root_master_key`) must be kept secret and out of version control, same as before. Anyone who has it can unwrap every user's `umk` and therefore every file, regardless of owner.
- Compression happens before encryption, everywhere, to avoid compression-oracle attacks.

## `user_id` is now a real cryptographic boundary, rooted at `root_master_key`

Per the key hierarchy in [crypto.md](crypto.md), each user's files are wrapped under that user's own `umk`, and each `umk` is itself wrapped under `root_master_key`. Concretely:

- Holding one user's `umk` unwraps that user's `txt_key`s and `txt_metadata` (their file content *and* their filenames) but **not** another user's `umk`, files, or filenames. This is real per-user envelope encryption, not an application-layer label.
- Holding `root_master_key` unwraps every user's `umk`, and therefore every file and filename — it remains the single point of total compromise. Anyone with the credentials file has this.

So: per-user isolation holds for both file content and filenames against anything short of `root_master_key`.

## Filename confidentiality changed shape

Previously, each filename had its own salt and an HMAC-based blind index for O(row) dedup lookups without decrypting every name. Now each user has one `txt_metadata` row holding only their own filenames:

- Upside: filenames are now per-user isolated (see above), and within a user's own blob, individual name lengths are hidden inside one aggregate ciphertext rather than each having its own row/size.
- Downside: there is no more blind-index lookup; any dedup check requires decrypting that user's whole `txt_metadata` row (the CLI already holds the keys needed to do this for the user it's ingesting as, so this is not a new capability being granted, just a different code path — see [crypto.md](crypto.md)/[data_model.md](data_model.md)).

## Local-file distribution caveats

Since this is a local file rather than a hosted database:

- There is no server enforcing "only decrypt what this session's token allows" — whatever key material (a user's `umk`, or `root_master_key`) the browser/CLI holds determines what it can decrypt, per the hierarchy above. All access control is client-side and trust-dependent on which key(s) that session actually has.
- If the file is synced via some external mechanism (USB drive, shared folder, etc.) that is outside this app's control and outside this document's scope.
