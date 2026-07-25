"""--update-schema: migrates an already-initialized DB to the current schema
(see docs/data_model.md). A fresh DB (via --init) already gets the current
schema in full, so this is only needed for a DB initialized before either
change below.

1. The old per-(txt_id, user_id)-row txt_access/bookmarks design to the
   current one-row-per-user design. Dropping and recreating those two tables
   is destructive: plain `CREATE TABLE IF NOT EXISTS` would silently no-op
   against the old column shapes, and no migration of old row data is
   attempted (the shape changed too much for a straight column copy -- one
   row per (txt_id, user_id) vs. one JSON blob per user). Any existing
   read-position/bookmark data is lost.
2. Adding users.creds -- a nullable column `CREATE TABLE IF NOT EXISTS`
   can't retroactively add to an already-existing table, so this needs its
   own explicit `ALTER TABLE`, guarded by checking whether the column is
   already there so re-running --update-schema stays safe. Left NULL for
   every existing row (including the admin's own) -- nothing here populates
   it; that's a regular user's creds JSON, wrapped under the admin's umk
   (see docs/data_model.md), and nothing in txt/ creates a regular user row
   at all yet.
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
    adds users.creds if it's missing, and backfills the admin's
    txt_access_key/bookmark_key rows."""

    def __init__(self, db: Database, creds: AdminCreds) -> None:
        self.db = db
        self.creds = creds

    def _drop_old_txt_access_bookmarks(self) -> None:
        for stmt in _OLD_DROP_STATEMENTS:
            self.db.conn.execute(stmt)
        self.db.conn.commit()
        logger.info("Dropped old txt_access/bookmarks trigger, index, and tables")

    def _add_creds_column_if_missing(self) -> None:
        columns = self.db.conn.execute("PRAGMA table_info(users)").fetchall()
        if any(col[1] == "creds" for col in columns):
            logger.info("users.creds column already exists, skipping")
            return
        self.db.conn.execute("ALTER TABLE users ADD COLUMN creds BLOB")
        self.db.conn.commit()
        logger.info("Added users.creds column")

    def run(self) -> int:
        self._drop_old_txt_access_bookmarks()
        self._add_creds_column_if_missing()
        self.db.apply_schema()
        user_id = AdminInitializer(self.db, self.creds).run()
        logger.info("Schema updated (admin user_id=%d)", user_id)
        return user_id
