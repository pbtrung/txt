-- D1 enforces foreign keys, so every `DELETE FROM key_store` -- fired by
-- trg_documents_clear_access_key, the bookmark/share/document delete
-- triggers (0001_initial_schema.sql), and the direct cleanup delete in
-- documentsEndpoint.ts -- must verify no row in any referencing table
-- still points at the key being deleted. Without an index on the
-- referencing column, that verification is a full table scan (D1 bills
-- by rows examined), repeated once per key_store row deleted. documents
-- has two key_store references; access_key_id is already covered by
-- idx_documents_access_key_id (0003), so only content_key_id is new
-- here. catalog is a singleton table (at most one row) and isn't worth
-- indexing.
CREATE INDEX idx_documents_content_key_id ON documents(content_key_id);
CREATE INDEX idx_bookmarks_key_id ON bookmarks(key_id);
CREATE INDEX idx_shares_key_id ON shares(key_id);
