// Per-(user, txt) read position, mirrors docs/data_model.md's txt_access:
// a brotli(JSON) blob wrapped under that document's txt_key,
// {"last_part_num": int, "last_accessed": int (unix ms)}.
//
// Writes are best-effort: docs/credentials.md notes that a read-only Turso
// token legitimately can't write here (the write-mediation layer for that
// case isn't built yet), so this degrades quietly instead of crashing the
// reader.

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { requireBlobBytes } from "./db";

export interface ReadPosition {
  lastPartNum: number;
  lastAccessedMs: number;
}

interface AccessJson {
  last_part_num: number;
  last_accessed: number;
}

export async function getReadPosition(
  db: Client,
  txtId: number,
  userId: number,
  txtKey: Uint8Array,
): Promise<ReadPosition | null> {
  const result = await db.execute({
    sql: "SELECT access FROM txt_access WHERE txt_id = ? AND user_id = ?",
    args: [txtId, userId],
  });
  const row = result.rows[0];
  if (!row) return null;
  const decrypted = await blob.decrypt(txtKey, requireBlobBytes(row.access, "txt_access.access"), true);
  const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as AccessJson;
  return { lastPartNum: parsed.last_part_num, lastAccessedMs: parsed.last_accessed };
}

export async function setReadPosition(
  db: Client,
  txtId: number,
  userId: number,
  txtKey: Uint8Array,
  position: ReadPosition,
): Promise<void> {
  try {
    const payload: AccessJson = { last_part_num: position.lastPartNum, last_accessed: position.lastAccessedMs };
    const encrypted = await blob.encrypt(txtKey, new TextEncoder().encode(JSON.stringify(payload)), {
      compressed: true,
    });
    await db.execute({
      sql: `INSERT INTO txt_access (txt_id, user_id, access) VALUES (?, ?, ?)
            ON CONFLICT (txt_id, user_id) DO UPDATE SET access = excluded.access`,
      args: [txtId, userId, encrypted],
    });
  } catch (err) {
    console.warn(`txt_access write skipped for txt_id=${txtId}: ${String(err)}`);
  }
}
