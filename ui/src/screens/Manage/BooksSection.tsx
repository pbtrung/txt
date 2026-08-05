import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { BookRow, BOOK_ROW_HEIGHT } from "../../components/BookRow";
import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import type { BookMetadataEdits } from "../../data/adminBooks";
import { fetchBookInfo } from "../../data/bookMetadata";
import type { BookInfo } from "../../data/metadata";
import { useVault } from "../../state/VaultContext";
import { allBooksSorted, matchesSearch } from "../Library/libraryModel";
import { useLibraryBooks } from "../Library/useLibraryBooks";
import { FormField, errorMessage, yieldToPaint } from "./manageShared";

function EditBookPanel({
  txtId,
  book,
  loadFullInfo,
  onSaved,
  onClose,
}: {
  txtId: string;
  book: BookInfo;
  loadFullInfo: (txtId: string) => Promise<BookInfo>;
  onSaved: (
    edits: BookMetadataEdits,
    onProgress: (label: string) => void,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [publisher, setPublisher] = useState(book.publisher ?? "");
  const [subjects, setSubjects] = useState(book.subjects.join(", "));
  const [description, setDescription] = useState(book.description ?? "");
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function applyInfo(info: BookInfo) {
    setTitle(info.title);
    setAuthor(info.author ?? "");
    setPublisher(info.publisher ?? "");
    setSubjects(info.subjects.join(", "));
    setDescription(info.description ?? "");
  }

  useEffect(() => {
    let cancelled = false;
    applyInfo(book);
    setMetadataLoading(true);
    setError(null);
    loadFullInfo(txtId)
      .then((info) => {
        if (!cancelled) applyInfo(info);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setMetadataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [book, loadFullInfo, txtId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (metadataLoading) return;
    setBusy(true);
    setError(null);
    setProgressLabel(null);
    await yieldToPaint();
    try {
      await onSaved(
        {
          title: title.trim() || undefined,
          author: author.trim() || undefined,
          publisher: publisher.trim() || undefined,
          subjects: subjects
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          description: description.trim() || undefined,
        },
        setProgressLabel,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setProgressLabel(null);
    }
  }

  return (
    <Modal title={`Edit ${book.title}`} onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <FormField label="Title" htmlFor="manage-book-title">
          <input
            id="manage-book-title"
            type="text"
            className="form-control form-control-sm themed-control"
            value={title}
            disabled={busy || metadataLoading}
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>
        <FormField label="Author" htmlFor="manage-book-author">
          <input
            id="manage-book-author"
            type="text"
            className="form-control form-control-sm themed-control"
            value={author}
            disabled={busy || metadataLoading}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </FormField>
        <FormField label="Publisher" htmlFor="manage-book-publisher">
          <input
            id="manage-book-publisher"
            type="text"
            className="form-control form-control-sm themed-control"
            value={publisher}
            disabled={busy || metadataLoading}
            onChange={(e) => setPublisher(e.target.value)}
          />
        </FormField>
        <FormField
          label="Subjects (comma-separated)"
          htmlFor="manage-book-subjects"
        >
          <input
            id="manage-book-subjects"
            type="text"
            className="form-control form-control-sm themed-control"
            value={subjects}
            disabled={busy || metadataLoading}
            onChange={(e) => setSubjects(e.target.value)}
          />
        </FormField>
        <FormField label="Description" htmlFor="manage-book-description">
          <textarea
            id="manage-book-description"
            className="form-control form-control-sm themed-control"
            rows={3}
            value={description}
            disabled={busy || metadataLoading}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        <div className="d-flex align-items-center gap-2 mt-1">
          <button
            type="submit"
            className="btn btn-sm btn-primary d-flex align-items-center gap-2"
            disabled={busy || metadataLoading}
          >
            {busy && (
              <span
                className="spinner-border spinner-border-sm"
                role="status"
                aria-hidden="true"
              />
            )}
            Save
          </button>
          {metadataLoading && (
            <span className="small text-body-secondary">Loading metadata</span>
          )}
          {busy && progressLabel && (
            <span className="small text-body-secondary">{progressLabel}</span>
          )}
        </div>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Modal>
  );
}

export type BooksMode = "none" | "edit";

export function BooksSection({
  search,
  selectedTxtId,
  mode,
  onSelectRow,
  onSetMode,
}: {
  search: string;
  selectedTxtId: string | null;
  mode: BooksMode;
  onSelectRow: (txtId: string | null) => void;
  onSetMode: (mode: BooksMode) => void;
}) {
  const { session, updateBookMetadata, syncBookInfo } = useVault();
  const { books } = useLibraryBooks();
  const sorted = useMemo(() => allBooksSorted(books ?? []), [books]);
  const filtered = useMemo(() => {
    if (!search.trim()) return sorted;
    return sorted.filter((book) => matchesSearch(book, search));
  }, [sorted, search]);

  const selectedBook = selectedTxtId
    ? (books ?? []).find((book) => book.txtId === selectedTxtId)
    : undefined;

  function selectRow(txtId: string) {
    onSelectRow(txtId);
    onSetMode("none");
  }

  const loadFullInfo = useCallback(
    async (txtId: string) => {
      if (!session) throw new Error("vault is locked");
      const docKey = session.docKeys.get(txtId);
      if (!docKey) throw new Error(`missing document key for txt ${txtId}`);
      return fetchBookInfo(session.instantDb, txtId, docKey);
    },
    [session],
  );

  useEffect(() => {
    if (!session || !selectedTxtId) return;
    if (typeof session.instantDb.subscribeQuery !== "function") return;
    const docKey = session.docKeys.get(selectedTxtId);
    if (!docKey) return;

    let cancelled = false;
    let seenInitialPayload = false;
    const unsubscribe = session.instantDb.subscribeQuery(
      {
        txt: {
          $: { where: { id: selectedTxtId }, fields: [] },
          txtMetadata: { $: { fields: ["content"] } },
        },
      },
      (result: { data?: { txt?: { txtMetadata?: unknown[] }[] } }) => {
        if (!seenInitialPayload) {
          seenInitialPayload = true;
          return;
        }
        if (!result.data?.txt?.[0]?.txtMetadata?.[0]) return;
        fetchBookInfo(session.instantDb, selectedTxtId, docKey)
          .then((info) => {
            if (!cancelled) syncBookInfo(selectedTxtId, info);
          })
          .catch(() => undefined);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedTxtId, session, syncBookInfo]);

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      {mode === "edit" && selectedBook && (
        <EditBookPanel
          txtId={selectedBook.txtId}
          book={selectedBook.info}
          loadFullInfo={loadFullInfo}
          onSaved={async (edits, onProgress) => {
            await updateBookMetadata(selectedBook.txtId, edits, onProgress);
            onSetMode("none");
          }}
          onClose={() => onSetMode("none")}
        />
      )}

      <VirtualizedListGroup
        className="flex-grow-1"
        items={filtered}
        getKey={(book) => book.txtId}
        estimateRowHeight={BOOK_ROW_HEIGHT}
        emptyMessage="No books match here yet."
        renderRow={(book) => (
          <BookRow
            book={book}
            selected={selectedTxtId === book.txtId}
            onClick={() => selectRow(book.txtId)}
          />
        )}
      />
    </div>
  );
}
