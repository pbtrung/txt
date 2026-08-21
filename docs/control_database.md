# rqlite Control Database — Design

rqlite is the sole server-side database. It combines owner control data,
share-registry state, schema versions, and rate-limit counters in one small
SQLite schema exposed through rqlite's private HTTP API.

The Northflank deployment is a single-node rqlite cluster. A single node is
appropriate for the one-owner workload, but it is not highly available. Durable
storage, health checks, and off-node backups are mandatory.

## 1. Service topology

- Build `docker/Dockerfile`, which pins rqlite and runs it beside OpenResty.
- Set a stable node ID such as `txt-control-1`.
- Mount a single-read/write persistent volume at `/rqlite/file` and pass that
  directory to `rqlited` as its data directory.
- Bind rqlite HTTP to `127.0.0.1:14001`. Only OpenResty's port `8080` receives a
  Northflank route.
- Keep Raft port `4002` private even though the one-node deployment has no peers.
- OpenResty Lua submits API reads and writes through loopback. A separately
  Basic-authenticated `/operator/rqlite/` passthrough exists for owner unlock,
  migrations, diagnostics, and recovery. The owner UI receives its Basic
  credential only through the selected local unlock file and never receives the
  loopback address. Operator tools call the route as `rqlite_operator_url`; the
  UI calls the same route as `rqlite_db_url`, such as
  `https://api.example.com/operator/rqlite`.

Lua uses `/db/query` for reads and `/db/execute?transaction` for writes. It uses
`/db/request?transaction` only when an operation must atomically mix writes and
returned rows. Every Lua and Python statement is parameterized. BLOB parameters
are byte arrays, and read requests use `blob_array` so text and binary values
cannot be confused. The browser issues one fixed singleton `SELECT` and converts
the returned BLOB arrays to in-memory byte arrays.

Application code must not open, copy, checkpoint, or modify rqlite's live
`db.sqlite` file. All live access goes through either loopback HTTP or the
Basic-authenticated OpenResty operator proxy.

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

## 3. Owner initialization and import

`txt --init-owner rqlite_creds.json` creates the singleton record directly for
a new library. `txt --migrate turso_creds.json rqlite_creds.json` is the
one-time import path for an existing library. Migration reads only the source
owner's self-owned control rows, validates their handle and path bindings, and
decrypts the source credential payload.

The destination always uses newly generated rqlite-era key material when it is
created: a new UMK, composite KEM keypair, and P-521 signing keypair. The
imported `user_handle`, `display_name`, `db_master_key`, `db_path`, and
`db_prefix` are re-encrypted under that UMK, so existing R2 objects remain at
their current paths and retain their database key. If the destination singleton
already exists, migration preserves its UMK and keypairs. Source and destination
Firebase UIDs must match. `--dry-run` performs all reads and validation without
writing either rqlite or the destination credential file.

## 4. Atomic operations

Schema migrations are ordered, idempotent, and applied through one transactional
request. Owner initialization installs schema version 1 automatically when the
database is empty. Application queries reject an absent, unknown, or incomplete
schema rather than treating it as empty state.

Share registration inserts an `active` row. Repeating the same capability and
path is idempotent; the same capability with a different path is rejected.
Deletion first changes `active` to `deleting`. Public URL issuance selects only
`active` rows. After R2 deletion succeeds or reports the object missing, a final
transaction deletes the row. A failed R2 deletion therefore remains revoked but
visible for owner retry.

Rate-limit increments use one transactional request. The application must not
implement a read-then-write counter using separate HTTP calls, because concurrent
requests could lose increments.

## 5. Availability and consistency

All writes go through rqlite's Raft log even in the one-node configuration. The
API waits for committed writes and does not use queued writes. Regular reads use
the default leader-backed behavior; with one node there is no follower-staleness
tradeoff.

The API exposes:

- `/health/live`: process is running;
- `/health/ready`: rqlite can answer a query.

Readiness deliberately works before the first schema exists so Northflank can
route the operator call that installs it. The application endpoints remain
unavailable until owner initialization completes. If rqlite is unavailable,
authorization, share, and rate-limited endpoints return `503` rather than using
stale local state.

## 6. Backup and recovery

rqlite's native `-auto-backup` process uses the secret-backed
`RQLITE_BACKUP_CONF` configuration to upload supported hot backups directly to
the private, server-only R2 `control-backups/` prefix. It does not read or copy
the live volume's `db.sqlite` file. R2 server-side encryption protects the
backup at rest. Use R2 retention or versioning for multiple restore points, and
test restoration periodically.

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
