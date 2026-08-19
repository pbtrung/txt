CREATE TABLE share_registry (
  share_id_hash BLOB PRIMARY KEY CHECK (length(share_id_hash) = 32),
  object_path_hash BLOB NOT NULL CHECK (length(object_path_hash) = 32),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;

CREATE INDEX share_registry_state_idx
ON share_registry(state, created_at);
