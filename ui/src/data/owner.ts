// Per-document part lookups against the now-open SQLCipher db (see
// state/VaultContext.tsx's unlock()). Everything else the old owner.ts did
// -- resolving a username/password, unwrapping umk/priv_key, decapsulating a
// txt_shares KEM grant -- has no equivalent in this schema at all: db access
// is already gated by the api_key that opened the page store, and there is
// no sharing table (see docs/data_model.md). `txt_parts.path` is plain TEXT
// here too, not a wrapped blob (only the R2 object *content* needs
// txt.txt_key, see parts.ts) -- so unlike the old version, none of these
// need the document's key at all.

import type { SqliteDb } from "./sqliteDb";

/** One part's object-storage path (1-based part_num) -- one row-read, not
 * one per part in the document. Returns null if no such part exists. */
export function partRawPath(
  db: SqliteDb,
  txtId: number,
  partNum: number,
): string | null {
  const stmt = db.prepare(
    "SELECT path FROM txt_parts WHERE txt_id = ? AND part_num = ?",
  );
  stmt.bindInt64(1, txtId);
  stmt.bindInt64(2, partNum);
  const path = stmt.step() ? stmt.columnText(0) : null;
  stmt.finalize();
  return path;
}

export function partCount(db: SqliteDb, txtId: number): number {
  const stmt = db.prepare("SELECT COUNT(*) FROM txt_parts WHERE txt_id = ?");
  stmt.bindInt64(1, txtId);
  stmt.step();
  const count = Number(stmt.columnInt64(0));
  stmt.finalize();
  return count;
}
