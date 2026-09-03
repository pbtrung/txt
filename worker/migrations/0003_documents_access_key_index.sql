-- docs/data_model.md §3: GET /v1/documents/recent-access lists only
-- documents that have ever been opened (access_key_id IS NOT NULL) --
-- a partial index, not a full index, since the column is NULL for most
-- rows in a library with many never-opened books and a full index would
-- needlessly cover them too. Without this, filtering by
-- `access_key_id IS NOT NULL` still requires a full table scan (D1
-- bills by rows examined, not rows returned) -- this index lets it seek
-- directly to just the accessed rows instead.
CREATE INDEX idx_documents_access_key_id ON documents(access_key_id)
WHERE access_key_id IS NOT NULL;
