// The session-selector hook: loads the txt table's catalog out of the
// already-unlocked session's open SqliteDatabase (VaultContext) into plain
// LibraryBook records.
import { useEffect, useState } from "react";
import { loadLibraryBooks, type LibraryBook } from "../../data/libraryDb";
import type { SqliteDatabase } from "../../data/sqlite";

/** null while loading; [] for a session with no database yet (locked) or
 * an account with nothing ingested. */
export function useLibraryBooks(db: SqliteDatabase | null): LibraryBook[] | null {
  const [books, setBooks] = useState<LibraryBook[] | null>(null);

  useEffect(() => {
    if (!db) {
      setBooks([]);
      return;
    }
    let cancelled = false;
    loadLibraryBooks(db).then((loaded) => {
      if (!cancelled) setBooks(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [db]);

  return books;
}
