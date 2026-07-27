// Manage screen's Books section: the admin's own txt only (only the admin
// ever holds any -- see the plan this screen was built from). No Create --
// that stays a --txt-ingest-only operation. Edit changes curated metadata
// fields; Delete removes R2 parts too (see VaultContext's deleteTxt), not
// just Turso rows.

import { useMemo, useState, type FormEvent } from "react";

import { BookRow, BOOK_ROW_HEIGHT } from "../../components/BookRow";
import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import type { BookInfo } from "../../data/metadata";
import { useVault } from "../../state/VaultContext";
import { allBooksSorted, matchesSearch } from "../Library/libraryModel";
import { useLibraryBooks } from "../Library/useLibraryBooks";
import { ConfirmDeleteField, FormField, errorMessage, yieldToPaint } from "./manageShared";

interface BookMetadataFormValues {
  title?: string;
  author?: string;
  publisher?: string;
  subjects: string[];
  description?: string;
}

function EditBookPanel({
  book,
  onSaved,
  onClose,
}: {
  book: BookInfo;
  onSaved: (edits: BookMetadataFormValues, onProgress: (label: string) => void) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [publisher, setPublisher] = useState(book.publisher ?? "");
  const [subjects, setSubjects] = useState(book.subjects.join(", "));
  const [description, setDescription] = useState(book.description ?? "");
  const [busy, setBusy] = useState(false);
  // What saveBookMetadata is doing right now (its own download-then-upload
  // phases) -- shown beside the Save button's spinner instead of leaving
  // it a silent, disabled button for however long that round-trip takes.
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setProgressLabel(null);
    // Lets the spinner/disabled state actually paint before the
    // synchronous compress+encrypt work below blocks the main thread --
    // see yieldToPaint's own doc comment.
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
    <Modal title={`Edit: ${book.title}`} onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <FormField label="Title" htmlFor="manage-book-title">
          <input
            id="manage-book-title"
            type="text"
            className="form-control themed-control"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>
        <FormField label="Author" htmlFor="manage-book-author">
          <input
            id="manage-book-author"
            type="text"
            className="form-control themed-control"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </FormField>
        <FormField label="Publisher" htmlFor="manage-book-publisher">
          <input
            id="manage-book-publisher"
            type="text"
            className="form-control themed-control"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
          />
        </FormField>
        <FormField label="Subjects (comma-separated)" htmlFor="manage-book-subjects">
          <input
            id="manage-book-subjects"
            type="text"
            className="form-control themed-control"
            value={subjects}
            onChange={(e) => setSubjects(e.target.value)}
          />
        </FormField>
        <FormField label="Description" htmlFor="manage-book-description">
          <textarea
            id="manage-book-description"
            className="form-control themed-control"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        <div className="d-flex align-items-center gap-2 mt-1">
          <button type="submit" className="btn btn-primary d-flex align-items-center gap-2" disabled={busy}>
            {busy && <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />}
            Save
          </button>
          {busy && progressLabel && <span className="small text-body-secondary">{progressLabel}</span>}
        </div>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Modal>
  );
}

function DeleteBookPanel({
  book,
  onDeleted,
  onClose,
}: {
  book: BookInfo;
  onDeleted: () => Promise<void>;
  onClose: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Delete "${book.title}"`} onClose={onClose}>
      <p className="small text-body-secondary">
        This permanently deletes &ldquo;{book.title}&rdquo; and its stored content. Type <strong>{book.txtId}</strong>{" "}
        to confirm.
      </p>
      <ConfirmDeleteField
        idToMatch={book.txtId}
        confirmText={confirmText}
        onConfirmTextChange={setConfirmText}
        onConfirm={() => void handleDelete()}
        busy={busy}
      />
      {error && <div className="text-danger small mt-2">{error}</div>}
    </Modal>
  );
}

export type BooksMode = "none" | "edit" | "delete";

export function BooksSection({
  search,
  selectedTxtId,
  mode,
  onSelectRow,
  onSetMode,
}: {
  search: string;
  selectedTxtId: number | null;
  mode: BooksMode;
  onSelectRow: (txtId: number | null) => void;
  onSetMode: (mode: BooksMode) => void;
}) {
  const { deleteTxt, updateBookMetadata } = useVault();
  // Same data/shape Library's own "All books" view uses (buildLibraryBooks
  // via this shared hook, then allBooksSorted/matchesSearch) -- so Books
  // here looks and searches exactly like Library's list, not a separate
  // approximation of it.
  const { books } = useLibraryBooks();

  const sorted = useMemo(() => allBooksSorted(books ?? []), [books]);
  const filtered = useMemo(() => {
    if (!search.trim()) return sorted;
    return sorted.filter((b) => matchesSearch(b, search));
  }, [sorted, search]);

  const selectedBook = selectedTxtId !== null ? (books ?? []).find((b) => b.txtId === selectedTxtId) : undefined;

  function selectRow(txtId: number) {
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
      {mode === "delete" && selectedBook && (
        <DeleteBookPanel
          book={selectedBook.info}
          onDeleted={async () => {
            await deleteTxt(selectedBook.txtId);
            onSetMode("none");
            onSelectRow(null);
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
          <BookRow book={book} selected={selectedTxtId === book.txtId} onClick={() => selectRow(book.txtId)} />
        )}
      />
    </div>
  );
}
