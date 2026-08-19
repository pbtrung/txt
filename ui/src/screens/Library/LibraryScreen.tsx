// Library shell: coordinates search/navigation state while focused child
// components own the header, responsive navigation, and browsable content.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
import type { DatabaseMutation } from "../../data/databaseStore";
import { clearLastAccessMutation } from "../../data/libraryDb";
import { deleteBookmarkMutation } from "../../data/readingState";
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
const LIBRARY_SIDEBAR_WIDTH_PX = 16 * 16;
const LIBRARY_RIGHT_PANE_MIN_PX = 400;
const SUCCESS_TOAST_MS = 2500;

type LibraryOperationAction =
  | "Creating share"
  | "Copying share link"
  | "Deleting share"
  | "Deleting recent access"
  | "Deleting bookmark";

type LibraryNotice =
  | {
      status: "busy";
      action: LibraryOperationAction;
      title: string;
      step: string;
    }
  | { status: "success" | "error"; message: string };

const libraryToastQueue = new UNSTABLE_ToastQueue<LibraryNotice>({
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
  const [selectedShareId, setSelectedShareId] = useState<number | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const operation = useRef(false);
  const libraryRoot = useRef<HTMLDivElement>(null);
  const librarySidebar = useRef<HTMLElement>(null);
  const showSidebar = useLibrarySidebar(
    libraryRoot,
    librarySidebar,
    library.status === "ready",
  );
  const routerNavigate = useNavigate();

  useEffect(() => () => libraryToastQueue.clear(), []);

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
    setSelectedShareId(null);
  };
  const search = (next: string) => {
    setQuery(next);
    setSelectedTxtId(null);
    setSelectedShareId(null);
    if (parseSearch(next).activity || (next.trim() && view.kind === "recent")) {
      setView(ALL_BOOKS_VIEW);
    }
  };
  const selectedBook =
    library.books.find((book) => book.txtId === selectedTxtId) ?? null;
  const selectedShare =
    shared.shares.find((share) => share.id === selectedShareId) ?? null;
  const updateActivity = async (
    action: Extract<
      LibraryOperationAction,
      "Deleting recent access" | "Deleting bookmark"
    >,
    title: string,
    mutation: DatabaseMutation,
    success: string,
  ) => {
    if (!session) return;
    const progress = beginOperation(action, title);
    if (!progress) return;
    try {
      progress("Saving encrypted library");
      await session.database.mutate(mutation);
      progress("Refreshing Recent");
      library.reload();
      showLibraryToast({ status: "success", message: success }, SUCCESS_TOAST_MS);
    } catch (error) {
      showLibraryToast({ status: "error", message: errorMessage(error) });
      // LibraryDatabaseStore retains a failed mutation for retry. Reload so
      // Recent reflects the store's authoritative post-failure state.
      library.reload();
    } finally {
      setOperationBusy(false);
      operation.current = false;
    }
  };
  const beginOperation = (
    action: LibraryOperationAction,
    title: string,
  ): ShareProgress | null => {
    if (operation.current) return null;
    // Set the lock before React renders the inert overlay so two presses in
    // the same frame cannot start overlapping Library operations.
    operation.current = true;
    setOperationBusy(true);
    const progress: ShareProgress = (step) =>
      showLibraryToast({ status: "busy", action, title, step });
    progress("Starting");
    return progress;
  };
  const createShare = async (txtId: number) => {
    if (!session || !isAdmin) return;
    const title = library.books.find((book) => book.txtId === txtId)?.title ?? "Book";
    const progress = beginOperation("Creating share", title);
    if (!progress) return;
    try {
      await createBookShare(session, txtId, progress);
      showLibraryToast(
        { status: "success", message: `Share created for “${title}”` },
        SUCCESS_TOAST_MS,
      );
    } catch (error) {
      showLibraryToast({ status: "error", message: errorMessage(error) });
    } finally {
      setOperationBusy(false);
      operation.current = false;
      shared.reload();
    }
  };
  const copyShare = async (share: BookShare) => {
    if (!session || !isAdmin) return;
    const progress = beginOperation("Copying share link", share.title);
    if (!progress) return;
    try {
      const url = await shareUrl(session, share);
      progress("Copying link to clipboard");
      await navigator.clipboard.writeText(url);
      showLibraryToast(
        { status: "success", message: "Share link copied" },
        SUCCESS_TOAST_MS,
      );
    } catch (error) {
      showLibraryToast({ status: "error", message: errorMessage(error) });
    } finally {
      setOperationBusy(false);
      operation.current = false;
    }
  };
  const removeShare = async (share: BookShare) => {
    if (!session || !isAdmin) return;
    const progress = beginOperation("Deleting share", share.title);
    if (!progress) return;
    try {
      await deleteBookShare(session, share, progress);
      shared.remove(share.id);
      setSelectedShareId(null);
      showLibraryToast(
        { status: "success", message: "Share deleted" },
        SUCCESS_TOAST_MS,
      );
    } catch (error) {
      showLibraryToast({ status: "error", message: errorMessage(error) });
      shared.reload();
    } finally {
      setOperationBusy(false);
      operation.current = false;
    }
  };
  return (
    <div
      ref={libraryRoot}
      className="library-screen position-relative vh-100 mx-auto max-w-md-60 px-2 px-md-0 overflow-hidden"
    >
      <div
        className="d-flex flex-column h-100"
        data-testid="library-operation-surface"
        aria-busy={operationBusy || undefined}
        inert={operationBusy || undefined}
      >
        <LibraryHeader
          query={query}
          onQuery={search}
          menu={
            showSidebar ? null : (
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
          selectedShare={selectedShare}
          showBookActions={view.kind === "books"}
          showShareActions={view.kind === "shares"}
          canShare={isAdmin}
          onRead={() => {
            if (selectedBook) routerNavigate(`/read/${selectedBook.txtId}`);
          }}
          onShare={() => {
            if (selectedBook) void createShare(selectedBook.txtId);
          }}
          onCopyShare={() => {
            if (selectedShare) void copyShare(selectedShare);
          }}
          onDeleteShare={() => {
            if (selectedShare) void removeShare(selectedShare);
          }}
        />
        <div
          className={`d-flex flex-grow-1 overflow-hidden min-w-0 ${showSidebar ? "library-sidebar-layout" : ""}`}
        >
          {showSidebar && (
            <aside
              ref={librarySidebar}
              className="h-100 border-end library-sidebar library-pane-col"
            >
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
            selectedShareId={selectedShareId}
            onSelectShare={setSelectedShareId}
            onNavigate={navigate}
            onClearAccess={(txtId) => {
              const book = library.books.find((candidate) => candidate.txtId === txtId);
              if (book) {
                void updateActivity(
                  "Deleting recent access",
                  book.title,
                  clearLastAccessMutation(txtId),
                  "Recent access deleted",
                );
              }
            }}
            onDeleteBookmark={(txtId, cfi) => {
              const book = library.books.find((candidate) => candidate.txtId === txtId);
              if (book) {
                void updateActivity(
                  "Deleting bookmark",
                  book.title,
                  deleteBookmarkMutation(txtId, cfi),
                  "Bookmark deleted",
                );
              }
            }}
            shares={shared.shares}
          />
        </div>
      </div>
      {operationBusy && (
        <div className="library-operation-blocker" aria-hidden="true" />
      )}
      <LibraryToastRegion />
    </div>
  );
}

function showLibraryToast(notice: LibraryNotice, timeout?: number): void {
  libraryToastQueue.clear();
  libraryToastQueue.add(notice, { timeout });
}

function LibraryToastRegion() {
  return (
    <UNSTABLE_ToastRegion
      queue={libraryToastQueue}
      className="library-toast-region"
      aria-label="Library notifications"
    >
      {({ toast }) => <LibraryToast toast={toast} />}
    </UNSTABLE_ToastRegion>
  );
}

function LibraryToast({ toast }: { toast: QueuedToast<LibraryNotice> }) {
  const notice = toast.content;
  return (
    <UNSTABLE_Toast
      toast={toast}
      className={`toast show library-toast ${notice.status === "error" ? "text-bg-danger" : ""}`}
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

function useLibrarySidebar(
  root: RefObject<HTMLDivElement | null>,
  sidebar: RefObject<HTMLElement | null>,
  active: boolean,
): boolean {
  const [visible, setVisible] = useState(
    () => window.matchMedia(DESKTOP_MEDIA_QUERY).matches,
  );
  const measuredSidebarWidth = useRef(LIBRARY_SIDEBAR_WIDTH_PX);
  useLayoutEffect(() => {
    if (!active) return;
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const rootWidth = element.getBoundingClientRect().width;
      const renderedSidebarWidth = sidebar.current?.getBoundingClientRect().width ?? 0;
      if (renderedSidebarWidth > 0) {
        measuredSidebarWidth.current = renderedSidebarWidth;
      }
      if (rootWidth > 0) {
        const rightPaneWidth = rootWidth - measuredSidebarWidth.current;
        setVisible(rightPaneWidth >= LIBRARY_RIGHT_PANE_MIN_PX);
      }
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    if (sidebar.current) observer.observe(sidebar.current);
    return () => observer.disconnect();
  }, [active, root, sidebar, visible]);
  return visible;
}
