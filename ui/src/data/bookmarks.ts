// One row per user, mirrors docs/data_model.md's bookmarks: `bookmark` is a
// brotli(JSON) blob wrapped under this user's own bookmark_key (itself
// wrapped under umk), keyed by txt_id -- {"<txt_id>": [{"part_num": int,
// "line": int, "txt_preview": str, "created_at": int (unix ms)}, ...], ...},
// each txt_id's list capped at BOOKMARK_LIMIT entries (the client evicts the
// oldest-created_at entry on overflow -- there's no DB-level enforcement,
// see the data model doc's Design Notes).
//
// Like txt_access, writes are best-effort -- see access.ts's comment.

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { randomBytes } from "../crypto/bytes";
import { BOOKMARK_KEY_LEN, BOOKMARK_LIMIT } from "../crypto/constants";
import { requireBlobBytes } from "./db";

export interface BookmarkEntry {
  partNum: number;
  line: number;
  txtPreview: string;
  createdAt: number;
}

export type BookmarksMap = Map<number, BookmarkEntry[]>;

interface BookmarkJson {
  part_num: number;
  line: number;
  txt_preview: string;
  created_at: number;
}

function toBookmarksMap(json: Record<string, BookmarkJson[]>): BookmarksMap {
  const map: BookmarksMap = new Map();
  for (const [txtIdStr, entries] of Object.entries(json)) {
    map.set(
      Number(txtIdStr),
      entries.map((e) => ({ partNum: e.part_num, line: e.line, txtPreview: e.txt_preview, createdAt: e.created_at })),
    );
  }
  return map;
}

function toBookmarksJson(map: BookmarksMap): Record<string, BookmarkJson[]> {
  const json: Record<string, BookmarkJson[]> = {};
  for (const [txtId, entries] of map) {
    json[String(txtId)] = entries.map((e) => ({
      part_num: e.partNum,
      line: e.line,
      txt_preview: e.txtPreview,
      created_at: e.createdAt,
    }));
  }
  return json;
}

async function saveBookmarks(db: Client, userId: number, bookmarkKey: Uint8Array, map: BookmarksMap): Promise<void> {
  const encrypted = await blob.encrypt(bookmarkKey, new TextEncoder().encode(JSON.stringify(toBookmarksJson(map))), {
    compressed: true,
  });
  await db.execute({
    sql: "UPDATE bookmarks SET bookmark = ? WHERE user_id = ?",
    args: [encrypted, userId],
  });
}

/** Loads this user's bookmarks row, creating it (an encrypted empty object,
 * matching txt/admin.py's _ensure_bookmarks) if it doesn't exist yet.
 * Returns the unwrapped bookmark_key and the decrypted per-txt_id lists. */
export async function loadOrInitBookmarks(
  db: Client,
  userId: number,
  umk: Uint8Array,
): Promise<{ bookmarkKey: Uint8Array; bookmarksMap: BookmarksMap }> {
  const result = await db.execute({
    sql: "SELECT bookmark_key, bookmark FROM bookmarks WHERE user_id = ?",
    args: [userId],
  });
  const row = result.rows[0];
  if (row) {
    const bookmarkKey = await blob.decrypt(umk, requireBlobBytes(row.bookmark_key, "bookmarks.bookmark_key"));
    const decrypted = await blob.decrypt(bookmarkKey, requireBlobBytes(row.bookmark, "bookmarks.bookmark"), true);
    const json = JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, BookmarkJson[]>;
    return { bookmarkKey, bookmarksMap: toBookmarksMap(json) };
  }

  const bookmarkKey = randomBytes(BOOKMARK_KEY_LEN);
  const keyBlob = await blob.encrypt(umk, bookmarkKey);
  const bookmarkBlob = await blob.encrypt(bookmarkKey, new TextEncoder().encode("{}"), { compressed: true });
  await db.execute({
    sql: "INSERT INTO bookmarks (user_id, bookmark_key, bookmark) VALUES (?, ?, ?)",
    args: [userId, keyBlob, bookmarkBlob],
  });
  return { bookmarkKey, bookmarksMap: new Map() };
}

/** Appends a bookmark for (txtId, partNum, line), evicting that txt_id's
 * oldest-created_at bookmark if this would exceed BOOKMARK_LIMIT. Returns
 * the updated map regardless of whether the write succeeded (best-effort). */
export async function addBookmark(
  db: Client,
  userId: number,
  bookmarkKey: Uint8Array,
  currentMap: BookmarksMap,
  txtId: number,
  partNum: number,
  line: number,
  txtPreview: string,
): Promise<BookmarksMap> {
  const next = new Map(currentMap);
  const entries = [...(next.get(txtId) ?? []), { partNum, line, txtPreview, createdAt: Date.now() }];
  entries.sort((a, b) => a.createdAt - b.createdAt);
  while (entries.length > BOOKMARK_LIMIT) {
    entries.shift();
  }
  next.set(txtId, entries);
  try {
    await saveBookmarks(db, userId, bookmarkKey, next);
  } catch (err) {
    console.warn(`bookmark write skipped for txt_id=${txtId}: ${String(err)}`);
  }
  return next;
}

/** Removes one bookmark, identified by (txtId, createdAt) -- good enough
 * uniqueness for a user-triggered action. Drops the txt_id key entirely once
 * its list is empty. Returns the updated map regardless of whether the write
 * succeeded (best-effort). */
export async function removeBookmark(
  db: Client,
  userId: number,
  bookmarkKey: Uint8Array,
  currentMap: BookmarksMap,
  txtId: number,
  createdAt: number,
): Promise<BookmarksMap> {
  const next = new Map(currentMap);
  const remaining = (next.get(txtId) ?? []).filter((entry) => entry.createdAt !== createdAt);
  if (remaining.length > 0) {
    next.set(txtId, remaining);
  } else {
    next.delete(txtId);
  }
  try {
    await saveBookmarks(db, userId, bookmarkKey, next);
  } catch (err) {
    console.warn(`bookmark removal skipped for txt_id=${txtId}: ${String(err)}`);
  }
  return next;
}
