// Per-(user, txt) bookmark list, mirrors docs/data_model.md's bookmarks
// table: one row per bookmark, each a brotli(JSON) blob wrapped under that
// document's txt_key -- {"part_num": int, "line": int, "txt_preview": str},
// a specific line within a part plus a preview of its text, so a bookmark
// is actually enough to relocate the spot it marks. The FIFO-eviction
// trigger (trg_limit_bookmarks_per_file, capping each user at
// BOOKMARK_LIMIT per txt) already lives in the schema, so adding one here
// needs no client-side cleanup step.
//
// Like txt_access, writes are best-effort -- see access.ts's comment.

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { requireBlobBytes } from "./db";

export interface Bookmark {
  id: number;
  partNum: number;
  line: number;
  txtPreview: string;
}

interface BookmarkJson {
  part_num: number;
  line: number;
  txt_preview: string;
}

/** Most recent first, per docs/ui.md's Reader mock -- bookmarks.id order, since bookmarks carry no timestamp of their own. */
export async function listBookmarks(db: Client, txtId: number, userId: number, txtKey: Uint8Array): Promise<Bookmark[]> {
  const result = await db.execute({
    sql: "SELECT id, bookmark FROM bookmarks WHERE txt_id = ? AND user_id = ? ORDER BY id DESC",
    args: [txtId, userId],
  });
  const bookmarks: Bookmark[] = [];
  for (const row of result.rows) {
    const decrypted = await blob.decrypt(txtKey, requireBlobBytes(row.bookmark, "bookmarks.bookmark"), true);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as BookmarkJson;
    bookmarks.push({ id: Number(row.id), partNum: parsed.part_num, line: parsed.line, txtPreview: parsed.txt_preview });
  }
  return bookmarks;
}

export async function addBookmark(
  db: Client,
  txtId: number,
  userId: number,
  txtKey: Uint8Array,
  partNum: number,
  line: number,
  txtPreview: string,
): Promise<void> {
  try {
    const payload: BookmarkJson = { part_num: partNum, line, txt_preview: txtPreview };
    const encrypted = await blob.encrypt(txtKey, new TextEncoder().encode(JSON.stringify(payload)), {
      compressed: true,
    });
    await db.execute({
      sql: "INSERT INTO bookmarks (txt_id, user_id, bookmark) VALUES (?, ?, ?)",
      args: [txtId, userId, encrypted],
    });
  } catch (err) {
    console.warn(`bookmark write skipped for txt_id=${txtId}: ${String(err)}`);
  }
}
