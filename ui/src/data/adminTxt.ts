// Admin Manage screen: deleting one of the admin's own txt. A Turso-only
// port of txt/delete.py's TxtDeleter -- deliberately never touches R2, since
// the browser stays R2 read-only even for an admin session (see
// docs/credentials.md). Deletes txt_parts/txt_shares/part_count rows and the
// txt row itself; leaves two things intentionally alone, both a direct
// consequence of that read-only invariant:
//
// - The txt's R2 part objects become orphans, swept up later by the
//   existing `txt.py --txt-clean-bucket` CLI command, which already does
//   exactly this (same as this app's other browser-side deletes).
// - Its txt_metadata entry, unlike txt_access/bookmarks, lives in an R2
//   object (not inline in Turso, since the earlier txt_metadata-to-R2
//   migration) -- scrubbing it would mean rewriting that object, an R2 PUT.
//   Left stale instead: harmless, since nothing looks up a txt_metadata
//   entry once its txt row is gone (and txt.id is AUTOINCREMENT, so a
//   future txt_id can never collide with the orphaned entry's key).
//
// txt_access/bookmarks entries for this txt_id *are* scrubbed -- those are
// plain Turso columns, no R2 involved, so there's no reason to leave them
// stale (see VaultContext's deleteTxt, which calls this alongside
// access.ts's removeAccessEntry / bookmarks.ts's removeAllBookmarksForTxt).
//
// Reused as-is by adminUsers.ts's deleteUser, which deletes every txt a
// user owns as part of a full account teardown.

import type { Client } from "@libsql/core/api";

export async function deleteTxtRows(db: Client, txtId: number): Promise<void> {
  await db.execute({ sql: "DELETE FROM txt_parts WHERE txt_id = ?", args: [txtId] });
  await db.execute({ sql: "DELETE FROM txt_shares WHERE txt_id = ?", args: [txtId] });
  await db.execute({ sql: "DELETE FROM part_count WHERE txt_id = ?", args: [txtId] });
  await db.execute({ sql: "DELETE FROM txt WHERE id = ?", args: [txtId] });
}
