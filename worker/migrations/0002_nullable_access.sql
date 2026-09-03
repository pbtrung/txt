-- docs/data_model.md §2/§3: a not-yet-accessed document no longer gets an
-- access_key_id/access_blob eagerly minted at ingest time -- both stay
-- NULL until PATCH /v1/documents/:id/access (worker/documentsEndpoint.ts)
-- writes real reading state for the first time, so a book nobody has
-- opened costs no key_store row on every Library-screen load.
--
-- SQLite/D1 can't relax a NOT NULL/CHECK constraint or add a CHECK to an
-- existing table in place, so this rebuilds `documents` per SQLite's
-- documented procedure for schema changes ALTER TABLE can't express
-- (https://www.sqlite.org/lang_altertable.html#otheralter).

CREATE TABLE documents_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     INTEGER NOT NULL,
    content_key_id INTEGER NOT NULL REFERENCES key_store(id),
    content_blob   BLOB    NOT NULL,  -- Encrypt, IKM = content_key_id's unwrapped key
                                       -- plaintext: {content_key (128 random bytes), path}
    access_key_id  INTEGER REFERENCES key_store(id),
    access_blob    BLOB,              -- Encrypt, IKM = access_key_id's unwrapped key
                                       -- plaintext: {last_accessed, last_cfi}
                                       -- NULL together with access_key_id until first access
    access_version INTEGER NOT NULL DEFAULT 0,  -- optimistic-concurrency counter for access_blob, docs/data_model.md §4
    CHECK ((access_blob IS NULL) = (access_key_id IS NULL))
) STRICT;

INSERT INTO documents_new SELECT * FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

CREATE TRIGGER trg_documents_delete_keys AFTER DELETE ON documents
BEGIN
  DELETE FROM key_store WHERE id = OLD.content_key_id OR id = OLD.access_key_id;
END;

-- Comparisons use IS NOT rather than != deliberately: if a *_key_id
-- pointed at a key_store row that doesn't exist, the subquery returns
-- NULL, and NULL != 'x' evaluates to NULL rather than true, which would
-- make the trigger silently not fire. IS NOT is NULL-safe. The
-- access_key_id half only applies when it's actually set -- NULL is now
-- a valid, no-access-yet state, not a purpose mismatch.
CREATE TRIGGER trg_documents_key_purpose BEFORE INSERT ON documents
WHEN (SELECT purpose FROM key_store WHERE id = NEW.content_key_id) IS NOT 'content_key'
   OR (NEW.access_key_id IS NOT NULL
       AND (SELECT purpose FROM key_store WHERE id = NEW.access_key_id) IS NOT 'access_key')
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for documents row');
END;

-- Mirrors trg_documents_key_purpose's access_key_id check for the one
-- other way a row can acquire one: PATCH /v1/documents/:id/access's
-- first-ever write, which UPDATEs access_key_id in place rather than
-- setting it at INSERT time.
CREATE TRIGGER trg_documents_access_key_purpose BEFORE UPDATE OF access_key_id ON documents
WHEN NEW.access_key_id IS NOT NULL
   AND (SELECT purpose FROM key_store WHERE id = NEW.access_key_id) IS NOT 'access_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for documents row');
END;

-- Fires when PATCH /v1/documents/:id/access explicitly clears a
-- document's reading state (access_key_id set back to NULL), so the old
-- key_store row never has to be tracked and cleaned up by caller code --
-- the same cleanup-on-delete philosophy trg_bookmarks_delete_key already
-- uses for bookmarks.
CREATE TRIGGER trg_documents_clear_access_key AFTER UPDATE OF access_key_id ON documents
WHEN NEW.access_key_id IS NULL AND OLD.access_key_id IS NOT NULL
BEGIN
  DELETE FROM key_store WHERE id = OLD.access_key_id;
END;
