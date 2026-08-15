// Builds real SQLite/SQLCipher bytes via SqliteDatabase itself -- shared by
// every test that needs genuine database bytes rather than a hand-crafted
// byte string.
import { SqliteDatabase } from "../data/sqlite";

export async function buildSqliteFixture(statements: string[]): Promise<Uint8Array> {
  const db = await SqliteDatabase.openUnkeyed();
  for (const sql of statements) db.execSql(sql);
  const bytes = db.toBytes();
  db.close();
  return bytes;
}

export async function buildKeyedSqliteFixture(
  key: Uint8Array,
  statements: string[],
): Promise<Uint8Array> {
  const db = await SqliteDatabase.openKeyed(key);
  for (const sql of statements) db.execSql(sql);
  const bytes = db.toBytes();
  db.close();
  return bytes;
}
