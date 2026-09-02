-- docs/data_model.md §2. Applied and tracked by `wrangler d1 migrations`
-- (its own `d1_migrations` table, not a bespoke schema_migrations table).

CREATE TABLE owner (
    singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
    created_at                INTEGER NOT NULL,
    owner_email_hash          BLOB    NOT NULL CHECK (length(owner_email_hash) = 32), -- SHA-256(owner_email)
    db_prefix_hash            BLOB    NOT NULL CHECK (length(db_prefix_hash) = 32),   -- SHA-256(db_prefix)
    user_handle_hash          BLOB    NOT NULL CHECK (length(user_handle_hash) = 32), -- SHA-256(user_handle)
    wrapped_umk               BLOB    NOT NULL,
    kem_public_key            BLOB    NOT NULL,  -- composite KEM, docs/crypto.md
    wrapped_kem_private_key   BLOB    NOT NULL,  -- Encrypt, IKM = umk
    sign_version              INTEGER NOT NULL CHECK (sign_version = 1),
    sign_algorithm            TEXT    NOT NULL CHECK (sign_algorithm = 'ECDSA-P521-SHA512'),
    sign_public_key           BLOB    NOT NULL,
    wrapped_sign_private_key  BLOB    NOT NULL,  -- Encrypt, IKM = umk
    encrypted_credentials     BLOB    NOT NULL   -- {user_handle, display_name, db_prefix}
) STRICT;

-- Holds every per-row key (docs/data_model.md §1), wrapped by umk,
-- referenced by the row it protects.
CREATE TABLE key_store (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose     TEXT    NOT NULL CHECK (purpose IN
                     ('catalog_key', 'content_key', 'access_key',
                      'bookmark_key', 'share_key')),
    wrapped_key BLOB    NOT NULL,  -- Encrypt, IKM = umk; plaintext is 128 random bytes
    created_at  INTEGER NOT NULL
) STRICT;

-- Singleton. Points at the one R2 catalog object (docs/storage_layout.md);
-- holds no document data itself.
CREATE TABLE catalog (
    singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
    key_id       INTEGER NOT NULL REFERENCES key_store(id),
    catalog_blob BLOB    NOT NULL,  -- Encrypt, IKM = key_id's unwrapped key
                                     -- plaintext: {catalog_key, catalog_path}
    updated_at   INTEGER NOT NULL
) STRICT;

-- One row per document. Display metadata lives in the R2 catalog object
-- for fast bulk listing; this row holds what's needed to open and
-- decrypt the one document plus its live reading state.
CREATE TABLE documents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     INTEGER NOT NULL,
    content_key_id INTEGER NOT NULL REFERENCES key_store(id),
    content_blob   BLOB    NOT NULL,  -- Encrypt, IKM = content_key_id's unwrapped key
                                       -- plaintext: {content_key (128 random bytes), path}
    access_key_id  INTEGER NOT NULL REFERENCES key_store(id),
    access_blob    BLOB    NOT NULL,  -- Encrypt, IKM = access_key_id's unwrapped key
                                       -- plaintext: {last_accessed, last_cfi}
    access_version INTEGER NOT NULL DEFAULT 0  -- optimistic-concurrency counter for access_blob, docs/data_model.md §4
) STRICT;

CREATE TRIGGER trg_documents_delete_keys AFTER DELETE ON documents
BEGIN
  DELETE FROM key_store WHERE id = OLD.content_key_id OR id = OLD.access_key_id;
END;

-- Comparisons use IS NOT rather than != deliberately: if a *_key_id
-- pointed at a key_store row that doesn't exist, the subquery returns
-- NULL, and NULL != 'x' evaluates to NULL rather than true, which would
-- make the trigger silently not fire. IS NOT is NULL-safe.
CREATE TRIGGER trg_documents_key_purpose BEFORE INSERT ON documents
WHEN (SELECT purpose FROM key_store WHERE id = NEW.content_key_id) IS NOT 'content_key'
   OR (SELECT purpose FROM key_store WHERE id = NEW.access_key_id) IS NOT 'access_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for documents row');
END;

CREATE TABLE bookmarks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    key_id        INTEGER NOT NULL REFERENCES key_store(id),
    bookmark_blob BLOB    NOT NULL  -- Encrypt, IKM = key_id's unwrapped key
                                     -- plaintext: {cfi, page_number, preview}
) STRICT;
CREATE INDEX idx_bookmarks_document_id ON bookmarks(document_id, created_at, id);

-- Per-document cap of 20, enforced in the database rather than in every
-- caller. Ordered by id: monotonic, and immune to client clock skew.
CREATE TRIGGER trg_bookmarks_cap AFTER INSERT ON bookmarks
BEGIN
  DELETE FROM bookmarks WHERE document_id = NEW.document_id AND id NOT IN (
    SELECT id FROM bookmarks WHERE document_id = NEW.document_id
    ORDER BY id DESC LIMIT 20
  );
END;

-- Fires for both the cap eviction above and any explicit application
-- delete, so an evicted or deleted bookmark's key_store row never has to
-- be tracked and cleaned up by caller code.
CREATE TRIGGER trg_bookmarks_delete_key AFTER DELETE ON bookmarks
BEGIN
  DELETE FROM key_store WHERE id = OLD.key_id;
END;
CREATE TRIGGER trg_bookmarks_key_purpose BEFORE INSERT ON bookmarks
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'bookmark_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for bookmarks row');
END;

CREATE TABLE shares (
    share_id_hash     BLOB    PRIMARY KEY CHECK (length(share_id_hash) = 32),
    document_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
    object_path_hash  BLOB    NOT NULL CHECK (length(object_path_hash) = 32),
    key_id            INTEGER NOT NULL REFERENCES key_store(id),
    owner_blob        BLOB    NOT NULL,  -- Encrypt, IKM = key_id's unwrapped key
                                          -- plaintext: {share_id, share_content_key
                                          --             (128 random bytes), share_path}
    state             TEXT    NOT NULL CHECK (state IN ('creating', 'active', 'deleting')),
    created_at        INTEGER NOT NULL,
    UNIQUE (object_path_hash)
) STRICT;
CREATE TRIGGER trg_shares_delete_key AFTER DELETE ON shares
BEGIN
  DELETE FROM key_store WHERE id = OLD.key_id;
END;
CREATE TRIGGER trg_shares_key_purpose BEFORE INSERT ON shares
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'share_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for shares row');
END;
CREATE TRIGGER trg_catalog_key_purpose BEFORE INSERT ON catalog
WHEN (SELECT purpose FROM key_store WHERE id = NEW.key_id) IS NOT 'catalog_key'
BEGIN
  SELECT RAISE(ABORT, 'key_store purpose mismatch for catalog row');
END;
