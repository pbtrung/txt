# Security

## Threat model

- The web UI connects to InstantDB as a specific signed-in user, constrained by `instant.perms.ts`'s owner-only rules. The admin CLI connects with the InstantDB **admin** SDK, which bypasses those rules entirely — it is the new single trust tier that can touch any row for any user, the role `root_master_key`/the shared Turso token used to occupy.
- The admin CLI's local config (Firebase service-account credentials, the InstantDB admin token, and the `user_root_keys` keyring — see [crypto.md](crypto.md)) must be kept secret and out of version control. Anyone who has it can unwrap every user's `umk` (via the keyring) and, separately, read/write/delete any row via the InstantDB admin token, regardless of whose data it is. This is the same shape of risk `creds.json` was before, just renamed and now excluding the browser entirely.
- Compression happens before encryption, everywhere, to avoid compression-oracle attacks — unchanged.

## `user_id` is a cryptographic boundary *and*, now, a real database boundary

Per the key hierarchy in [crypto.md](crypto.md), each user's `umk` is wrapped under a `user_root_key` unique to that user — not a shared secret. Concretely:

- Holding one user's `umk` unwraps that user's `txtKeyBlob`s, bookmarks, and `metadataStore` (their content *and* their filenames) but **not** another user's `umk` or anything of theirs. There is no sharing mechanism in this redesign, so there is no "unless explicitly shared with them" exception anymore either — see below.
- Holding one user's `user_root_key` unwraps only that user's `umk`. There is no longer a single secret that unwraps every user's `umk` at once — the admin CLI's keyring is a collection of per-user secrets, and compromising it end-to-end is a strictly worse outcome (total compromise), but compromising any *one* entry in it is not.
- **New relative to the Turso design**: `instant.perms.ts`'s `isOwner` rules mean a regular user's browser session cannot even *query* another user's `umkStore`/`txt`/`bookmarks`/`metadataStore` rows in the first place — this is enforced by InstantDB before any ciphertext is returned, not just by that ciphertext being unreadable without the right key. Per-user isolation now holds at two independent layers: the database won't hand over another user's rows, and even if it did, the crypto wouldn't unwrap them. See InstantDB access model below.

## Sharing was dropped, not just re-plumbed

The old design let an owner grant another user read access to a specific file (`txt_shares`), CLI-mediated, requiring `root_master_key`. This redesign's schema has no equivalent — `txt` links to exactly one `umkStore`, which links to exactly one `$users` row, `has: 'one'` all the way down (see [data_model.md](data_model.md)). This was a deliberate scope decision, not an oversight: the admin/user role split covers a good part of what sharing used to be needed for (an admin can already see and manage everything via the CLI), and dropping it removes an entire class of complexity (re-wrapped keys, revocation without forward secrecy, composite `(txt_id, user_id)` keys) that this redesign otherwise wouldn't need. If cross-user sharing is needed again later, it would have to be designed back in on top of this schema — see the "Keep sharing" alternative considered and declined during this redesign.

## Provisioning replaces sharing as the CLI-mediated trust boundary

Creating or deleting a user is now the CLI-mediated, admin-trust-tier operation that sharing used to be (see [crypto.md](crypto.md)'s User Identity, Login, and Provisioning section):

- **Creating** a user requires the admin CLI's config (to create the Firebase account and mint an InstantDB token) — same trust tier as ingest. Anyone who can run `txt-admin users create` can provision an account for anyone; this isn't a new capability, just how the CLI's existing trust tier gets exercised.
- **Deleting** a user cascades through `onDelete: 'cascade'` and destroys their `umkStore`/`txt`/`$files` outright — there is no soft-delete or grace period documented here.
- **Whether an already-delivered `{ instant_token, user_root_key }` bundle can be invalidated short of deleting the user is currently unverified against InstantDB's actual admin SDK.** This doc deliberately does not assert a specific revocation API exists — see [crypto.md](crypto.md)'s note on this, and treat "can we lock someone out without wiping their data" as an open question until it's checked against the real SDK, not a solved problem.

## Firebase login is not what authorizes ongoing access — call this out plainly

After the one-time bootstrap (see [crypto.md](crypto.md)), the browser persists `{ instant_token, user_root_key }` in local storage and reuses them on every later visit. Firebase login is checked again each visit as an app-level "are you still you" gate, but it is **not** re-derived into anything that actually authorizes InstantDB access — the persisted token and key are what do that, independent of Firebase session state. Practically: someone who extracts those two values from browser storage (XSS, a compromised extension, physical access to an unlocked/unencrypted profile) has everything they need to impersonate that user's InstantDB session without ever touching Firebase again. This is the same category of trade-off the old design had with the Turso token living in browser storage — narrower now (scoped to one user instead of every user), but not eliminated. Firebase Auth's real value here is at *provisioning* time (proving identity before the admin hands out a bundle) and as a UI-level access gate, not as an ongoing cryptographic control.

## Bookmark cap is client-enforced, not database-enforced

The old 12-bookmarks-per-entry cap was a SQL trigger; InstantDB has no server-side triggers, so it's now enforced by the client bundling a delete-of-the-oldest into the same transaction as an insert (see [data_model.md](data_model.md)). A user who bypasses their own client can exceed the cap for themselves — `isOwner` still prevents them from touching anyone else's bookmarks, so the blast radius of skipping this invariant is limited to the bypassing user's own data, not a shared resource.

## Filename confidentiality is the same shape as before, renamed

Each user has one `metadataStore` row (plus its linked `$files` content) holding only their own filenames, encrypted under a `metadataKey` wrapped under their `umk` — same upside (filenames per-user isolated, individual name lengths hidden inside one aggregate ciphertext) and same downside (no blind-index lookup; a dedup check requires decrypting that user's whole metadata index) as the old `txt_metadata` design. The admin CLI already holds the keys needed to do this for the user it's ingesting on behalf of, same as before.

## InstantDB access model

- `instant.perms.ts`'s `isOwner` rules are evaluated by InstantDB itself before returning any row — a regular user's browser session is bound by them unconditionally. This is a **genuine improvement** over the old Turso design, where a single full-access token meant *zero* database-layer containment: a compromised browser session there could read, modify, or delete any row for any user, encryption or no encryption. Here, a compromised regular-user session is contained to that one user's rows at the database layer, in addition to whatever the crypto layer already isolated.
- The admin CLI's InstantDB admin token is the one credential that still bypasses all of this — same category of risk the shared Turso token was, just narrowed to whoever holds the admin CLI's config rather than whoever holds `creds.json` (which, before, was both the CLI *and* every browser session).
- Query/access patterns are still visible to InstantDB's own infrastructure (and, transitively, to R2 for file fetches) the same way they were visible to Turso before — which rows a session queries, when a provisioning operation touches a given user's `umkStore`, are legible metadata even though the values themselves are ciphertext. This caveat is unchanged in kind from before, just relocated to a different provider.
