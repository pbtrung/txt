# rqlite Control Database — Design

rqlite is the sole server-side database. It combines owner control data,
share-registry state, schema versions, and rate-limit counters in one small
SQLite schema exposed through rqlite's private HTTP API.

The Northflank deployment is a single-node rqlite cluster. A single node is
appropriate for the one-owner workload, but it is not highly available. Durable
storage, health checks, and off-node backups are mandatory.

## 1. Service topology

- Run the official `ghcr.io/rqlite/rqlite` image at a pinned version or digest.
- Set a stable node ID such as `txt-control-1`.
- Mount a single-read/write persistent volume at `/rqlite/file` and pass that
  directory to `rqlited` as its data directory.
- Expose HTTP port `4001` only on the Northflank private network. Do not create a
  public port for rqlite.
- Keep Raft port `4002` private even though the one-node deployment has no peers.
- Enable rqlite Basic Auth. The API credential may execute and query; a separate
  backup credential may query, back up, and inspect readiness.
- The API is the only application allowed to submit SQL. Browsers never receive
  the private address or rqlite credentials.

The API uses `/db/query` for reads and `/db/execute?transaction` for writes. It
uses `/db/request?transaction` only when an operation must atomically mix writes
and returned rows. Every statement is parameterized. BLOB parameters are byte
arrays, and read requests use `blob_array` so text and binary values cannot be
confused.

Application code must not open, copy, checkpoint, or modify rqlite's live
`db.sqlite` file. All live access goes through the HTTP API.

## 2. Schema

The API supplies all timestamps explicitly as Unix milliseconds; the schema
does not use clock-dependent defaults.

```sql
CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE owner_control (
    singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
    firebase_uid             TEXT    NOT NULL UNIQUE,
    created_at               INTEGER NOT NULL,
    user_handle_hash         BLOB    NOT NULL CHECK (length(user_handle_hash) = 32),
    db_binding_hash          BLOB    NOT NULL CHECK (length(db_binding_hash) = 64),
    wrapped_umk              BLOB    NOT NULL,
    kem_public_key           BLOB    NOT NULL,
    wrapped_kem_private_key  BLOB    NOT NULL,
    sign_version             INTEGER NOT NULL CHECK (sign_version = 1),
    sign_algorithm           TEXT    NOT NULL CHECK (sign_algorithm = 'ECDSA-P521-SHA512'),
    sign_public_key          BLOB    NOT NULL,
    wrapped_sign_private_key BLOB    NOT NULL,
    encrypted_credentials    BLOB    NOT NULL
) STRICT;

CREATE TABLE shares (
    share_id_hash BLOB    PRIMARY KEY CHECK (length(share_id_hash) = 32),
    object_path   TEXT    NOT NULL UNIQUE,
    state         TEXT    NOT NULL CHECK (state IN ('active', 'deleting')),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX shares_state_created_at
ON shares(state, created_at);

CREATE TABLE rate_limits (
    scope        TEXT    NOT NULL,
    subject_hash BLOB    NOT NULL CHECK (length(subject_hash) = 32),
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL CHECK (count >= 1),
    PRIMARY KEY (scope, subject_hash, window_start)
) STRICT;

CREATE INDEX rate_limits_window_start
ON rate_limits(window_start);
```

`owner_control` has no role, type, or relationship tables. The `singleton`
constraint makes the one-owner invariant structural rather than conventional.

`shares.share_id_hash` is `SHA-256(raw_share_id)`. The raw capability and the
share content key are never stored server-side. `object_path` is present because
the API must sign that exact R2 GET request; it is not secret key material.

## 3. Atomic operations

Schema migrations are ordered, idempotent, and applied through one transactional
request. Startup readiness fails if an unknown or incomplete schema version is
present.

Share registration inserts an `active` row. Repeating the same capability and
path is idempotent; the same capability with a different path is rejected.
Deletion first changes `active` to `deleting`. Public URL issuance selects only
`active` rows. After R2 deletion succeeds or reports the object missing, a final
transaction deletes the row. A failed R2 deletion therefore remains revoked but
visible for owner retry.

Rate-limit increments use one transactional request. The application must not
implement a read-then-write counter using separate HTTP calls, because concurrent
requests could lose increments.

## 4. Availability and consistency

All writes go through rqlite's Raft log even in the one-node configuration. The
API waits for committed writes and does not use queued writes. Regular reads use
the default leader-backed behavior; with one node there is no follower-staleness
tradeoff.

The API exposes:

- `/health/live`: process is running;
- `/health/ready`: rqlite is reachable, authenticated, and at the expected schema
  version.

Northflank sends traffic only after readiness succeeds. If rqlite is unavailable,
authorization, share, and rate-limited endpoints return `503` rather than using
stale local state.

## 5. Backup and recovery

A daily Northflank cron job retrieves the complete hot SQLite backup through
`GET /db/backup?fmt=delete` using the backup-only credential and uploads those
exact bytes to the private, server-only R2 `control-backups/` prefix. The job
does not read or copy the live rqlite volume. It records a SHA-256 digest in the
object name and metadata, then downloads and verifies the uploaded object.
R2 server-side encryption protects the backup at rest. Retain at least seven
daily and four weekly copies, and test restoration periodically.

Recovery procedure:

1. Stop the API so no writes can occur.
2. Stop the rqlite service and preserve the damaged volume for inspection.
3. Create an empty rqlite data volume.
4. Download and verify the selected R2 object, then restore that SQLite backup
   using rqlite's supported restore or boot process; never overwrite the live
   `db.sqlite` file directly.
5. Start rqlite and verify readiness, schema version, the singleton row, and live
   share counts.
6. Start the API and test owner unlock plus one share redemption.

The persistent volume protects against routine container restarts. The off-node
backup protects against volume loss, accidental schema writes, and operator
error. Neither provides service continuity while the single rqlite node is down.
