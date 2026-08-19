CREATE TABLE share_registry (
  share_id_hash BLOB PRIMARY KEY CHECK (length(share_id_hash) = 32),
  object_path_hash BLOB NOT NULL CHECK (length(object_path_hash) = 32),
  created_at INTEGER NOT NULL
) STRICT;
