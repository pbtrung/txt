# Docker

Container image for one rqlite node, fronted by OpenResty acting as the "OpenResty auth layer" docs/data_model.md's page-store schema assumes: it resolves each request's API key to a `{user_id, role}` identity and injects `db_id` server-side, since rqlite itself has no row-level ACLs.

## Files

- **`Dockerfile`** — `alpine:edge` base; installs `rqlited`/`rqlite`/`rqbench` (pinned via `ARG RQLITE_VERSION`, default `10.2.7`) and `openresty` (Alpine's own `community` repo package, not openresty.org's separate apk repo). Also creates the unprivileged `rqlite` user (uid/gid 1000) rqlited actually runs as. `HEALTHCHECK` polls rqlited's own `/readyz` directly on its internal `127.0.0.1:14001` (bypassing nginx/`auth_basic` entirely) every 30s -- `/readyz` covers node/leader/store health, not just "is the process up," so it would have caught the earlier stuck-Raft-identity ("not leader") failure automatically. Assumes the default nginx-fronted deployment; running with `NGINX_CONF=""` or a custom `-http-addr` needs its own `--health-cmd` override.
- **`entrypoint.sh`** — unmodified from the reference project. Assembles `rqlited`'s flags from `-*` args or env vars (`NODE_ID`, `HTTP_ADDR`, `RAFT_ADDR`, `RQLITE_BACKUP_CONF`, `SQLITE_EXTENSIONS`, `ENABLE_FK`, ...), renders `nginx.conf` through `envsubst` (restricted to `$NGINX_HTPASSWD` only, so nginx's own `$host`/`$remote_addr`/etc. pass through untouched), starts OpenResty (Alpine's `openresty` package installs its nginx binary as `/usr/sbin/nginx`, so this needs no changes for the OpenResty swap), then `exec su-exec rqlite rqlited ...` — rqlited is the only process that drops root.
- **`nginx.conf`** — OpenResty config with two server blocks. Port 4001: the page-store API. `auth_basic` (shared htpasswd) gates the server block as a coarse perimeter check, but is switched back `off` on `location ~ ^/db/(query|execute|request)$`, which instead runs `auth_perms.lua` before proxying to rqlite's real HTTP API on `127.0.0.1:14001` — HTTP allows only one `Authorization` header per request, so a client's `Bearer <key>` (what the Lua script needs) can never also satisfy `auth_basic`'s `Basic <creds>` there, and leaving `auth_basic` on that location would reject every real client before the Lua script ever ran. `location = /healthz`, also `auth_basic off`, is a dedicated unauthenticated proxy to rqlite's own `/readyz`, for external platform health checks that can't supply Basic auth -- see [below](#external-health-checks). Everything else (`/status`, `/readyz`, `/nodes`, `/db/backup`, `/db/load`, ...) falls through the plain `location /` passthrough, still behind `auth_basic`, since `auth_perms.lua` only understands the `{statementId, batch}` envelope, not rqlite's native request shapes. `location /internal/rqlite/` is the Lua script's own internal-only route back into rqlite for its auth lookup, also `auth_basic off` since it's `internal;` (unreachable from outside) and otherwise inherits the same client `Authorization: Bearer` header that would trip `auth_basic` there too. Port 4002: public static hosting for the built `ui/` app -- see [below](#serving-ui).
- **`auth_perms.lua`** — the auth layer itself; see [below](#auth_permslua) for detail.
- **`backup.conf.json.example`** — example `-auto-backup` config for rqlited (rqlite's own JSON schema, not something this project defines): periodic S3 upload of the whole `rqlite_txt.db`. Copy it, fill in the `$VAR` placeholders (or point `RQLITE_BACKUP_CONF` env var at a rendered version), and pass the result via `RQLITE_BACKUP_CONF`.

## `auth_perms.lua`

Runs as `access_by_lua_file` on the `location ~ ^/db/(query|execute|request)$` block only — see `nginx.conf` above — so it never has to handle anything other than the envelope it defines. It replaces rqlite's native request body with rqlite's own, and lets nginx's existing `proxy_pass` forward the rewritten body on unchanged; it doesn't touch the URI or the response.

**Request envelope.** An ordinary user never sends raw SQL. They send:

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

Admins add one more field, `target_db_id`, to act on a tenant other than themselves — see the dispatch table below. Admins also have one statement that *is* raw SQL, `RAW_QUERY` — see below.

**Auth.** `Authorization: Bearer <raw key>` is hashed the same way `api_keys.key_hash` is derived — `base64(SHA3-256(raw key))` via `resty.openssl.digest` (bundled by Alpine's `openresty` package; no separate `opm install` needed) — never the sha256/hex a stock `ngx_lua` helper would give you. The hash (never the raw key) is looked up against `api_keys JOIN users` through the internal `/internal/rqlite/db/query` location, filtered to `revoked_at IS NULL AND disabled = 0`, and the resulting `{user_id, role}` is cached in `ngx.shared.auth_cache` for 60 seconds — this is also why a revoked key can stay "valid" for up to a minute after revocation, per docs/data_model.md's own note about the auth-cache TTL.

**Dispatch table.**

| statementId | who | forces | notes |
|---|---|---|---|
| `READ_PAGE` | user | `db_id` = caller | latest page version at or before `snapshot` |
| `GET_META` | user | `db_id` = caller | read-only `current_version`/`page_count`/`page_size` for the caller's own db -- no admin needed just to open your own file |
| `COMMIT` | user | `db_id` = caller | guarded INSERT + CAS UPDATE, one atomic rqlite batch |
| `READ_PAGE` / `GET_META` / `COMMIT` | admin | `db_id`/`target_db_id` = `body.target_db_id` (required) | admin acting *as* a tenant must name one explicitly — no implicit self |
| `LIST_USERS` | admin | *(none — not tenant-scoped)* | `:limit`/`:offset` come from the client batch item |
| `REVOKE_KEY` | admin | `target_user_id` = `target_db_id`, `now` = `ngx.now()*1000` | `now` is server time, deliberately never client-supplied |
| `FORCE_GC` | admin | `target_db_id` = `body.target_db_id` | sets `db_meta.needs_gc = 1` |
| `INSPECT_META` | admin | `target_db_id` = `body.target_db_id` | reads one tenant's whole `db_meta` row (`SELECT *`, includes `needs_gc`); `GET_META` is the read-only, non-admin subset of the same row |
| `RAW_QUERY` | admin | *(none — no db_id, no template)* | literal SQL text per batch item; see below |

Each admin statement's forced fields come from its own `forced_params` function rather than one field stamped onto every query — `LIST_USERS` isn't tenant-scoped at all, so it gets nothing forced.

**`RAW_QUERY`** is deliberately unrestricted, unlike everything else in the dispatch table: it exists because "admin can run any query" has no safe way to auto-scope arbitrary SQL text to one tenant the way every other statement here forces `db_id`. Its trust boundary is the admin role itself, not this file — an admin key can read or write any table, any row. It's the one statement type ordinary users can never reach, at any status code other than the same `unknown statementId` `400` any other bogus `statementId` gets. Each `batch` item is `{ "sql": "<text>" }`, optionally with `"params": {...}` (named, `:name` placeholders) or `"args": [...]` (positional, `?` placeholders) — never both on the same item:

```json
{
  "statementId": "RAW_QUERY",
  "batch": [
    { "sql": "SELECT user_id, role FROM users" },
    { "sql": "SELECT * FROM db_meta WHERE db_id = :id", "params": { "id": "<user_id>" } },
    { "sql": "UPDATE users SET disabled = ? WHERE user_id = ?", "args": [1, "<user_id>"] }
  ]
}
```

POST to `/db/query` for reads, `/db/execute` for writes — same as every other statement, `auth_perms.lua` doesn't care which endpoint URI it's proxied through beyond the location match. Every `RAW_QUERY` item's SQL text is logged at `WARN` (not the `INFO` everything else here uses), specifically so it survives `nginx.conf`'s default `error_log ... warn` level without any config change — the one place in this file worth an audit trail even without a dedicated `audit_log` table.

**Validation.** `require_batch`/`require_commit` reject an empty/missing `batch` or `commit.pages`, and a `commit` missing `old_version`/`new_version`/`page_count`, with a clean `400` before any SQL is built — rather than letting rqlite receive `VALUES ()` or a Lua nil-index error surface as a bare `500`.

**Logging.** Every rejection (`fail(status, reason)`) logs the reason via `ngx.log` — `WARN` for 4xx, `ERR` for 5xx — under the `auth_perms:` prefix, and the file also logs auth-cache hit/miss, the resolved `{role, user_id} -> statementId` for every accepted request, and each commit's `db_id`/page count/version transition at `INFO`. Never logs the raw key or, deliberately, the key hash either — only whatever it already resolved to.

**Known gaps** (see the comment block at the top of the file): no `active_readers` snapshot-lease management yet (so GC's watermark calc has nothing to protect a long-running reader from), no audit logging of admin actions to the database itself (there's no `audit_log` table in docs/data_model.md — adding one is a schema decision, not something to invent silently here; `RAW_QUERY`'s `WARN`-level log line is a stopgap, not a replacement), and `page.data`'s wire encoding (base64 or otherwise) isn't yet pinned down or decoded before being placed in the positional params array sent to rqlite.

## Build & run

```
docker build --build-arg RQLITE_VERSION=10.2.7 -t txt-rqlite docker/
docker run -p 4001:4001 -p 4002:4002 \
  --hostname txt-rqlite \
  -e NGINX_USER=admin -e NGINX_PASSWORD=<shared secret> \
  -v rqlite-data:/rqlite/file/data \
  -v $(pwd)/ui/dist:/var/www/ui:ro \
  txt-rqlite
```

The `ui/dist:/var/www/ui` mount is optional -- omit it (or point it at an
empty directory) if this deployment doesn't serve the browser app at all.
Build `ui/dist/` first with `npm run ui:build` (see [below](#serving-ui)) --
it's a separate, ordinary static-asset build with no dependency on this
image, not something baked into it, so this Dockerfile stays focused on
rqlite+OpenResty and doesn't need its own Node build stage.

`NGINX_USER`/`NGINX_PASSWORD` are required — without both, `entrypoint.sh` never creates `/etc/nginx/.htpasswd`, and `auth_basic_user_file` (referenced at the server block level, so it must exist even though `location /db/...` and `location /internal/rqlite/` switch `auth_basic off`) will fail every request still gated by it, i.e. the `location /` passthrough.

`--hostname` is required too, for a reason that only bites on a *second* run: `entrypoint.sh` (unmodified from the reference project) derives `-node-id` from `hostname` and the Raft/HTTP advertised addresses from `hostname -f` whenever `NODE_ID`/`HTTP_ADV_ADDR`/`RAFT_ADV_ADDR` aren't set explicitly. Docker assigns a fresh random hostname to every new container, so recreating the container without a fixed `--hostname` (or those env vars) changes this node's Raft identity on every `docker run`. rqlite's own clustering guide is explicit that a node's ID "shouldn't change, once chosen," and that recovering from a changed address requires "a quorum (at least) of nodes up and running" *besides* the one whose identity changed -- a single node has no such quorum, so once its identity drifts it can never re-elect itself leader against its own persisted configuration again (surfaces as a permanent "not leader" error on every write/restore). Keep `--hostname` (or `-e NODE_ID=...`) fixed across every recreation of this container, not just its first run, and prefer `docker start` on the same container over re-running `docker run` where possible.

## Serving `ui/`

Port 4002 is a second, separate server block: plain static hosting for `ui/dist/` (the browser app -- `docker build`/`ui:build`/... at the [repo root](../package.json)), unauthenticated (there's nothing tenant-scoped in a static JS/CSS bundle) and cross-origin-isolated:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: credentialless
```

This is what makes `SharedArrayBuffer` available at all -- `ui/src/data/remotePageClient.ts`'s lazy-VFS page fetching bridges a synchronous WASM VFS callback to a real `Worker` via `SharedArrayBuffer`/`Atomics.wait`, and browsers only expose `SharedArrayBuffer` to a page that's cross-origin isolated. `credentialless`, not the stricter `require-corp`: `require-corp` would also block the app's own cross-origin `fetch`es to the rqlite API (port 4001) and to R2, since neither service necessarily sends back a `Cross-Origin-Resource-Policy` header of its own.

Build the app first:

```
npm run ui:build
```

`ui:build` (see the root `package.json`) needs `ui/build-creds.json` -- a small, gitignored, deployment-owned config (`asset_base_url`, `rqlite_url`, and a `slhdsa_256f_priv_key` it generates and writes back on first use if absent), distinct from any end user's own vault creds file (`ui/src/data/creds.ts`'s `{rqlite_url, api_key, user_root_key, r2_config}` -- `rqlite_url` reuses that same field name for the same concept, even though this is a separate, deployment-level fact). `rqlite_url`'s origin backs `dist/_headers`' CSP `connect-src`. Defaults to that path; point it at a different file with `npm run ui:build -- path/to/creds.json` (or `--build-creds path/to/creds.json`) -- either way, a missing `slhdsa_256f_priv_key` in that file gets generated and written back, an existing one is always reused. See `ui/scripts/build-integrity.mjs`'s own header comment for exactly what each field does.

**`local_index.html`** (written to `creds/local_index.html`, never `dist/`) is meant to be opened from this same cross-origin-isolated origin now -- `https://<host>:4002/../local_index.html` or wherever it's placed alongside the served assets -- not via a bare `file://` path. That's a deliberate change from the file-based design this project's crypto layer otherwise still supports: a `file://` document can never be cross-origin isolated, so it could verify the signed manifest and inline the verified JS, but the app it booted would have no working lazy VFS. Serving it over real HTTP still defends against the threat this mechanism actually targets -- a compromised or MITM'd asset CDN/`asset_base_url` -- just not literal air-gapped, network-disconnected verification.

## External health checks

`GET /healthz` (port 4001, no auth) proxies straight to rqlite's own `/readyz` and returns 200 only when rqlite reports its node, leader, and store are all healthy -- 401/403 (`auth_basic`) never gets in the way, since most external health-check systems (including Northflank's) send a plain unauthenticated `GET` and only accept 200-399 as healthy, with no way to attach a `Basic <creds>` header.

For [Northflank](https://northflank.com/docs/v1/application/observe/configure-health-checks), add a health check on the service (dashboard or API, not a repo file) with:

```json
{
  "protocol": "HTTP",
  "port": 4001,
  "path": "/healthz"
}
```

as a readiness probe (removes the service from traffic while rqlite has no leader, e.g. right after a restart or if `--hostname`/`NODE_ID` drifted -- see above) and/or a liveness probe (restarts the container if it stays unhealthy). Any other platform whose health check can't send auth headers can point at the same path the same way.

This is separate from `Dockerfile`'s own `HEALTHCHECK` instruction, which checks rqlite directly on its internal port and is a plain Docker/`docker-compose` mechanism (`docker inspect`, `depends_on: condition: service_healthy`, ...) that most PaaS platforms, Northflank included, don't read at all -- the two aren't redundant, they cover different consumers of the same underlying `/readyz` check.

Per-tenant access is separate from that shared basic-auth secret: each real client authenticates with its own API key (`Authorization: Bearer <raw key>`), issued and hashed into `api_keys.key_hash` the way `txt.ts --migrate` does it — see the root [README.md](../README.md) and [docs/data_model.md](../docs/data_model.md).
