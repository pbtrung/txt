import { IconButton } from "../../components/IconButton";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import type { DatabaseStoreStatus } from "../../data/databaseStore";
import type { EpubRenderer } from "../../data/epubRenderer";
import type { BookmarkRecord } from "../../data/readingState";

export function BookmarksPanel({
  open,
  onClose,
  renderer,
  bookmarks,
  busy,
  status,
  error,
  onRemove,
  onRetry,
}: {
  open: boolean;
  onClose: () => void;
  renderer: EpubRenderer | null;
  bookmarks: BookmarkRecord[];
  busy: boolean;
  status: DatabaseStoreStatus;
  error: string | null;
  onRemove: (cfi: string) => void;
  onRetry: () => void;
}) {
  return (
    <OffcanvasPanel
      open={open}
      onClose={onClose}
      title="Bookmarks"
      className="reader-side-panel"
    >
      {status.pending && (
        <p role="status" className="small text-muted">
          Saving…
        </p>
      )}
      {error && (
        <div className="alert alert-danger py-2" role="alert">
          <p className="mb-2">Bookmarks have unsaved changes: {error}</p>
          <button
            type="button"
            className="btn btn-sm btn-outline-danger"
            disabled={status.pending}
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      )}
      {bookmarks.length === 0 ? (
        <p className="text-muted">No bookmarks yet.</p>
      ) : (
        <ul className="list-group list-group-flush">
          {bookmarks.map((bookmark) => (
            <li
              key={bookmark.id}
              className="list-group-item d-flex align-items-start gap-2 px-0"
            >
              <button
                type="button"
                className="btn btn-link flex-grow-1 p-0 text-start text-decoration-none"
                disabled={!renderer}
                onClick={() => {
                  void renderer?.display(bookmark.cfi);
                  onClose();
                }}
              >
                {bookmark.preview || "Saved location"}
              </button>
              <IconButton
                label="Delete bookmark"
                icon="trash"
                disabled={busy}
                onClick={() => onRemove(bookmark.cfi)}
              />
            </li>
          ))}
        </ul>
      )}
    </OffcanvasPanel>
  );
}
