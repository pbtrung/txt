import { useEffect, useState } from "react";

import { useVault } from "../../state/VaultContext";
import { loadLibraryBooks, type LibraryBook } from "./libraryModel";

export interface UseLibraryBooksResult {
  books: LibraryBook[] | null;
  error: string | null;
  loading: boolean;
}

/** Loads every book's metadata/progress once a session exists. null books = still loading. */
export function useLibraryBooks(): UseLibraryBooksResult {
  const { session, getTxtKey } = useVault();
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setBooks(null);
    setError(null);
    loadLibraryBooks(session.db, session.userId, session.umk, getTxtKey)
      .then((result) => {
        if (!cancelled) setBooks(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [session, getTxtKey]);

  return { books, error, loading: books === null && error === null };
}
