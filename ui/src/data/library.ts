// Combines txt.metadata with txt.last_part_num/last_accessed into one
// query -- the Library screen's one load, not two, since both live on the
// same row (see docs/data_model.md's txt table).

import type { SqliteDb } from "./sqliteDb";
import { toBookInfo, parseMetadataBlob, type BookInfo } from "./metadata";
import type { AccessMap } from "./access";

export interface LibrarySnapshot {
  metadataById: Map<number, BookInfo>;
  accessMap: AccessMap;
}

export async function loadLibrary(db: SqliteDb): Promise<LibrarySnapshot> {
  const stmt = db.prepare(
    "SELECT id, name, metadata, last_part_num, last_accessed FROM txt;",
  );
  const metadataById = new Map<number, BookInfo>();
  const accessMap: AccessMap = new Map();
  while (stmt.step()) {
    const txtId = Number(stmt.columnInt64(0));
    const name = stmt.columnText(1);
    const opf = await parseMetadataBlob(
      stmt.columnIsNull(2) ? null : stmt.columnBlob(2),
    );
    metadataById.set(txtId, toBookInfo(txtId, name, opf));
    if (!stmt.columnIsNull(3)) {
      accessMap.set(txtId, {
        lastPartNum: Number(stmt.columnInt64(3)),
        lastAccessedMs: Number(stmt.columnInt64(4)),
      });
    }
  }
  stmt.finalize();
  return { metadataById, accessMap };
}
