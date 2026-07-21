"""--update-schema: migrates an already-initialized DB from the old per-(txt_id,
user_id)-row txt_access/bookmarks design to the current one-row-per-user
design (see docs/data_model.md). A fresh DB (via --init) already gets the
current schema, so this is only needed for a DB initialized before this
change.

Dropping and recreating txt_access/bookmarks is destructive: plain `CREATE
TABLE IF NOT EXISTS` would silently no-op against the old column shapes, and
no migration of old row data is attempted (the shape changed too much for a
straight column copy -- one row per (txt_id, user_id) vs. one JSON blob per
user). Any existing read-position/bookmark data is lost.
"""

import logging

from .admin import AdminInitializer
from .creds import AdminCreds
from .db import Database

logger = logging.getLogger(__name__)

# The old design's artifacts, absent from the current schema (see schema.py).
_OLD_DROP_STATEMENTS = (
    "DROP TRIGGER IF EXISTS trg_limit_bookmarks_per_file",
    "DROP INDEX IF EXISTS idx_bookmarks_txt_id_user_id",
    "DROP TABLE IF EXISTS txt_access",
    "DROP TABLE IF EXISTS bookmarks",
)


class SchemaUpdater:
    """Drops the old txt_access/bookmarks design, recreates the current one,
    and backfills the admin's txt_access_key/bookmark_key rows."""

    def __init__(self, db: Database, creds: AdminCreds) -> None:
        self.db = db
        self.creds = creds

    def _drop_old_txt_access_bookmarks(self) -> None:
        for stmt in _OLD_DROP_STATEMENTS:
            self.db.conn.execute(stmt)
        self.db.conn.commit()
        logger.info("Dropped old txt_access/bookmarks trigger, index, and tables")

    def run(self) -> int:
        self._drop_old_txt_access_bookmarks()
        self.db.apply_schema()
        user_id = AdminInitializer(self.db, self.creds).run()
        logger.info("Schema updated (admin user_id=%d)", user_id)
        return user_id
