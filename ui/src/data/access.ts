// One row per user, mirrors docs/data_model.md's txt_access: `access` is a
// brotli(JSON) blob wrapped under this user's own txt_access_key (itself
// wrapped under umk), keyed by txt_id -- {"<txt_id>": {"last_part_num": int,
// "last_accessed": int (unix ms)}, ...}, capped at TXT_ACCESS_LIMIT entries
// (the client evicts the entry with the oldest last_accessed on overflow --
// there's no DB-level enforcement, see the data model doc's Design Notes).
//
// Writes are best-effort: docs/credentials.md notes that a read-only Turso
// token legitimately can't write here (the write-mediation layer for that
// case isn't built yet), so this degrades quietly instead of crashing the
// reader.

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { randomBytes } from "../crypto/bytes";
import { TXT_ACCESS_KEY_LEN, TXT_ACCESS_LIMIT } from "../crypto/constants";
import { requireBlobBytes } from "./db";

export interface ReadPosition {
  lastPartNum: number;
  lastAccessedMs: number;
}

export type AccessMap = Map<number, ReadPosition>;

interface AccessJson {
  last_part_num: number;
  last_accessed: number;
}

function toAccessMap(json: Record<string, AccessJson>): AccessMap {
  const map: AccessMap = new Map();
  for (const [txtIdStr, entry] of Object.entries(json)) {
    map.set(Number(txtIdStr), { lastPartNum: entry.last_part_num, lastAccessedMs: entry.last_accessed });
  }
  return map;
}

function toAccessJson(map: AccessMap): Record<string, AccessJson> {
  const json: Record<string, AccessJson> = {};
  for (const [txtId, position] of map) {
    json[String(txtId)] = { last_part_num: position.lastPartNum, last_accessed: position.lastAccessedMs };
  }
  return json;
}

/** Evicts the entry with the oldest last_accessed until at most TXT_ACCESS_LIMIT remain. */
function evictOldest(map: AccessMap): void {
  while (map.size > TXT_ACCESS_LIMIT) {
    let oldestTxtId: number | null = null;
    let oldestMs = Infinity;
    for (const [txtId, position] of map) {
      if (position.lastAccessedMs < oldestMs) {
        oldestMs = position.lastAccessedMs;
        oldestTxtId = txtId;
      }
    }
    if (oldestTxtId === null) break;
    map.delete(oldestTxtId);
  }
}

async function saveAccess(db: Client, userId: number, txtAccessKey: Uint8Array, map: AccessMap): Promise<void> {
  const encrypted = await blob.encrypt(txtAccessKey, new TextEncoder().encode(JSON.stringify(toAccessJson(map))), {
    compressed: true,
  });
  await db.execute({
    sql: "UPDATE txt_access SET access = ? WHERE user_id = ?",
    args: [encrypted, userId],
  });
}

/** Loads this user's txt_access row, creating it (an encrypted empty object,
 * matching txt/admin.py's _ensure_txt_access) if it doesn't exist yet.
 * Returns the unwrapped txt_access_key and the decrypted read-position map. */
export async function loadOrInitAccess(
  db: Client,
  userId: number,
  umk: Uint8Array,
): Promise<{ txtAccessKey: Uint8Array; accessMap: AccessMap }> {
  const result = await db.execute({
    sql: "SELECT txt_access_key, access FROM txt_access WHERE user_id = ?",
    args: [userId],
  });
  const row = result.rows[0];
  if (row) {
    const txtAccessKey = await blob.decrypt(umk, requireBlobBytes(row.txt_access_key, "txt_access.txt_access_key"));
    const decrypted = await blob.decrypt(txtAccessKey, requireBlobBytes(row.access, "txt_access.access"), true);
    const json = JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, AccessJson>;
    return { txtAccessKey, accessMap: toAccessMap(json) };
  }

  const txtAccessKey = randomBytes(TXT_ACCESS_KEY_LEN);
  const keyBlob = await blob.encrypt(umk, txtAccessKey);
  const accessBlob = await blob.encrypt(txtAccessKey, new TextEncoder().encode("{}"), { compressed: true });
  await db.execute({
    sql: "INSERT INTO txt_access (user_id, txt_access_key, access) VALUES (?, ?, ?)",
    args: [userId, keyBlob, accessBlob],
  });
  return { txtAccessKey, accessMap: new Map() };
}

/** Records a read position, evicting the least-recently-accessed txt_id if
 * this would exceed TXT_ACCESS_LIMIT. Returns the updated map regardless of
 * whether the write succeeded (best-effort, see file comment) so the caller
 * can update its in-memory state optimistically. */
export async function setReadPosition(
  db: Client,
  userId: number,
  txtAccessKey: Uint8Array,
  currentMap: AccessMap,
  txtId: number,
  position: ReadPosition,
): Promise<AccessMap> {
  const next = new Map(currentMap);
  next.set(txtId, position);
  evictOldest(next);
  try {
    await saveAccess(db, userId, txtAccessKey, next);
  } catch (err) {
    console.warn(`txt_access write skipped for txt_id=${txtId}: ${String(err)}`);
  }
  return next;
}

/** Removes a single txt_id's read position -- e.g. "remove from Recent". */
export async function removeAccessEntry(
  db: Client,
  userId: number,
  txtAccessKey: Uint8Array,
  currentMap: AccessMap,
  txtId: number,
): Promise<AccessMap> {
  const next = new Map(currentMap);
  next.delete(txtId);
  try {
    await saveAccess(db, userId, txtAccessKey, next);
  } catch (err) {
    console.warn(`txt_access removal skipped for txt_id=${txtId}: ${String(err)}`);
  }
  return next;
}
