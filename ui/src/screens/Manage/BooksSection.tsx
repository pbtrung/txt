import { useMemo, useState, type FormEvent } from "react";

import { BookRow, BOOK_ROW_HEIGHT } from "../../components/BookRow";
import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import type { BookMetadataEdits } from "../../data/adminBooks";
import type { BookInfo } from "../../data/metadata";
import { useVault } from "../../state/VaultContext";
import { allBooksSorted, matchesSearch } from "../Library/libraryModel";
import { useLibraryBooks } from "../Library/useLibraryBooks";
import { FormField, errorMessage, yieldToPaint } from "./manageShared";

function EditBookPanel({
  book,
  onSaved,
  onClose,
}: {
  book: BookInfo;
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
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
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
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>
        <FormField label="Author" htmlFor="manage-book-author">
          <input
            id="manage-book-author"
            type="text"
            className="form-control form-control-sm themed-control"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </FormField>
        <FormField label="Publisher" htmlFor="manage-book-publisher">
          <input
            id="manage-book-publisher"
            type="text"
            className="form-control form-control-sm themed-control"
            value={publisher}
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
            onChange={(e) => setSubjects(e.target.value)}
          />
        </FormField>
        <FormField label="Description" htmlFor="manage-book-description">
          <textarea
            id="manage-book-description"
            className="form-control form-control-sm themed-control"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        <div className="d-flex align-items-center gap-2 mt-1">
          <button
            type="submit"
            className="btn btn-sm btn-primary d-flex align-items-center gap-2"
            disabled={busy}
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
  const { updateBookMetadata } = useVault();
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

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      {mode === "edit" && selectedBook && (
        <EditBookPanel
          book={selectedBook.info}
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
