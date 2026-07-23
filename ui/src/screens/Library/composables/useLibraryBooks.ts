import { computed, type ComputedRef } from "vue";

import { useVault } from "../../../state/vault";
import { buildLibraryBooks, type LibraryBook } from "../libraryModel";

export interface UseLibraryBooksResult {
  books: ComputedRef<LibraryBook[] | null>;
  loading: ComputedRef<boolean>;
}

/** Derives the Library's book list from data the session already loaded in
 * full during unlock (session.metadataById, session.accessMap) -- no DB
 * calls of its own. `loading` is only ever true for the brief window before
 * a session exists at all. */
export function useLibraryBooks(): UseLibraryBooksResult {
  const { session, accessMap } = useVault();

  const books = computed<LibraryBook[] | null>(() => {
    if (!session.value) return null;
    return buildLibraryBooks(session.value.metadataById, accessMap.value);
  });

  return { books, loading: computed(() => books.value === null) };
}
