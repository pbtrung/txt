// Builds a real, tiny unkeyed SQLite file via sqlcipher.wasm's own
// sqlite3_exec -- shared by every test that needs genuine SQLite bytes to
// exercise ui/src/data/sqlite.ts's openSqliteFromBytes against, rather than
// a hand-crafted byte string.
import { getSqlcipherModule } from "../crypto/sqlcipherLoader";
import type { SqlcipherWasmModule } from "../crypto/sqlcipherLoader";

let fixtureCounter = 0;

function execOrThrow(mod: SqlcipherWasmModule, db: number, sql: string): void {
  const len = mod.lengthBytesUTF8(sql);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(sql, ptr, len + 1);
  const rc = mod._sqlite3_exec(db, ptr, 0, 0, 0);
  mod._free(ptr);
  if (rc !== 0) throw new Error(`fixture statement failed: ${sql} (rc=${rc}: ${mod.UTF8ToString(mod._sqlite3_errmsg(db))})`);
}

export async function buildSqliteFixture(statements: string[]): Promise<Uint8Array> {
  const mod = await getSqlcipherModule();
  const path = `/sqlite-fixture-${fixtureCounter++}.sqlite`;
  const ppDb = mod._malloc(4);
  const pathPtr = mod._malloc(mod.lengthBytesUTF8(path) + 1);
  mod.stringToUTF8(path, pathPtr, mod.lengthBytesUTF8(path) + 1);
  mod._sqlite3_open(pathPtr, ppDb);
  const db = mod.getValue(ppDb, "i32");
  for (const sql of statements) execOrThrow(mod, db, sql);
  mod._sqlite3_close(db);
  const bytes = mod.FS.readFile(path);
  mod._free(ppDb);
  mod._free(pathPtr);
  return bytes;
}
