# Docker

Container image for one rqlite node, fronted by OpenResty acting as the "OpenResty auth layer" docs/data_model.md's page-store schema assumes: it resolves each request's API key to a `{user_id, role}` identity and injects `db_id` server-side, since rqlite itself has no row-level ACLs.

## Files

- **`Dockerfile`** — `alpine:edge` base; installs `rqlited`/`rqlite`/`rqbench` (pinned via `ARG RQLITE_VERSION`, default `10.2.7`) and `openresty` (Alpine's own `community` repo package, not openresty.org's separate apk repo). Also creates the unprivileged `rqlite` user (uid/gid 1000) rqlited actually runs as.
- **`entrypoint.sh`** — unmodified from the reference project. Assembles `rqlited`'s flags from `-*` args or env vars (`NODE_ID`, `HTTP_ADDR`, `RAFT_ADDR`, `RQLITE_BACKUP_CONF`, `SQLITE_EXTENSIONS`, `ENABLE_FK`, ...), renders `nginx.conf` through `envsubst` (restricted to `$NGINX_HTPASSWD` only, so nginx's own `$host`/`$remote_addr`/etc. pass through untouched), starts OpenResty (Alpine's `openresty` package installs its nginx binary as `/usr/sbin/nginx`, so this needs no changes for the OpenResty swap), then `exec su-exec rqlite rqlited ...` — rqlited is the only process that drops root.
- **`nginx.conf`** — OpenResty config for the container's external port 4001. `auth_basic` (shared htpasswd) gates the whole server as a coarse perimeter check; `location ~ ^/db/(query|execute)$` additionally runs `auth_perms.lua` before proxying to rqlite's real HTTP API on `127.0.0.1:14001`; everything else (`/status`, `/readyz`, `/nodes`, `/db/backup`, `/db/load`, ...) falls through the plain `location /` passthrough, still behind `auth_basic` but without the Lua rewrite, since `auth_perms.lua` only understands the `{statementId, batch}` envelope, not rqlite's native request shapes. `location /internal/rqlite/` is the Lua script's own internal-only route back into rqlite for its auth lookup.
- **`auth_perms.lua`** — the auth layer itself; see [below](#auth_permslua) for detail.
- **`backup.conf.json.example`** — example `-auto-backup` config for rqlited (rqlite's own JSON schema, not something this project defines): periodic S3 upload of the whole `rqlite_txt.db`. Copy it, fill in the `$VAR` placeholders (or point `RQLITE_BACKUP_CONF` env var at a rendered version), and pass the result via `RQLITE_BACKUP_CONF`.

## `auth_perms.lua`

Runs as `access_by_lua_file` on the `location ~ ^/db/(query|execute)$` block only — see `nginx.conf` above — so it never has to handle anything other than the envelope it defines. It replaces rqlite's native request body with rqlite's own, and lets nginx's existing `proxy_pass` forward the rewritten body on unchanged; it doesn't touch the URI or the response.

**Request envelope.** The client never sends raw SQL. It sends:

```json
{ "statementId": "READ_PAGE", "batch": [ { "page_no": 3, "snapshot": 42 } ] }
```

or, for a commit (its own shape, not a `batch`, since it's one guarded multi-row insert + one CAS update, not N repetitions of a template):

```json
{
  "statementId": "COMMIT",
  "commit": {
    "old_version": 41,
    "new_version": 42,
    "page_count": 17,
    "pages": [ { "page_no": 3, "data": "<page ciphertext>" }, ... ]
  }
}
```

Admins add one more field, `target_db_id`, to act on a tenant other than themselves — see the dispatch table below.

**Auth.** `Authorization: Bearer <raw key>` is hashed the same way `api_keys.key_hash` is derived — `base64(SHA3-256(raw key))` via `resty.openssl.digest` (bundled by Alpine's `openresty` package; no separate `opm install` needed) — never the sha256/hex a stock `ngx_lua` helper would give you. The hash (never the raw key) is looked up against `api_keys JOIN users` through the internal `/internal/rqlite/db/query` location, filtered to `revoked_at IS NULL AND disabled = 0`, and the resulting `{user_id, role}` is cached in `ngx.shared.auth_cache` for 60 seconds — this is also why a revoked key can stay "valid" for up to a minute after revocation, per docs/data_model.md's own note about the auth-cache TTL.

**Dispatch table.**

| statementId | who | forces | notes |
|---|---|---|---|
| `READ_PAGE` | user | `db_id` = caller | latest page version at or before `snapshot` |
| `COMMIT` | user | `db_id` = caller | guarded INSERT + CAS UPDATE, one atomic rqlite batch |
| `READ_PAGE` / `COMMIT` | admin | `db_id`/`target_db_id` = `body.target_db_id` (required) | admin acting *as* a tenant must name one explicitly — no implicit self |
| `LIST_USERS` | admin | *(none — not tenant-scoped)* | `:limit`/`:offset` come from the client batch item |
| `REVOKE_KEY` | admin | `target_user_id` = `target_db_id`, `now` = `ngx.now()*1000` | `now` is server time, deliberately never client-supplied |
| `FORCE_GC` | admin | `target_db_id` = `body.target_db_id` | sets `db_meta.needs_gc = 1` |
| `INSPECT_META` | admin | `target_db_id` = `body.target_db_id` | reads one tenant's `db_meta` row |

Each admin statement's forced fields come from its own `forced_params` function rather than one field stamped onto every query — `LIST_USERS` isn't tenant-scoped at all, so it gets nothing forced.

**Validation.** `require_batch`/`require_commit` reject an empty/missing `batch` or `commit.pages`, and a `commit` missing `old_version`/`new_version`/`page_count`, with a clean `400` before any SQL is built — rather than letting rqlite receive `VALUES ()` or a Lua nil-index error surface as a bare `500`.

**Logging.** Every rejection (`fail(status, reason)`) logs the reason via `ngx.log` — `WARN` for 4xx, `ERR` for 5xx — under the `auth_perms:` prefix, and the file also logs auth-cache hit/miss, the resolved `{role, user_id} -> statementId` for every accepted request, and each commit's `db_id`/page count/version transition at `INFO`. Never logs the raw key or, deliberately, the key hash either — only whatever it already resolved to.

**Known gaps** (see the comment block at the top of the file): no `active_readers` snapshot-lease management yet (so GC's watermark calc has nothing to protect a long-running reader from), no audit logging of admin actions (there's no `audit_log` table in docs/data_model.md — adding one is a schema decision, not something to invent silently here), and `page.data`'s wire encoding (base64 or otherwise) isn't yet pinned down or decoded before being placed in the positional params array sent to rqlite.

## Build & run

```
docker build --build-arg RQLITE_VERSION=10.2.7 -t txt-rqlite docker/
docker run -p 4001:4001 -p 4002:4002 \
  -e NGINX_USER=admin -e NGINX_PASSWORD=<shared secret> \
  -v rqlite-data:/rqlite/file/data \
  txt-rqlite
```

`NGINX_USER`/`NGINX_PASSWORD` are required — without both, `entrypoint.sh` never creates `/etc/nginx/.htpasswd`, and `auth_basic` (mandatory on the whole server block) will fail every request, including `auth_perms.lua`'s own internal auth lookup.

Per-tenant access is separate from that shared basic-auth secret: each real client authenticates with its own API key (`Authorization: Bearer <raw key>`), issued and hashed into `api_keys.key_hash` the way `txt.ts --migrate` does it — see the root [README.md](../README.md) and [docs/data_model.md](../docs/data_model.md).
