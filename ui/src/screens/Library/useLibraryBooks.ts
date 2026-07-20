import { useEffect, useState } from "react";

import { useVault } from "../../state/VaultContext";
import { loadLibraryBooks, loadPartCount, type LibraryBook } from "./libraryModel";

export interface UseLibraryBooksResult {
  books: LibraryBook[] | null;
  error: string | null;
  loading: boolean;
}

/** Loads every book's metadata/read-position once a session exists, then
 * fills in each book's part count in the background (see
 * libraryModel.ts's loadLibraryBooks comment for why that's a separate,
 * later pass) -- null books = still loading the initial list.
 */
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
        if (cancelled) return;
        setBooks(result);
        for (const book of result) {
          loadPartCount(session.db, book.txtId)
            .then((partCount) => {
              if (cancelled) return;
              setBooks((prev) => prev?.map((b) => (b.txtId === book.txtId ? { ...b, partCount } : b)) ?? prev);
            })
            .catch((err: unknown) => {
              console.warn(`part count load failed for txt_id=${book.txtId}: ${String(err)}`);
            });
        }
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
