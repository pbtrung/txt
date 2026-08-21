# Northflank Deployment — Design

The deployment uses two always-on Northflank services in one region:

1. a public Node API with 0.2 shared vCPU and 512 MiB memory;
2. a private single-node rqlite service with a persistent volume.

The React UI is deployed as static content on a CDN. R2 stores the owner's
encrypted SQLCipher database, immutable encrypted EPUBs, encrypted shared copies,
and protected rqlite backups.

## 1. rqlite service

1. Create a deployment service from the official
   `ghcr.io/rqlite/rqlite` image pinned to a reviewed version or digest.
2. Assign one instance and a stable node ID, `txt-control-1`.
3. Attach a single-read/write persistent volume at `/rqlite/file`.
4. Start `rqlited` with `/rqlite/file` as its data directory, HTTP port `4001`,
   Raft port `4002`, and a Basic Auth configuration supplied from Northflank
   secrets.
5. Expose both ports only to the private project network. Never create a public
   rqlite route.
6. Configure readiness against rqlite's readiness endpoint with authentication.
7. Apply the schema in `docs/control_database.md` through the rqlite HTTP API and
   record migration version 1.

The rqlite volume and its backups are required. A container filesystem without a
persistent volume is not an acceptable database deployment.

## 2. API service

Deploy the Node API as the second service:

- one instance;
- 0.2 shared vCPU;
- 512 MiB memory;
- one public HTTPS port;
- a custom API domain;
- liveness at `/health/live`;
- readiness at `/health/ready`;
- graceful shutdown long enough to finish or abort bounded HTTP requests.

The service is always on, so there is no request cold start. The API is stateless
apart from rqlite and can be restarted without losing sessions or counters. Do
not store authorization or share state only in process memory.

Install these runtime secrets:

```text
OWNER_FIREBASE_UID
FIREBASE_PROJECT_ID
RQLITE_URL
RQLITE_USERNAME
RQLITE_PASSWORD
R2_TICKET_SECRET
RATE_LIMIT_KEY
R2_ENDPOINT
R2_BUCKET
R2_REGION
R2_READ_WRITE_ACCESS_KEY_ID
R2_READ_WRITE_SECRET_ACCESS_KEY
SHARE_URL_TTL_SECONDS=60
UI_ORIGIN
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

Build the React UI and deploy it to a static host or CDN. Configure SPA fallback,
the security headers required by the EPUB renderer, and the exact API origin.
The shared route must be public; owner library routes require Firebase and the
unlocked local vault.

The URL fragment containing a share capability and content key must never be
forwarded to analytics, error reporting, or server logs.

## 6. Backups

Create a daily Northflank cron job that:

1. authenticates to the private rqlite backup endpoint;
2. downloads `/db/backup?fmt=delete`;
3. computes its SHA-256 digest;
4. uploads the exact rqlite backup bytes to the server-only R2
   `control-backups/` prefix;
5. downloads the R2 object and verifies its digest;
6. applies the documented daily and weekly retention policy.

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
