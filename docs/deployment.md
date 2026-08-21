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
7. Run owner initialization or migration through the Basic-authenticated
   `/operator/rqlite/` route. The CLI installs schema version 1 automatically
   when rqlite is empty.

The rqlite volume and its backups are required. A container filesystem without a
persistent volume is not an acceptable database deployment.

OpenResty handles the API with Lua endpoint files under `docker/lua/endpoints/`.
The service is always on, so there is no request cold start. Lua keeps only
Firebase public certificates in shared memory; owner, share, and rate-limit
state remains durable in rqlite.

Outbound Lua HTTPS uses Alpine's system CA bundle with certificate verification
enabled. This trust store is required both for fetching Firebase's rotating ID
token signing certificates and for authenticated R2 HTTPS operations.

`/health/ready` checks that rqlite can answer a simple query; it intentionally
does not require `schema_migrations` to exist, because Northflank must route the
operator request that installs the first schema. Application endpoints remain
unusable until `--init-owner` or `--migrate` completes.

## 2. Runtime configuration

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

Set `UI_ORIGIN` to the deployed static-UI origin. A trailing slash is accepted:
the container removes it before rendering Nginx so the map, CORS response, and
Lua configuration match the browser's canonical slashless `Origin` header.
OpenResty rejects every `/v1/*` request with a missing or different `Origin`.
The operator proxy returns CORS permission only for that same origin while
remaining usable by Basic-authenticated CLI and recovery clients that do not
send browser-origin headers. Set bounded request-body sizes, request timeouts,
and trusted-proxy handling before enabling the public route. Only Northflank's
own forwarding header is accepted as the public client address used for rate
limiting.

## 3. Owner initialization and migration

Create `rqlite_creds.json` with this exact shape:

```json
{
  "rqlite_admin_username": "operator",
  "rqlite_admin_password": "...",
  "rqlite_operator_url": "https://api.example.com/operator/rqlite",
  "firebase_email": "owner@example.com",
  "firebase_password": "...",
  "firebase_api_key": "...",
  "display_name": "Owner",
  "r2_config": {
    "endpoint": "https://ACCOUNT_ID.r2.cloudflarestorage.com",
    "read_only_access_key_id": "...",
    "read_only_secret_access_key": "...",
    "read_write_access_key_id": "...",
    "read_write_secret_access_key": "...",
    "region": "auto",
    "bucket": "txt"
  },
  "slhdsa_256f_priv_key": "",
  "asset_base_url": "https://reader.example.com",
  "user_root_key": ""
}
```

`rqlite_operator_url` is the public OpenResty operator route protected by
`RQLITE_ADMIN_USERNAME` and `RQLITE_ADMIN_PASSWORD`. For Northflank it is
`https://<public-service-domain>/operator/rqlite`, without a rqlite API suffix
such as `/db/query`. The CLI removes a trailing slash. Do not use
`http://127.0.0.1:14001` unless the CLI itself is running inside the container.
OpenResty permits up to 128 KiB only on this Basic-authenticated operator route
to accommodate JSON byte arrays for owner key material; public application
routes retain the 16 KiB limit.

Keep this file outside the repository and back it up securely. Leave
`user_root_key` empty only for the first write: initialization generates a
256-byte standard-base64 key and writes it back. Empty
`slhdsa_256f_priv_key` is reserved for the static-asset signing setup;
`asset_base_url` is the deployed UI origin. Every `r2_config` property must be
present.

For a new library with no Turso control record, initialize the owner directly:

```sh
txt --init-owner rqlite_creds.json --verbose
```

Verify that rqlite contains one `owner_control` row with `singleton = 1` and that
its Firebase UID equals `OWNER_FIREBASE_UID`. There is no additional account
initialization.

For an existing Turso-backed owner, do not initialize a placeholder owner
first. Preview and then run the migration with the existing Turso credential
file as the source and the new rqlite credential file as the destination:

```sh
txt --migrate turso_creds.json rqlite_creds.json --verbose --dry-run
txt --migrate turso_creds.json rqlite_creds.json --verbose
```

Both files must authenticate the same Firebase UID. The command validates the
source handle and path hashes, decrypts the self-owned `cred_store.content`, and
preserves its `user_handle`, `display_name`, `db_master_key`, `db_path`, and
`db_prefix`. If `owner_control` does not exist, migration performs owner
initialization itself with a fresh UMK, composite KEM keypair, and P-521 signing
keypair. If it already exists, migration preserves its UMK and keypairs and only
rewraps the imported payload. Repeating the migration is safe; `--dry-run`
neither writes rqlite nor fills `user_root_key`.

Initialize or migrate the owner's encrypted R2 database before deploying a UI
that depends on a new local schema:

```sh
txt --update-db owner_creds.json --local-db-dir ./data --verbose
```

### Browser unlock credential file

After initialization or migration has populated `user_root_key`, create a
separate owner-only UI file with exactly this shape:

```json
{
  "rqlite_admin_username": "operator",
  "rqlite_admin_password": "...",
  "rqlite_db_url": "https://api.example.com/operator/rqlite",
  "firebase_email": "owner@example.com",
  "firebase_password": "...",
  "firebase_api_key": "...",
  "user_root_key": "<generated padded base64>"
}
```

Copy `rqlite_db_url` from the provisioning file's `rqlite_operator_url`; the
different name marks the browser's direct database-proxy endpoint. Copy the
Firebase and root-key values from the initialized destination file. Do not copy
`r2_config`, the asset signing key, or the display name into the UI file. Keep
both files outside the repository. The browser reads the selected UI file into
memory, never uploads it or stores it in Web Storage, and requires a new unlock
after lock or reload.

## 4. R2

Create a parent R2 API token limited to the application bucket. The Northflank
API uses it to mint temporary owner access, presign exact shared reads, delete
revoked shared objects. Native rqlite backups use the separate credentials in
`RQLITE_BACKUP_CONF`.

Configure bucket CORS for the exact UI origin:

- methods: `GET`, `PUT`, `DELETE`, `HEAD`;
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
CF_PROJECT_NAME=txt npm run deploy
```

`wrangler.jsonc` declares `dist/` only as `pages_build_output_dir`. Do not add a
Workers `assets` block: Pages rejects that configuration, and this static site
has no Pages Function that needs an `ASSETS` binding. It contains no server
entry point or API bindings. The static CSP permits HTTPS connections because
the Northflank API origin is supplied at unlock time and copied into share URL
fragments; EPUB scripts remain disabled and EPUB resource directives remain
restricted. The shared route is public; owner library routes require Firebase
and the unlocked local vault.

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
3. A missing or mismatched browser origin receives `403` on every `/v1/*`
   endpoint, while the Basic-authenticated CLI can still use the operator route.
4. The seven-field UI file unlocks only when Firebase, rqlite, and API owner UIDs
   match.
5. Ticket renewal, P-521 proof verification, and 15-minute R2 credentials work.
6. Exact database reads and conditional writes work, including a deliberate
   `412` conflict.
7. Owner EPUB upload, download, reading position, and bookmarks persist.
8. Share creation uploads one independently encrypted R2 object and registers
   one active rqlite row.
9. Anonymous redemption returns a 60-second URL for only that object, and the
   EPUB downloads directly from R2.
10. An invalid capability, expired presigned URL, malformed body, and exceeded
   rate limit fail with the expected status.
11. Revocation blocks new URLs immediately, deletes the R2 object, and removes the
   rqlite row after deletion succeeds.
12. A rqlite restart preserves owner, share, migration, and counter rows.
13. A backup can restore into an empty test rqlite service.
