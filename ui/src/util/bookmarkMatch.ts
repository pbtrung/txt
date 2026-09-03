// Shared "does a bookmark exist at this CFI" lookup: useReadingState.ts
// (server-persisted) and useSharedReadingState.ts (localStorage-persisted)
// both repeat this exact match, more than once each. Their actual toggle
// actions differ too much to share (one awaits the server and re-fetches;
// the other rebuilds and caps a local array synchronously), so only the
// lookup itself is factored out here.
export function findBookmarkByCfi<T extends { cfi: string }>(
  bookmarks: T[],
  cfi: string,
): T | undefined {
  return bookmarks.find((bookmark) => bookmark.cfi === cfi);
}

export function isBookmarkedAt<T extends { cfi: string }>(
  bookmarks: T[],
  cfi: string | null,
): boolean {
  return cfi !== null && bookmarks.some((bookmark) => bookmark.cfi === cfi);
}
