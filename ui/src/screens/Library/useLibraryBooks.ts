// The session-selector hook: reads the already-loaded LibraryStore's
// current book list (VaultContext), reloading on demand. Unlike the old
// SQLite-backed store, LibraryStore.open() fully loads before a session
// is ever exposed to React, so there is no separate "loading" state here.
import { useCallback, useState, useSyncExternalStore } from "react";
import type { LibraryBook, LibraryStore } from "../../data/libraryStore";
import { errorMessage } from "../../util/errorMessage";

export type LibraryState =
  | { status: "ready"; books: LibraryBook[]; reload: () => void }
  | { status: "error"; error: string };

const NO_BOOKS: LibraryBook[] = [];

export function useLibraryBooks(library: LibraryStore | null): LibraryState {
  const [reloadError, setReloadError] = useState<string | null>(null);
  const books = useSyncExternalStore(
    useCallback(
      (listener) => (library ? library.subscribe(listener) : () => undefined),
      [library],
    ),
    () => library?.snapshot() ?? NO_BOOKS,
  );
  const reload = useCallback(() => {
    if (!library) return;
    setReloadError(null);
    library.reload().catch((error: unknown) => setReloadError(errorMessage(error)));
  }, [library]);
  if (reloadError) return { status: "error", error: reloadError };
  return { status: "ready", books, reload };
}
