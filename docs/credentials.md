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
| `turso_auth_token` scope | read-write | read-only |

- **`AdminCreds`** requires `r2_config.read_write_access_key_id`/`read_write_secret_access_key` — the admin CLI (`txt.py --init`) provisions accounts and schema directly, so it needs full R2 access. `txt/creds.py` raises `ValueError` if either is missing.
- **`UserCreds`** requires those same two fields to be *absent* — so a leaked or misconfigured user credential file can't carry R2 write access it isn't supposed to have. `txt/creds.py` raises `ValueError` if either is present.

## Turso token scope is whole-database, not per-table

Turso auth tokens only scope the *entire* database as read-only or read-write — there is no per-table grant. So while the admin's token is read-write everywhere, a regular user's token being "read-only, except read-write on `txt_access` and `bookmarks`" (their own read-position and bookmark list; see data_model.md) can't be expressed by the token itself — a read-only Turso token rejects all writes, including to those two tables.

That per-table exception has to be enforced by an application layer sitting in front of a read-only Turso connection (e.g., a small mediating endpoint that accepts only `txt_access`/`bookmarks` writes for the authenticated user). This codebase doesn't implement that mediation layer yet — `UserCreds` only loads and validates the credential shape above; nothing in `txt/` currently establishes a user-role database connection at all (only the admin `--init` flow exists so far).
