// Per-document part lookups against the now-open SQLCipher db (see
// state/VaultContext.tsx's unlock()). Everything else the old owner.ts did
// -- resolving a username/password, unwrapping umk/priv_key, decapsulating a
// txt_shares KEM grant -- has no equivalent in this schema at all: db access
// is already gated by this account's own signed-in InstantDB session, and
// there is no sharing table (see docs/data_model.md). `txt_parts.content` is
// a plain BLOB here, protected only by SQLCipher's own page-level
// encryption (db_key) -- unlike the old per-part-R2-addressed version,
// there is no separate key, R2 round-trip, or AEAD unwrap needed to read a
// part at all; see parts.ts for the one remaining step (brotli-decompress).

import type { SqliteDb } from "./sqliteDb";

/** One part's brotli-compressed raw text (1-based part_num) -- one row-read,
 * not one per part in the document. Returns null if no such part exists. */
export function partContent(
  db: SqliteDb,
  txtId: number,
  partNum: number,
): Uint8Array | null {
  const stmt = db.prepare(
    "SELECT content FROM txt_parts WHERE txt_id = ? AND part_num = ?",
  );
  stmt.bindInt64(1, txtId);
  stmt.bindInt64(2, partNum);
  const content = stmt.step() ? stmt.columnBlob(0) : null;
  stmt.finalize();
  return content;
}

export function partCount(db: SqliteDb, txtId: number): number {
  const stmt = db.prepare("SELECT COUNT(*) FROM txt_parts WHERE txt_id = ?");
  stmt.bindInt64(1, txtId);
  stmt.step();
  const count = Number(stmt.columnInt64(0));
  stmt.finalize();
  return count;
}
