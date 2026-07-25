# Credentials

Two roles load credentials from a per-user JSON config file — `admin_cred_template.json` for the admin role, `user_cred_template.json` for everyone else — held entirely client-side (or in admin tooling), never in Turso. `txt/creds.py` defines the shapes and validates them: `AdminCreds`/`UserCreds`, both built on a shared `Creds` base and an `R2Config` for the R2 fields.

## Shared fields

- `turso_database_url` / `turso_auth_token` — this role's Turso connection info.
- `username` — the login handle. `users.username_hash = HMAC-SHA3-256(username_lookup_key, username)` (see data_model.md) is looked up by this value, not by `display_name`, which is just a UI label.
- `password` — this role's login password, read straight from the credential file rather than prompted for interactively. `AdminInitializer` runs it through `PBKDF2-HMAC-SHA3-256(password, pw_salt)` to produce `users.pw_hash` (see data_model.md's Login flow); it is never used as IKM anywhere in the key hierarchy.
- `username_lookup_key`, `user_root_key` — per-user config secrets (see data_model.md's Key Hierarchy).
- `r2_config` — Cloudflare R2 connection info for reading/writing `txt_parts.path` objects. Every role gets a read-only key pair (`read_only_access_key_id`/`read_only_secret_access_key`). The web UI (`ui/`) is a browser client, not server-side tooling, so its R2 GETs are subject to the bucket's CORS policy — see [deployment.md](deployment.md) for the policy it needs (R2 buckets have none by default).
- `slhdsa_256f_priv_key`, `asset_base_url` — used only by `ui/scripts/build-integrity.mjs` (`npm run build -- --admin-creds <path>`), not by `txt/creds.py`. `slhdsa_256f_priv_key` is the SLH-DSA-SHA2-256f secret key that script signs `ui/dist/`'s asset manifest with — left empty, the script generates one on first run and writes it back here; once set, it's reused indefinitely, since regenerating it would invalidate every `creds/local_index.html` already handed out. `asset_base_url` is the public URL the built assets are actually served from, embedded (along with the derived public key) into `creds/local_index.html` itself. Colocating both in the same file `txt.py` reads is a convenience — one credential file doubles as this role's `Creds` input, the UI's own R2/Turso config, and this build step's input — not a requirement any side imposes on the other. See [local_index.md](local_index.md) for what these are for.

## Role differences

| | `AdminCreds` | `UserCreds` |
|---|---|---|
| `r2_config` read-write key pair | required | must be absent |
| `turso_auth_token` scope | full access (every table, every verb) | `data_read` everywhere; `data_read`/`data_add`/`data_update` on `txt_access`/`bookmarks` only |

- **`AdminCreds`** requires `r2_config.read_write_access_key_id`/`read_write_secret_access_key` — the admin CLI (`txt.py --init`) provisions accounts and schema directly, so it needs full R2 access. `txt/creds.py` raises `ValueError` if either is missing.
- **`UserCreds`** requires those same two fields to be *absent* — so a leaked or misconfigured user credential file can't carry R2 write access it isn't supposed to have. `txt/creds.py` raises `ValueError` if either is present.

## Turso token scope: fine-grained, per-table permissions

Turso auth tokens aren't limited to whole-database read-only/read-write — its [fine-grained permission system](https://docs.turso.tech/sdk/authorization/fine-grained-permissions) grants specific verbs (`data_read`, `data_add`, `data_update`, `data_delete`, and the schema-equivalents `schema_add`/`schema_update`/`schema_delete`) per table, via repeated `-p <table>:<verb1>,<verb2>` flags when minting a token (`turso db tokens create <db> -p ...`, or `all:<verbs>` for every table at once). This is what actually lets a `UserCreds` token be "read-only, except read-write on two specific tables," expressed directly in the token itself:

- `data_read` on every table a browser session queries to unlock and browse the vault — `users`, `umk_store`, `r2_config`, `txt`, `txt_parts`, `part_count`, `txt_metadata`, `key_store`, `txt_shares` (see `ui/src/data/` and data_model.md's schema). CRUD on all of these — creating/altering/deleting rows in `txt`, `txt_shares`, and everything else — is `AdminCreds`-only; a regular user's token simply carries no `data_add`/`data_update`/`data_delete`/`schema_*` grant on them at all, so an attempt fails at the Turso layer regardless of what the app code does.
- `data_read,data_add,data_update` on `txt_access`/`bookmarks` only — the two tables a regular user's own session writes to directly (read position and bookmarks). `data_add` covers `ui/src/data/perUserBlob.ts`'s lazy-init `INSERT` (reached only if `--init` hasn't already created the row); `data_delete` isn't needed since neither table's row is ever deleted client-side, only its blob content overwritten in place via `UPDATE`.

An `AdminCreds` token gets every verb on every table (`-p all:data_read,data_add,data_update,data_delete,schema_add,schema_update,schema_delete`) — the same role that already needs full R2 read-write, since `txt.py --init`/`--txt-ingest`/etc. provision accounts and schema directly.

**This scopes tables, not rows.** Turso's own docs are explicit that fine-grained permissions have no row-level dimension — a `UserCreds` token with `data_read` on `txt` can read *any* row in that table, not just rows belonging to the account the token was minted for. Row-level isolation still depends entirely on the app's own `WHERE user_id = ?` (or `WHERE id = ? AND user_id = ?`) predicates in every query, plus the envelope-encryption key hierarchy underneath — a scoped-but-unfiltered read still can't decrypt another user's content, since it's wrapped under a key this token's own `umk` can't unwrap. Neither layer is optional: the token narrows which *tables* a compromised credential file can touch at all; the query scoping and encryption narrow what it can actually see and use within an allowed table.

## How a client knows its own role

There's no `role` column on `users` (data_model.md's schema doesn't need one) — which role a given session has is entirely a client-local, load-time fact, not something looked up from the database. Every person gets their own distinct credential file (own `username`/`password`/`user_root_key`/Turso token baked in — the web UI's Unlock screen is a file picker, not a login form, per `ui/src/screens/Unlock/UnlockScreen.tsx`), and that file's shape (`AdminCreds` vs. `UserCreds`) plus its embedded Turso token's actual grants are what determine what this session can do. Turso enforces those grants independent of any app-level check, so nothing client-side needs to (or safely could) decide "is this an admin" by querying `users` — a compromised or buggy check couldn't grant a token permissions it wasn't minted with in the first place.
