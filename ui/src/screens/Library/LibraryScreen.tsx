// Library shell: coordinates search/navigation state while focused child
// components own the header, responsive navigation, and browsable content.
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Text,
  UNSTABLE_Toast,
  UNSTABLE_ToastContent,
  UNSTABLE_ToastQueue,
  UNSTABLE_ToastRegion,
  type QueuedToast,
} from "react-aria-components";
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
  type ShareProgress,
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
const SUCCESS_TOAST_MS = 2500;

type ShareNotice =
  | {
      status: "busy";
      action: "Creating share" | "Copying share link" | "Deleting share";
      title: string;
      step: string;
    }
  | { status: "success" | "error"; message: string };

const shareToastQueue = new UNSTABLE_ToastQueue<ShareNotice>({
  maxVisibleToasts: 1,
});

export function LibraryScreen() {
  const { session, lock } = useVault();
  const library = useLibraryBooks(session?.database ?? null);
  const isAdmin = session?.accountType === "admin";
  const shared = useShares(isAdmin ? (session?.database ?? null) : null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<LibraryView>(INITIAL_VIEW);
  const [selectedTxtId, setSelectedTxtId] = useState<number | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const shareOperation = useRef(false);
  const desktop = useMediaQuery(DESKTOP_MEDIA_QUERY);
  const routerNavigate = useNavigate();

  useEffect(() => () => shareToastQueue.clear(), []);

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
  const beginShareOperation = (
    action: Extract<ShareNotice, { status: "busy" }>["action"],
    title: string,
  ): ShareProgress | null => {
    if (shareOperation.current) return null;
    // Set the lock before React renders the inert overlay so two presses in
    // the same frame cannot start overlapping share operations.
    shareOperation.current = true;
    setShareBusy(true);
    const progress: ShareProgress = (step) =>
      showShareToast({ status: "busy", action, title, step });
    progress("Starting");
    return progress;
  };
  const createShare = async (txtId: number) => {
    if (!session || !isAdmin) return;
    const title = library.books.find((book) => book.txtId === txtId)?.title ?? "Book";
    const progress = beginShareOperation("Creating share", title);
    if (!progress) return;
    try {
      await createBookShare(session, txtId, progress);
      showShareToast(
        { status: "success", message: `Share created for “${title}”` },
        SUCCESS_TOAST_MS,
      );
    } catch (error) {
      showShareToast({ status: "error", message: errorMessage(error) });
    } finally {
      setShareBusy(false);
      shareOperation.current = false;
      shared.reload();
    }
  };
  const copyShare = async (share: BookShare) => {
    if (!session || !isAdmin) return;
    const progress = beginShareOperation("Copying share link", share.title);
    if (!progress) return;
    try {
      const url = await shareUrl(session, share);
      progress("Copying link to clipboard");
      await navigator.clipboard.writeText(url);
      showShareToast(
        { status: "success", message: "Share link copied" },
        SUCCESS_TOAST_MS,
      );
    } catch (error) {
      showShareToast({ status: "error", message: errorMessage(error) });
    } finally {
      setShareBusy(false);
      shareOperation.current = false;
    }
  };
  const removeShare = async (share: BookShare) => {
    if (!session || !isAdmin) return;
    const progress = beginShareOperation("Deleting share", share.title);
    if (!progress) return;
    try {
      await deleteBookShare(session, share, progress);
      shared.remove(share.id);
      showShareToast({ status: "success", message: "Share deleted" }, SUCCESS_TOAST_MS);
    } catch (error) {
      showShareToast({ status: "error", message: errorMessage(error) });
      shared.reload();
    } finally {
      setShareBusy(false);
      shareOperation.current = false;
    }
  };
  return (
    <div className="position-relative vh-100 mx-auto max-w-md-60 px-2 px-md-0 overflow-hidden">
      <div
        className="d-flex flex-column h-100"
        data-testid="library-operation-surface"
        aria-busy={shareBusy || undefined}
        inert={shareBusy || undefined}
      >
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
        <div className="d-flex flex-grow-1 overflow-hidden min-w-0">
          {desktop && (
            <aside className="h-100 border-end library-sidebar library-pane-col">
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
      {shareBusy && <div className="library-operation-blocker" aria-hidden="true" />}
      <ShareToastRegion />
    </div>
  );
}

function showShareToast(notice: ShareNotice, timeout?: number): void {
  shareToastQueue.clear();
  shareToastQueue.add(notice, { timeout });
}

function ShareToastRegion() {
  return (
    <UNSTABLE_ToastRegion
      queue={shareToastQueue}
      className="library-share-toast-region"
      aria-label="Share notifications"
    >
      {({ toast }) => <ShareToast toast={toast} />}
    </UNSTABLE_ToastRegion>
  );
}

function ShareToast({ toast }: { toast: QueuedToast<ShareNotice> }) {
  const notice = toast.content;
  return (
    <UNSTABLE_Toast
      toast={toast}
      className={`toast show library-share-toast ${notice.status === "error" ? "text-bg-danger" : ""}`}
    >
      <UNSTABLE_ToastContent className="toast-body d-flex align-items-center gap-2">
        {notice.status === "busy" && (
          <span
            className="spinner-border spinner-border-sm flex-shrink-0"
            aria-hidden
          />
        )}
        <span className="flex-grow-1 min-w-0">
          {notice.status === "busy" ? (
            <>
              <Text slot="title" className="d-block fw-semibold text-truncate">
                {notice.action}: {notice.title}
              </Text>
              <Text slot="description" className="d-block small text-truncate">
                {notice.step}…
              </Text>
            </>
          ) : (
            <Text slot="title" className="d-block fw-semibold text-truncate">
              {notice.message}
            </Text>
          )}
        </span>
        {notice.status === "error" && (
          <Button
            slot="close"
            className="btn-close btn-close-white flex-shrink-0"
            aria-label="Dismiss notification"
          />
        )}
      </UNSTABLE_ToastContent>
    </UNSTABLE_Toast>
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
