// The session-selector hook: loads the txt table's catalog out of the
// already-unlocked session's open SqliteDatabase (VaultContext) into plain
// LibraryBook records.
import { useEffect, useState } from "react";
import type { LibraryDatabaseStore } from "../../data/databaseStore";
import { loadLibraryBooks, type LibraryBook } from "../../data/libraryDb";
import { errorMessage } from "../../util/errorMessage";

export type LibraryState =
  | { status: "loading" }
  | { status: "ready"; books: LibraryBook[] }
  | { status: "error"; error: string };

interface LoadedLibrary {
  database: LibraryDatabaseStore;
  state: LibraryState;
}

export function useLibraryBooks(database: LibraryDatabaseStore | null): LibraryState {
  const [loaded, setLoaded] = useState<LoadedLibrary | null>(null);
  useEffect(() => {
    if (!database) return;
    const source = database;
    let cancelled = false;
    source
      .read(loadLibraryBooks)
      .then((books) => setLoadedUnlessCancelled({ status: "ready", books }))
      .catch((error: unknown) =>
        setLoadedUnlessCancelled({ status: "error", error: errorMessage(error) }),
      );
    function setLoadedUnlessCancelled(state: LibraryState) {
      if (!cancelled) setLoaded({ database: source, state });
    }
    return () => {
      cancelled = true;
    };
  }, [database]);
  if (!database) return { status: "ready", books: [] };
  return loaded?.database === database ? loaded.state : { status: "loading" };
}
