// Library shell: coordinates search/navigation state while focused child
// components own the header, responsive navigation, and browsable content.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LoadingMessage, ScreenMessage } from "../../components/ScreenMessage";
import { useVault } from "../../state/VaultContext";
import { errorMessage } from "../../util/errorMessage";
import { clearBookmarksMutation, clearLastAccessMutation } from "../../data/libraryDb";
import {
  createBookShare,
  deleteBookShare,
  shareUrl,
  type BookShare,
} from "../../data/shares";
import { LibraryContent } from "./LibraryContent";
import { LibraryHeader } from "./LibraryHeader";
import { LibraryMenu } from "./LibraryMenu";
import { LibrarySidebar } from "./LibrarySidebar";
import { parseSearch } from "./libraryModel";
import type { LibraryView } from "./libraryView";
import { useLibraryBooks } from "./useLibraryBooks";
import { useShares } from "./useShares";

const INITIAL_VIEW: LibraryView = { kind: "recent" };
const ALL_BOOKS_VIEW: LibraryView = { kind: "books", filter: null };
const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

export function LibraryScreen() {
  const { session, lock } = useVault();
  const library = useLibraryBooks(session?.database ?? null);
  const isAdmin = session?.accountType === "admin";
  const shared = useShares(isAdmin ? (session?.database ?? null) : null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<LibraryView>(INITIAL_VIEW);
  const [selectedTxtId, setSelectedTxtId] = useState<number | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const desktop = useMediaQuery(DESKTOP_MEDIA_QUERY);
  const routerNavigate = useNavigate();

  if (library.status === "loading") {
    return <LoadingMessage>Loading your library…</LoadingMessage>;
  }
  if (library.status === "error") {
    return <ScreenMessage error>{library.error}</ScreenMessage>;
  }

  const navigate = (next: LibraryView) => {
    setView(next);
    setQuery("");
    setSelectedTxtId(null);
  };
  const search = (next: string) => {
    setQuery(next);
    setSelectedTxtId(null);
    if (parseSearch(next).activity || (next.trim() && view.kind === "recent")) {
      setView(ALL_BOOKS_VIEW);
    }
  };
  const selectedBook =
    library.books.find((book) => book.txtId === selectedTxtId) ?? null;
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
  const createShare = async (txtId: number) => {
    if (!session || !isAdmin) return;
    try {
      setShareError(null);
      await createBookShare(session, txtId);
    } catch (error) {
      setShareError(errorMessage(error));
    } finally {
      shared.reload();
    }
  };
  const copyShare = async (share: BookShare) => {
    if (!session || !isAdmin) return;
    try {
      setShareError(null);
      await navigator.clipboard.writeText(await shareUrl(session, share));
    } catch (error) {
      setShareError(errorMessage(error));
    }
  };
  const removeShare = async (share: BookShare) => {
    if (!session || !isAdmin) return;
    try {
      setShareError(null);
      await deleteBookShare(session, share);
    } catch (error) {
      setShareError(errorMessage(error));
    } finally {
      shared.reload();
    }
  };
  return (
    <div className="d-flex flex-column vh-100 mx-auto max-w-md-60 px-2 px-md-0">
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
              shares={shared.shares}
              isAdmin={isAdmin}
            />
          )
        }
        selectedBook={selectedBook}
        showBookActions={view.kind === "books"}
        canShare={isAdmin}
        onRead={() => {
          if (selectedBook) routerNavigate(`/read/${selectedBook.txtId}`);
        }}
        onShare={() => {
          if (selectedBook) void createShare(selectedBook.txtId);
        }}
      />
      {shareError && (
        <div className="alert alert-danger py-2 mx-2 my-1 small" role="alert">
          {shareError}
        </div>
      )}
      <div className="d-flex flex-grow-1 overflow-hidden">
        {desktop && (
          <aside className="h-100 border-end library-sidebar">
            <LibrarySidebar
              books={library.books}
              view={view}
              displayName={session?.displayName ?? ""}
              onNavigate={navigate}
              onLock={lock}
              shares={shared.shares}
              isAdmin={isAdmin}
            />
          </aside>
        )}
        <LibraryContent
          books={library.books}
          view={view}
          query={query}
          selectedTxtId={selectedTxtId}
          onSelectBook={setSelectedTxtId}
          onNavigate={navigate}
          onClearAccess={(txtId) => void clearActivity("access", txtId)}
          onClearBookmarks={(txtId) => void clearActivity("bookmarks", txtId)}
          shares={shared.shares}
          onCopyShare={(share) => void copyShare(share)}
          onDeleteShare={(share) => void removeShare(share)}
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
