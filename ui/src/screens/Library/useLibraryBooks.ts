// The session-selector hook: loads the txt table's catalog out of the
// already-unlocked session's open SqliteDatabase (VaultContext) into plain
// LibraryBook records.
import { useEffect, useState } from "react";
import { loadLibraryBooks, type LibraryBook } from "../../data/libraryDb";
import type { SqliteDatabase } from "../../data/sqlite";
import { errorMessage } from "../../util/errorMessage";

export type LibraryState =
  | { status: "loading" }
  | { status: "ready"; books: LibraryBook[] }
  | { status: "error"; error: string };

interface LoadedLibrary {
  db: SqliteDatabase;
  state: LibraryState;
}

export function useLibraryBooks(db: SqliteDatabase | null): LibraryState {
  const [loaded, setLoaded] = useState<LoadedLibrary | null>(null);
  useEffect(() => {
    if (!db) return;
    const source = db;
    let cancelled = false;
    loadLibraryBooks(source)
      .then((books) => setLoadedUnlessCancelled({ status: "ready", books }))
      .catch((error: unknown) =>
        setLoadedUnlessCancelled({ status: "error", error: errorMessage(error) }),
      );
    function setLoadedUnlessCancelled(state: LibraryState) {
      if (!cancelled) setLoaded({ db: source, state });
    }
    return () => {
      cancelled = true;
    };
  }, [db]);
  if (!db) return { status: "ready", books: [] };
  return loaded?.db === db ? loaded.state : { status: "loading" };
}
