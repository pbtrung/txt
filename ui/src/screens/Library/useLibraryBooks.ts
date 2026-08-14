// The session-selector hook: loads doc/term/doc_term out of the already-
// unlocked session's library index bytes (fetched once at Unlock time,
// held in memory -- see VaultContext) into plain LibraryBook records.
import { useEffect, useState } from "react";
import { loadLibraryBooks, type LibraryBook } from "../../data/libraryIndexDb";

/** null while loading; [] for an account with no library index yet
 * (nothing ingested) or no session at all. */
export function useLibraryBooks(bytes: Uint8Array | null | undefined): LibraryBook[] | null {
  const [books, setBooks] = useState<LibraryBook[] | null>(null);

  useEffect(() => {
    if (!bytes) {
      setBooks([]);
      return;
    }
    let cancelled = false;
    loadLibraryBooks(bytes).then((loaded) => {
      if (!cancelled) setBooks(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  return books;
}
