# OpenResty and rqlite container

This image runs the single `txt` control database and OpenResty in one
Northflank service. rqlite listens only on `127.0.0.1:14001`; OpenResty is the
only public process and listens on port `8080`. The Raft port remains available
for rqlite itself but does not need a public Northflank route for the one-node
deployment.

The container has exactly one application owner. The Basic-auth operator route
is for owner unlock reads, schema installation, diagnostics, and recovery; it
is not a user-management API.

## Build and run

```sh
docker build --build-arg RQLITE_VERSION=10.2.7 -t txt-control docker/
docker run --rm \
  --hostname txt-control-1 \
  -p 8080:8080 \
  -e RQLITE_ADMIN_USERNAME=operator \
  -e RQLITE_ADMIN_PASSWORD='replace-me' \
  -v txt-rqlite:/rqlite/file \
  txt-control
```

Keep `NODE_ID`, `HTTP_ADV_ADDR`, and `RAFT_ADV_ADDR` stable after the first
start. In Northflank, mount the persistent volume at `/rqlite/file`, expose
only port `8080` publicly, and use `/health/live` and `/health/ready` for
probes.

## Operator access

`/operator/rqlite/` proxies rqlite's native HTTP API behind
`RQLITE_ADMIN_USERNAME` and `RQLITE_ADMIN_PASSWORD`. The sole owner places these
credentials in the local seven-field UI unlock file; the UI uses them to read
the wrapped singleton row and retains them only in page memory. The same route
supports controlled schema migration, backup, restore, and inspection, so these
remain high-value operator secrets despite their owner-browser use.

Set the Python owner's `rqlite_operator_url` to this route without an API
method suffix. A local host-run CLI uses
`http://127.0.0.1:8080/operator/rqlite`; a Northflank deployment uses
`https://<public-service-domain>/operator/rqlite`. The credential file's
`rqlite_admin_username` and `rqlite_admin_password` must match the two container
variables above.

Browser responses from this route include `Access-Control-Allow-Origin` only
for the configured `UI_ORIGIN`. Values with a trailing slash, such as
`https://reader.example.com/`, are accepted; the entrypoint removes the slash
before rendering Nginx to match the browser's canonical `Origin` header. Do not
configure a URL path. Non-browser CLI tools may omit `Origin`.
Every `/v1/*` location is stricter: OpenResty returns `403` before Lua runs when
`Origin` is absent or differs from `UI_ORIGIN`.

The operator location accepts request bodies up to 128 KiB because owner
bootstrap sends KEM and signing BLOBs as rqlite JSON byte arrays. The global
16 KiB limit still applies to every application endpoint.

## Lua gateway

OpenResty serves the application API directly. Endpoint entrypoints live in
`lua/endpoints/` and are named after their behavior:

- `owner_keys.lua` validates the configured owner's Firebase token and returns
  wrapped owner material;
- `owner_r2_credentials.lua` verifies the owner ticket and P-521 proof;
- `create_share.lua` and `delete_share.lua` mutate the share registry;
- `shared_object_url.lua` returns an anonymous exact-object presigned URL;
- `readiness.lua` verifies that rqlite can answer a query, including before the
  first schema is installed.

Reusable modules under `lua/txt/` own Firebase certificate verification,
rqlite transport, durable rate limits, owner tickets and proofs, SigV4, and
response handling. There is no user lookup, role dispatch, administrator mode,
or raw-SQL application endpoint. Every authenticated route compares the
verified Firebase `sub` with `OWNER_FIREBASE_UID`.

Required Northflank variables and secrets:

```text
OWNER_FIREBASE_UID
FIREBASE_PROJECT_ID
UI_ORIGIN
R2_ENDPOINT
R2_BUCKET
R2_REGION
R2_READ_WRITE_ACCESS_KEY_ID
R2_READ_WRITE_SECRET_ACCESS_KEY
R2_TICKET_SECRET
RATE_LIMIT_KEY
SHARE_URL_TTL_SECONDS=60
RQLITE_ADMIN_USERNAME
RQLITE_ADMIN_PASSWORD
```

`R2_TICKET_SECRET` and `RATE_LIMIT_KEY` must be independent canonical padded
base64 values containing at least 32 random bytes. `DNS_RESOLVER` is optional
and defaults to `1.1.1.1`. No application-side `RQLITE_URL` or rqlite password
is needed by Lua because it reaches the loopback-only rqlite listener. The two
`RQLITE_ADMIN_*` secrets protect only the operator route used by the Python CLI
and the owner browser's wrapped-key lookup.

## Backups

`backup.conf.json.example` uses rqlite's native S3-compatible automatic backup
support to write a hot backup to the private `control-backups/` R2 prefix.
Render a secret-backed copy outside the repository and set
`RQLITE_BACKUP_CONF` to its mounted path. The owner-facing R2 credentials must
not have access to this prefix.
