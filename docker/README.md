# OpenResty and rqlite container

This image runs the single `txt` control database and OpenResty in one
Northflank service. rqlite listens only on `127.0.0.1:14001`; OpenResty is the
only public process and listens on port `8080`. The Raft port remains available
for rqlite itself but does not need a public Northflank route for the one-node
deployment.

The container has exactly one application owner. The Basic-auth operator route
is for schema installation, diagnostics, and recovery; it is not an account or
end-user API.

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
`RQLITE_ADMIN_USERNAME` and `RQLITE_ADMIN_PASSWORD`. Do not embed these
credentials in the browser. The route exists for controlled schema migration,
backup, restore, and inspection.

Application endpoints are added by the Lua gateway. They use fixed,
parameterized rqlite statements and never expose arbitrary SQL.

## Backups

`backup.conf.json.example` uses rqlite's native S3-compatible automatic backup
support to write a hot backup to the private `control-backups/` R2 prefix.
Render a secret-backed copy outside the repository and set
`RQLITE_BACKUP_CONF` to its mounted path. The owner-facing R2 credentials must
not have access to this prefix.
