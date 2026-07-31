// Read-position tracking against txt.last_part_num/last_accessed (see
// docs/data_model.md) -- plain columns on the document's own row now, not a
// separate per-user encrypted blob keyed by txt_id. No cap/eviction here
// either: "recently opened" is just an ORDER BY last_accessed DESC LIMIT n
// query at read time (idx_txt_last_accessed backs it), not a bounded blob
// a client has to prune.

import type { SqliteDb } from "./sqliteDb";

export interface ReadPosition {
  lastPartNum: number;
  lastAccessedMs: number;
}

export type AccessMap = Map<number, ReadPosition>;

/** Null until the document has been opened at least once (both columns are
 * NULL together, see docs/data_model.md's txt table). */
export function getReadPosition(db: SqliteDb, txtId: number): ReadPosition | null {
  const stmt = db.prepare("SELECT last_part_num, last_accessed FROM txt WHERE id = ?");
  stmt.bindInt64(1, txtId);
  const found = stmt.step();
  const position =
    found && !stmt.columnIsNull(0)
      ? { lastPartNum: Number(stmt.columnInt64(0)), lastAccessedMs: Number(stmt.columnInt64(1)) }
      : null;
  stmt.finalize();
  return position;
}

export function setReadPosition(
  db: SqliteDb,
  txtId: number,
  partNum: number,
  lastAccessedMs: number,
): void {
  db.run("UPDATE txt SET last_part_num = ?, last_accessed = ? WHERE id = ?;", (s) => {
    s.bindInt64(1, partNum);
    s.bindInt64(2, lastAccessedMs);
    s.bindInt64(3, txtId);
  });
}

/** "Remove from recently opened" (LibraryScreen.tsx) -- resets a document's
 * read position back to its never-opened state, rather than deleting the
 * document itself. */
export function clearReadPosition(db: SqliteDb, txtId: number): void {
  db.run("UPDATE txt SET last_part_num = NULL, last_accessed = NULL WHERE id = ?;", (s) =>
    s.bindInt64(1, txtId),
  );
}
