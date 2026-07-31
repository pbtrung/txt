// Read-position tracking against txt.last_part_num/last_accessed (see
// docs/data_model.md) -- plain columns on the document's own row now, not a
// separate per-user encrypted blob keyed by txt_id. No cap/eviction here
// either: "recently opened" is just an ORDER BY last_accessed DESC LIMIT n
// query at read time (idx_txt_last_accessed backs it), not a bounded blob
// a client has to prune.

import { verbose } from "../log";
import type { SqliteDb } from "./sqliteDb";

export interface ReadPosition {
  lastPartNum: number;
  lastAccessedMs: number;
}

export type AccessMap = Map<number, ReadPosition>;

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
  const changed = db.changes();
  verbose(
    `access: setReadPosition txtId=${txtId} matched ${changed} row(s)` +
      (changed !== 1 ? " (expected 1)" : ""),
  );
}

/** "Remove from recently opened" (LibraryScreen.tsx) -- resets a document's
 * read position back to its never-opened state, rather than deleting the
 * document itself. */
export function clearReadPosition(db: SqliteDb, txtId: number): void {
  db.run("UPDATE txt SET last_part_num = NULL, last_accessed = NULL WHERE id = ?;", (s) =>
    s.bindInt64(1, txtId),
  );
}
