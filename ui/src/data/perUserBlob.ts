// Shared mechanics behind every "one row per user, an encrypted JSON blob
// wrapped under its own sub-key (itself wrapped under umk)" table -- both
// txt_access (access.ts) and bookmarks (bookmarks.ts) follow this shape
// exactly: SELECT the key+blob; if the row doesn't exist yet, generate a
// random key, wrap it under umk, encrypt an empty JSON object under it, and
// INSERT (matching txt/admin.py's _ensure_txt_access/_ensure_bookmarks). On
// save, JSON-encode + brotli-compress + encrypt under the sub-key, then
// UPDATE. Only the JSON shape (object vs per-key array) and eviction policy
// differ between the two tables -- those stay in access.ts/bookmarks.ts.

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { randomBytes } from "../crypto/bytes";
import { decryptJson } from "./decryptJson";
import { requireBlobBytes } from "./db";

interface PerUserBlobTable {
  table: string;
  keyColumn: string;
  blobColumn: string;
}

/** Loads this user's row from `table`, creating it (an encrypted empty JSON
 * object) if it doesn't exist yet. Returns the unwrapped sub-key and the
 * parsed JSON value. */
export async function loadOrInitPerUserBlob<T>(
  db: Client,
  { table, keyColumn, blobColumn }: PerUserBlobTable,
  userId: number,
  umk: Uint8Array,
  keyLen: number,
  parse: (json: unknown) => T,
  empty: T,
): Promise<{ key: Uint8Array; value: T }> {
  const result = await db.execute({
    sql: `SELECT ${keyColumn}, ${blobColumn} FROM ${table} WHERE user_id = ?`,
    args: [userId],
  });
  const row = result.rows[0];
  if (row) {
    const key = await blob.decrypt(umk, requireBlobBytes(row[keyColumn], `${table}.${keyColumn}`));
    const json = await decryptJson(key, requireBlobBytes(row[blobColumn], `${table}.${blobColumn}`));
    return { key, value: parse(json) };
  }

  const key = randomBytes(keyLen);
  const keyBlob = await blob.encrypt(umk, key);
  const emptyBlob = await blob.encrypt(key, new TextEncoder().encode("{}"), { compressed: true });
  await db.execute({
    sql: `INSERT INTO ${table} (user_id, ${keyColumn}, ${blobColumn}) VALUES (?, ?, ?)`,
    args: [userId, keyBlob, emptyBlob],
  });
  return { key, value: empty };
}

/** Encrypts `json` under `key` and writes it to this user's row in `table`. */
export async function savePerUserBlob(
  db: Client,
  { table, blobColumn }: Pick<PerUserBlobTable, "table" | "blobColumn">,
  userId: number,
  key: Uint8Array,
  json: unknown,
): Promise<void> {
  const encrypted = await blob.encrypt(key, new TextEncoder().encode(JSON.stringify(json)), { compressed: true });
  await db.execute({
    sql: `UPDATE ${table} SET ${blobColumn} = ? WHERE user_id = ?`,
    args: [encrypted, userId],
  });
}
