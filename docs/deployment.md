# Northflank Deployment — Design

The deployment uses one always-on Northflank service with 0.2 shared vCPU and
512 MiB memory. Its custom image runs OpenResty and one rqlite node in the same
container. Only OpenResty is public; rqlite listens on loopback and stores data
on a persistent volume.

The React UI is deployed as static content on a CDN. R2 stores the owner's
encrypted SQLCipher database, immutable encrypted EPUBs, encrypted shared copies,
and protected rqlite backups.

## 1. OpenResty and rqlite service

1. Build and deploy `docker/Dockerfile` from this repository.
2. Assign one instance and a stable node ID, `txt-control-1`.
3. Attach a single-read/write persistent volume at `/rqlite/file`.
4. Keep `NODE_ID=txt-control-1` stable and let the entrypoint bind rqlite HTTP
   to `127.0.0.1:14001`.
5. Create a public Northflank route only for OpenResty port `8080`. Do not route
   Raft port `4002`.
6. Configure liveness at `/health/live` and readiness at `/health/ready`.
7. Apply `docker/migrations/0001_control.sql` through the Basic-authenticated
   `/operator/rqlite/` route.

The rqlite volume and its backups are required. A container filesystem without a
persistent volume is not an acceptable database deployment.

OpenResty handles the API with Lua endpoint files under `docker/lua/endpoints/`.
The service is always on, so there is no request cold start. Lua keeps only
Firebase public certificates in shared memory; owner, share, and rate-limit
state remains durable in rqlite.

Install these runtime secrets:

```text
OWNER_FIREBASE_UID
FIREBASE_PROJECT_ID
R2_TICKET_SECRET
RATE_LIMIT_KEY
R2_ENDPOINT
R2_BUCKET
R2_REGION
R2_READ_WRITE_ACCESS_KEY_ID
R2_READ_WRITE_SECRET_ACCESS_KEY
SHARE_URL_TTL_SECONDS=60
UI_ORIGIN
RQLITE_ADMIN_USERNAME
RQLITE_ADMIN_PASSWORD
```

Generate `R2_TICKET_SECRET` and `RATE_LIMIT_KEY` independently:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

Restrict API CORS to `UI_ORIGIN`. Set bounded request-body sizes, request
timeouts, and trusted-proxy handling before enabling the public route. Only
Northflank's own forwarding header is accepted as the public client address used
for rate limiting.

## 3. Owner initialization

Create `owner_creds.json` with Firebase, rqlite, and R2 connection information.
Keep this file outside the repository and back it up securely. Leave
`user_root_key` empty only for the first run:

```sh
txt --init-owner owner_creds.json --verbose
```

Verify that rqlite contains one `owner_control` row with `singleton = 1` and that
its Firebase UID equals `OWNER_FIREBASE_UID`. There is no additional account
initialization.

Initialize or migrate the owner's encrypted R2 database before deploying a UI
that depends on a new local schema:

```sh
txt --update-db owner_creds.json --local-db-dir ./data --verbose
```

## 4. R2

Create a parent R2 API token limited to the application bucket. The Northflank
API uses it to mint temporary owner access, presign exact shared reads, delete
revoked shared objects, and upload encrypted control backups.

Configure bucket CORS for the exact UI origin:

- methods: `GET`, `PUT`, `HEAD`;
- request headers: `Range`, `If-Match`, `If-None-Match`, `Content-Type`, and the
  required SigV4 headers;
- exposed headers: `ETag`, `Content-Length`, `Content-Range`, `Accept-Ranges`;
- no wildcard origin;
- a short preflight cache duration during rollout.

Shared EPUBs are downloaded directly from R2 through 60-second exact-object
presigned URLs. The Northflank API must not fetch or stream their response
bodies.

## 5. Static UI

Build the React UI and deploy `dist/` to Cloudflare Pages:

```sh
WORKER_NAME=txt npm run deploy
```

`wrangler.jsonc` declares `dist/` as `pages_build_output_dir` and exposes the
same directory through the `STATIC_ASSETS` binding. It contains no server entry
point or API bindings. Configure SPA fallback, the security headers required by
the EPUB renderer, and the exact Northflank API origin. The shared route must be
public; owner library routes require Firebase and the unlocked local vault.

The URL fragment containing a share capability and content key must never be
forwarded to analytics, error reporting, or server logs.

## 6. Backups

Render a secret-backed copy of `docker/backup.conf.json.example`, mount it in
the service, and set `RQLITE_BACKUP_CONF` to that path. rqlite's native
`-auto-backup` process writes its supported hot backup directly to the private
R2 `control-backups/` prefix. It never copies the live volume database file.
Use R2-side retention/versioning or an external copy job when multiple dated
restore points are required.

Alert on a missed backup, failed checksum, rqlite volume pressure, repeated API
readiness failures, and sustained rate-limit rejection.

## 7. Release verification

Before exposing the deployment, verify:

1. rqlite is unreachable from the public internet.
2. The configured Firebase owner can call `/v1/keys`; another valid Firebase UID
   receives `403`.
3. Ticket renewal, P-521 proof verification, and 15-minute R2 credentials work.
4. Exact database reads and conditional writes work, including a deliberate
   `412` conflict.
5. Owner EPUB upload, download, reading position, and bookmarks persist.
6. Share creation uploads one independently encrypted R2 object and registers
   one active rqlite row.
7. Anonymous redemption returns a 60-second URL for only that object, and the
   EPUB downloads directly from R2.
8. An invalid capability, expired presigned URL, malformed body, and exceeded
   rate limit fail with the expected status.
9. Revocation blocks new URLs immediately, deletes the R2 object, and removes the
   rqlite row after deletion succeeds.
10. A rqlite restart preserves owner, share, migration, and counter rows.
11. A backup can restore into an empty test rqlite service.
