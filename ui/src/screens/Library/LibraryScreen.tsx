// Library shell: coordinates search/navigation state while focused child
// components own the header, responsive navigation, and browsable content.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { UNSAFE_PortalProvider } from "react-aria";
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
  const library = useLibraryBooks(session?.library ?? null);
  const shared = useShares(session);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<LibraryView>(INITIAL_VIEW);
  const [selectedTxtId, setSelectedTxtId] = useState<number | null>(null);
  const [selectedShareId, setSelectedShareId] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const operation = useRef(false);
  const libraryRoot = useRef<HTMLDivElement>(null);
  const librarySidebar = useRef<HTMLElement>(null);
  const libraryRightPane = useRef<HTMLDivElement>(null);
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
    shared.shares.find((share) => share.shareIdHash === selectedShareId) ?? null;
  const updateActivity = async (
    action: Extract<
      LibraryOperationAction,
      "Deleting recent access" | "Deleting bookmark"
    >,
    title: string,
    apply: () => Promise<void>,
    success: string,
  ) => {
    if (!session) return;
    const progress = beginOperation(action, title);
    if (!progress) return;
    try {
      progress("Saving encrypted library");
      await apply();
      progress("Refreshing Recent");
      library.reload();
      showLibraryToast({ status: "success", message: success }, SUCCESS_TOAST_MS);
    } catch (error) {
      showLibraryToast({ status: "error", message: errorMessage(error) });
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
    if (!session) return;
    const title = library.books.find((book) => book.txtId === txtId)?.title ?? "Book";
    const progress = beginOperation("Creating share", title);
    if (!progress) return;
    try {
      await createBookShare(session, session.umk, txtId, progress);
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
    if (!session) return;
    const progress = beginOperation("Copying share link", share.title);
    if (!progress) return;
    try {
      const url = await shareUrl(session, session.umk, share);
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
    if (!session) return;
    const progress = beginOperation("Deleting share", share.title);
    if (!progress) return;
    try {
      await deleteBookShare(session, share, progress);
      shared.remove(share.shareIdHash);
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
      className="library-screen relative mx-auto h-screen max-w-md-60 overflow-hidden px-2 md:px-0"
    >
      <div
        className="flex h-full flex-col"
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
              />
            )
          }
          selectedBook={selectedBook}
          selectedShare={selectedShare}
          showBookActions={view.kind === "books"}
          showShareActions={view.kind === "shares"}
          canShare={Boolean(session)}
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
          className={`flex min-w-0 flex-1 overflow-hidden ${showSidebar ? "library-sidebar-layout" : ""}`}
        >
          {showSidebar && (
            <aside
              ref={librarySidebar}
              className="h-full border-r border-base-300 library-sidebar library-pane-col"
            >
              <LibrarySidebar
                books={library.books}
                view={view}
                displayName={session?.displayName ?? ""}
                onNavigate={navigate}
                onLock={lock}
                shares={shared.shares}
              />
            </aside>
          )}
          <div
            ref={libraryRightPane}
            className="relative flex min-w-0 flex-1 overflow-hidden library-right-pane"
          >
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
                const book = library.books.find(
                  (candidate) => candidate.txtId === txtId,
                );
                if (book && session) {
                  void updateActivity(
                    "Deleting recent access",
                    book.title,
                    () => session.library.clearLastAccessed(txtId),
                    "Recent access deleted",
                  );
                }
              }}
              onDeleteBookmark={(txtId, bookmarkId) => {
                const book = library.books.find(
                  (candidate) => candidate.txtId === txtId,
                );
                if (book && session) {
                  void updateActivity(
                    "Deleting bookmark",
                    book.title,
                    () => session.library.deleteBookmark(bookmarkId),
                    "Bookmark deleted",
                  );
                }
              }}
              shares={shared.shares}
              sharesError={shared.error}
            />
            <UNSAFE_PortalProvider getContainer={() => libraryRightPane.current}>
              <LibraryToastRegion />
            </UNSAFE_PortalProvider>
          </div>
        </div>
      </div>
      {operationBusy && (
        <div className="library-operation-blocker" aria-hidden="true" />
      )}
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
      className="toast toast-bottom library-toast-region"
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
      className={`alert w-full min-w-0 max-w-full overflow-hidden library-toast ${notice.status === "error" ? "alert-error" : notice.status === "success" ? "alert-success" : "border border-base-300 bg-base-100"}`}
    >
      <UNSTABLE_ToastContent className="flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden library-toast-content">
        {notice.status === "busy" && (
          <span className="loading loading-spinner loading-sm shrink-0" aria-hidden />
        )}
        <span className="min-w-0 max-w-full flex-1 overflow-hidden">
          {notice.status === "busy" ? (
            <>
              <Text slot="title" className="block w-full truncate font-semibold">
                {notice.action}: {notice.title}
              </Text>
              <Text slot="description" className="block w-full truncate text-sm">
                {notice.step}…
              </Text>
            </>
          ) : (
            <Text slot="title" className="block w-full truncate font-semibold">
              {notice.message}
            </Text>
          )}
        </span>
        {notice.status === "error" && (
          <Button
            slot="close"
            className="btn btn-ghost btn-sm btn-square shrink-0 compact-x-button"
            aria-label="Dismiss notification"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
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
