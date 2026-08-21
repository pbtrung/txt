-- Stop persisting the plaintext R2 object path for a share. The API now
-- requires the caller (owner for delete, recipient for a read URL) to
-- resupply the path components with every request, and verifies them
-- against object_path_hash instead of reading a stored path back.
--
-- Existing shares rows are ephemeral (a 60-second presigned-URL lifetime)
-- and are not preserved by this migration: an owner can immediately
-- re-share anything that was live. Apply this against an
-- already-provisioned rqlite instance with `txt --update-rql
-- rqlite_creds.json --verbose`; a fresh install gets this shape directly
-- from txt/rqlite_schema.py.

DROP TABLE IF EXISTS shares;

CREATE TABLE shares (
    share_id_hash    BLOB    PRIMARY KEY CHECK (length(share_id_hash) = 32),
    object_path_hash BLOB    NOT NULL UNIQUE CHECK (length(object_path_hash) = 32),
    state            TEXT    NOT NULL CHECK (state IN ('active', 'deleting')),
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX shares_state_created_at ON shares(state, created_at);

INSERT INTO schema_migrations (version, name, applied_at)
VALUES (2, 'share_object_path_hash', CAST(unixepoch('subsec') * 1000 AS INTEGER));
