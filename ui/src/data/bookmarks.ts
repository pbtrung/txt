// Bookmark tracking (docs/data_model.md's txtBookmarks entity): one
// InstantDB row per account, holding every document's bookmarks as a single
// encrypted JSON blob keyed by txt_id --
// {"<txt_id>": [{"part_num": int, "line": int, "txt_preview": str,
// "created_at": int}, ...], ...} -- rather than a separate SQL row per
// bookmark. Each txt_id's list is capped at BOOKMARKS_MAX_PER_DOC, evicting
// the oldest entry first, all enforced here (no DB-level cap/trigger to
// lean on now that the whole map lives in one column).

export interface Bookmark {
  /** Synthetic, deterministic id (`${txtId}:${partNum}:${line}:${createdAt}`)
   * -- there's no per-bookmark row anymore to hand back a real one, but a
   * stable id is still needed to key a rendered list and to target a
   * specific entry for delete/goto. Deterministic (not random) so decoding
   * the same content twice (e.g. after a refresh) produces the same ids. */
  id: string;
  partNum: number;
  line: number;
  preview: string;
  createdAt: number;
}

/** Keyed by txt_id (an InstantDB row id, not the old integer SQL primary key). */
export type BookmarksMap = Record<string, Bookmark[]>;

export const BOOKMARKS_MAX_PER_DOC = 20;
export const BOOKMARK_PREVIEW_MAX_LEN = 60;

function isBookmarkJson(value: unknown): value is {
  part_num: number;
  line: number;
  txt_preview: string;
  created_at: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.part_num === "number" &&
    typeof v.line === "number" &&
    typeof v.txt_preview === "string" &&
    typeof v.created_at === "number"
  );
}

function bookmarkId(
  txtId: string,
  partNum: number,
  line: number,
  createdAt: number,
): string {
  return `${txtId}:${partNum}:${line}:${createdAt}`;
}

/** Decodes txtBookmarks.content's decrypted JSON into a BookmarksMap --
 * silently drops any entry that doesn't match the expected shape (see
 * access.ts's decodeAccessContent for the same rationale), and sorts each
 * txt_id's list most-recently-created first, matching the old SQL schema's
 * own `ORDER BY created_at DESC` reader. */
export function decodeBookmarksContent(json: unknown): BookmarksMap {
  if (typeof json !== "object" || json === null) return {};
  const map: BookmarksMap = {};
  for (const [txtId, rawList] of Object.entries(
    json as Record<string, unknown>,
  )) {
    if (!Array.isArray(rawList)) continue;
    const list: Bookmark[] = rawList.filter(isBookmarkJson).map((raw) => ({
      id: bookmarkId(txtId, raw.part_num, raw.line, raw.created_at),
      partNum: raw.part_num,
      line: raw.line,
      preview: raw.txt_preview,
      createdAt: raw.created_at,
    }));
    if (list.length > 0) {
      map[txtId] = list.sort((a, b) => b.createdAt - a.createdAt);
    }
  }
  return map;
}

export function encodeBookmarksContent(
  map: BookmarksMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [txtId, list] of Object.entries(map)) {
    out[txtId] = list.map((b) => ({
      part_num: b.partNum,
      line: b.line,
      txt_preview: b.preview,
      created_at: b.createdAt,
    }));
  }
  return out;
}

/** Adds a bookmark at (partNum, line); re-bookmarking an already-bookmarked
 * line is a silent no-op (the old SQL schema's own UNIQUE (txt_id, part_num,
 * line) + INSERT OR IGNORE behavior). Truncates preview to
 * BOOKMARK_PREVIEW_MAX_LEN and evicts the oldest entry first if this would
 * exceed BOOKMARKS_MAX_PER_DOC for this txtId. */
export function addBookmark(
  map: BookmarksMap,
  txtId: string,
  partNum: number,
  line: number,
  preview: string,
  createdAtMs: number,
): BookmarksMap {
  const list = map[txtId] ?? [];
  if (list.some((b) => b.partNum === partNum && b.line === line)) return map;
  const entry: Bookmark = {
    id: bookmarkId(txtId, partNum, line, createdAtMs),
    partNum,
    line,
    preview: preview.slice(0, BOOKMARK_PREVIEW_MAX_LEN),
    createdAt: createdAtMs,
  };
  const next = [entry, ...list]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, BOOKMARKS_MAX_PER_DOC);
  return { ...map, [txtId]: next };
}

export function removeBookmark(
  map: BookmarksMap,
  txtId: string,
  bookmarkIdToRemove: string,
): BookmarksMap {
  const list = map[txtId];
  if (!list) return map;
  const next = list.filter((b) => b.id !== bookmarkIdToRemove);
  const out = { ...map };
  if (next.length > 0) out[txtId] = next;
  else delete out[txtId];
  return out;
}
