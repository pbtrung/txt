// Plain SQL CRUD against txt_bookmarks (see docs/data_model.md) -- one row
// per bookmark, no encrypted blob and no client-side eviction: the schema's
// own trg_txt_bookmarks_cap trigger keeps at most BOOKMARK_LIMIT rows per
// document, so a caller here never has to reason about the cap at all.

import type { SqliteDb } from "./sqliteDb";

export interface Bookmark {
  id: number;
  txtId: number;
  partNum: number;
  line: number;
  preview: string;
  createdAt: number;
}

export type BookmarksMap = Map<number, Bookmark[]>;

/** Every bookmark in the vault, grouped by txt_id -- one query for the whole
 * library (VaultContext.tsx's unlock/refresh and every add/remove), not one
 * per document: the schema's own per-document cap keeps the total row count
 * small regardless of library size. */
export function loadBookmarksMap(db: SqliteDb): BookmarksMap {
  const stmt = db.prepare(
    "SELECT id, txt_id, part_num, line, preview, created_at FROM txt_bookmarks " +
      "ORDER BY txt_id, created_at DESC, id DESC",
  );
  const map: BookmarksMap = new Map();
  while (stmt.step()) {
    const txtId = Number(stmt.columnInt64(1));
    const bookmark: Bookmark = {
      id: Number(stmt.columnInt64(0)),
      txtId,
      partNum: Number(stmt.columnInt64(2)),
      line: Number(stmt.columnInt64(3)),
      preview: stmt.columnText(4),
      createdAt: Number(stmt.columnInt64(5)),
    };
    const list = map.get(txtId);
    if (list) list.push(bookmark);
    else map.set(txtId, [bookmark]);
  }
  stmt.finalize();
  return map;
}

/** Most-recent-first, matching idx_txt_bookmarks_txt_id_created_at and the
 * reader's own "list bookmarks" query (docs/data_model.md's Design Notes). */
export function listBookmarks(db: SqliteDb, txtId: number): Bookmark[] {
  const stmt = db.prepare(
    "SELECT id, part_num, line, preview, created_at FROM txt_bookmarks " +
      "WHERE txt_id = ? ORDER BY created_at DESC, id DESC",
  );
  stmt.bindInt64(1, txtId);
  const bookmarks: Bookmark[] = [];
  while (stmt.step()) {
    bookmarks.push({
      id: Number(stmt.columnInt64(0)),
      txtId,
      partNum: Number(stmt.columnInt64(1)),
      line: Number(stmt.columnInt64(2)),
      preview: stmt.columnText(3),
      createdAt: Number(stmt.columnInt64(4)),
    });
  }
  stmt.finalize();
  return bookmarks;
}

/** Re-bookmarking an already-bookmarked line is a silent no-op (INSERT OR
 * IGNORE against the UNIQUE (txt_id, part_num, line) constraint), not an
 * error the caller needs to handle. */
export function addBookmark(
  db: SqliteDb,
  txtId: number,
  partNum: number,
  line: number,
  preview: string,
  createdAt: number,
): void {
  db.run(
    "INSERT OR IGNORE INTO txt_bookmarks (txt_id, part_num, line, preview, created_at) " +
      "VALUES (?, ?, ?, ?, ?);",
    (s) => {
      s.bindInt64(1, txtId);
      s.bindInt64(2, partNum);
      s.bindInt64(3, line);
      s.bindText(4, preview.slice(0, 60));
      s.bindInt64(5, createdAt);
    },
  );
}

export function removeBookmark(db: SqliteDb, bookmarkId: number): void {
  db.run("DELETE FROM txt_bookmarks WHERE id = ?;", (s) => s.bindInt64(1, bookmarkId));
}

/** Removes every bookmark for one document at once -- not needed for
 * deleteTxt (ON DELETE CASCADE already handles that), but useful when only
 * a document's bookmarks should be cleared without deleting the document. */
export function removeAllBookmarksForTxt(db: SqliteDb, txtId: number): void {
  db.run("DELETE FROM txt_bookmarks WHERE txt_id = ?;", (s) => s.bindInt64(1, txtId));
}
