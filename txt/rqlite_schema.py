CONTROL_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
    ) STRICT
    """,
    """
    CREATE TABLE IF NOT EXISTS owner_control (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        firebase_uid TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        user_handle_hash BLOB NOT NULL CHECK (length(user_handle_hash) = 32),
        db_binding_hash BLOB NOT NULL CHECK (length(db_binding_hash) = 64),
        wrapped_umk BLOB NOT NULL,
        kem_public_key BLOB NOT NULL,
        wrapped_kem_private_key BLOB NOT NULL,
        sign_version INTEGER NOT NULL CHECK (sign_version = 1),
        sign_algorithm TEXT NOT NULL
            CHECK (sign_algorithm = 'ECDSA-P521-SHA512'),
        sign_public_key BLOB NOT NULL,
        wrapped_sign_private_key BLOB NOT NULL,
        encrypted_credentials BLOB NOT NULL
    ) STRICT
    """,
    """
    CREATE TABLE IF NOT EXISTS shares (
        share_id_hash BLOB PRIMARY KEY CHECK (length(share_id_hash) = 32),
        object_path_hash BLOB NOT NULL UNIQUE CHECK (length(object_path_hash) = 32),
        state TEXT NOT NULL CHECK (state IN ('active', 'deleting')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    ) STRICT
    """,
    "CREATE INDEX IF NOT EXISTS shares_state_created_at ON shares(state, created_at)",
    """
    CREATE TABLE IF NOT EXISTS rate_limits (
        scope TEXT NOT NULL,
        subject_hash BLOB NOT NULL CHECK (length(subject_hash) = 32),
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK (count >= 1),
        PRIMARY KEY (scope, subject_hash, window_start)
    ) STRICT
    """,
    "CREATE INDEX IF NOT EXISTS rate_limits_window_start ON rate_limits(window_start)",
    """
    INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
    VALUES (1, 'control', CAST(unixepoch('subsec') * 1000 AS INTEGER))
    """,
)
