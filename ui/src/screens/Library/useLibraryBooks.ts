// The session-selector hook: reads the LibraryStore's current book list
// (VaultContext), reloading on demand. Unlike the old SQLite-backed
// store, unlocking a session no longer waits for the library to load
// (LibraryStore.create() starts reload() in the background rather than
// blocking on it) -- so this surfaces a real "loading" status for the
// first load, derived from the store's own statusSnapshot() rather than
// guessing from an empty book list.
import { useCallback, useSyncExternalStore } from "react";
import type {
  LibraryBook,
  LibraryStore,
  LibraryStoreStatus,
} from "../../data/libraryStore";

export type LibraryState =
  | { status: "loading" }
  | { status: "ready"; books: LibraryBook[]; reload: () => void }
  | { status: "error"; error: string };

const NO_BOOKS: LibraryBook[] = [];
const INITIAL_STATUS: LibraryStoreStatus = {
  pending: true,
  error: null,
  loadedOnce: false,
};

export function useLibraryBooks(library: LibraryStore | null): LibraryState {
  const subscribe = useCallback(
    (listener: () => void) => (library ? library.subscribe(listener) : () => undefined),
    [library],
  );
  const books = useSyncExternalStore(subscribe, () => library?.snapshot() ?? NO_BOOKS);
  const status = useSyncExternalStore(
    subscribe,
    () => library?.statusSnapshot() ?? INITIAL_STATUS,
  );
  const reload = useCallback(() => {
    library?.reload().catch(() => {}); // failure surfaces via status.error above
  }, [library]);
  if (status.error) return { status: "error", error: status.error };
  if (!status.loadedOnce) return { status: "loading" };
  return { status: "ready", books, reload };
}
