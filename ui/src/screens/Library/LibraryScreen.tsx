// Library shell: coordinates search/navigation state while focused child
// components own the header, responsive navigation, and browsable content.
import { useEffect, useState } from "react";
import { LoadingMessage, ScreenMessage } from "../../components/ScreenMessage";
import { useVault } from "../../state/VaultContext";
import { clearBookmarksMutation, clearLastAccessMutation } from "../../data/libraryDb";
import { LibraryContent } from "./LibraryContent";
import { LibraryHeader } from "./LibraryHeader";
import { LibraryMenu } from "./LibraryMenu";
import { LibrarySidebar } from "./LibrarySidebar";
import { parseSearch } from "./libraryModel";
import type { LibraryView } from "./libraryView";
import { useLibraryBooks } from "./useLibraryBooks";

const INITIAL_VIEW: LibraryView = { kind: "recent" };
const ALL_BOOKS_VIEW: LibraryView = { kind: "books", filter: null };
const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

export function LibraryScreen() {
  const { session, lock } = useVault();
  const library = useLibraryBooks(session?.database ?? null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<LibraryView>(INITIAL_VIEW);
  const desktop = useMediaQuery(DESKTOP_MEDIA_QUERY);

  if (library.status === "loading") {
    return <LoadingMessage>Loading your library…</LoadingMessage>;
  }
  if (library.status === "error") {
    return <ScreenMessage error>{library.error}</ScreenMessage>;
  }

  const navigate = (next: LibraryView) => {
    setView(next);
    setQuery("");
  };
  const search = (next: string) => {
    setQuery(next);
    if (parseSearch(next).activity || (next.trim() && view.kind === "recent")) {
      setView(ALL_BOOKS_VIEW);
    }
  };
  const clearActivity = async (kind: "access" | "bookmarks", txtId: number) => {
    if (!session) return;
    const mutation =
      kind === "access"
        ? clearLastAccessMutation(txtId)
        : clearBookmarksMutation(txtId);
    try {
      await session.database.mutate(mutation);
    } catch {
      // LibraryDatabaseStore retains the failed mutation and error for retry.
    } finally {
      library.reload();
    }
  };
  return (
    <div className="d-flex flex-column vh-100 mx-auto max-w-md-80 px-2 px-md-0">
      <LibraryHeader
        query={query}
        onQuery={search}
        menu={
          desktop ? null : (
            <LibraryMenu
              books={library.books}
              view={view}
              displayName={session?.displayName ?? ""}
              onNavigate={navigate}
              onLock={lock}
            />
          )
        }
      />
      <div className="d-flex flex-grow-1 overflow-hidden">
        {desktop && (
          <aside className="h-100 border-end library-sidebar">
            <LibrarySidebar
              books={library.books}
              view={view}
              displayName={session?.displayName ?? ""}
              onNavigate={navigate}
              onLock={lock}
            />
          </aside>
        )}
        <LibraryContent
          books={library.books}
          view={view}
          query={query}
          onNavigate={navigate}
          onClearAccess={(txtId) => void clearActivity("access", txtId)}
          onClearBookmarks={(txtId) => void clearActivity("bookmarks", txtId)}
        />
      </div>
    </div>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}
