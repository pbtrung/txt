import { useMemo } from "react";

import { useVault } from "../../state/VaultContext";
import { buildLibraryBooks, type LibraryBook } from "./libraryModel";

export interface UseLibraryBooksResult {
  books: LibraryBook[] | null;
  loading: boolean;
}

/** Derives the Library's book list from data the session already loaded in
 * full during unlock (session.metadataById, session.accessMap) -- no DB
 * calls of its own. `loading` is only ever true for the brief window before
 * a session exists at all. */
export function useLibraryBooks(): UseLibraryBooksResult {
  const { session, accessMap } = useVault();

  const books = useMemo(() => {
    if (!session) return null;
    return buildLibraryBooks(session.metadataById, accessMap);
  }, [session, accessMap]);

  return { books, loading: books === null };
}
