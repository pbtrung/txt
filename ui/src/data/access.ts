// Read-position tracking (docs/data_model.md's txtAccess entity): one
// InstantDB row per account, holding every document's read position as a
// single encrypted JSON blob keyed by txt_id --
// {"<txt_id>": {"last_part_num": int, "last_accessed": int}, ...} -- rather
// than a separate SQL row per document. Capped at ACCESS_MAX_ENTRIES,
// evicting the entry with the oldest lastAccessedMs first, all enforced here
// (no DB-level cap) since the whole map lives in one column.

export interface ReadPosition {
  lastPartNum: number;
  lastAccessedMs: number;
}

/** Keyed by txt_id (an InstantDB row id, not the old integer SQL primary key). */
export type AccessMap = Record<string, ReadPosition>;

export const ACCESS_MAX_ENTRIES = 10;

function isReadPositionJson(
  value: unknown,
): value is { last_part_num: number; last_accessed: number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.last_part_num === "number" && typeof v.last_accessed === "number"
  );
}

/** Decodes txtAccess.content's decrypted JSON into an AccessMap -- silently
 * drops any entry that doesn't match the expected shape rather than
 * throwing, so one malformed entry can't block reading every other one. */
export function decodeAccessContent(json: unknown): AccessMap {
  if (typeof json !== "object" || json === null) return {};
  const map: AccessMap = {};
  for (const [txtId, raw] of Object.entries(json as Record<string, unknown>)) {
    if (isReadPositionJson(raw)) {
      map[txtId] = {
        lastPartNum: raw.last_part_num,
        lastAccessedMs: raw.last_accessed,
      };
    }
  }
  return map;
}

export function encodeAccessContent(map: AccessMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [txtId, position] of Object.entries(map)) {
    out[txtId] = {
      last_part_num: position.lastPartNum,
      last_accessed: position.lastAccessedMs,
    };
  }
  return out;
}

/** Sets (or overwrites) txtId's read position, evicting the entry with the
 * oldest lastAccessedMs first if this would exceed ACCESS_MAX_ENTRIES. */
export function setReadPosition(
  map: AccessMap,
  txtId: string,
  position: ReadPosition,
): AccessMap {
  const next: AccessMap = { ...map, [txtId]: position };
  const keys = Object.keys(next);
  if (keys.length > ACCESS_MAX_ENTRIES) {
    const oldest = keys.reduce((a, b) =>
      next[a]!.lastAccessedMs <= next[b]!.lastAccessedMs ? a : b,
    );
    // Never evict the entry just written, even if its own lastAccessedMs
    // happens to be the oldest (a caller-supplied timestamp, not generated
    // here) -- the eviction is only ever meant to make room for a genuinely
    // new entry.
    if (oldest !== txtId) delete next[oldest];
  }
  return next;
}

/** "Remove from recently opened" (LibraryScreen.tsx) -- clears a document's
 * read position entirely, rather than resetting it to some sentinel. */
export function clearReadPosition(map: AccessMap, txtId: string): AccessMap {
  const next = { ...map };
  delete next[txtId];
  return next;
}
