import { useMemo } from "react";

import { BookRow, BOOK_ROW_HEIGHT } from "../../components/BookRow";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import { allBooksSorted, matchesSearch } from "../Library/libraryModel";
import { useLibraryBooks } from "../Library/useLibraryBooks";

export function BooksSection({
  search,
  selectedTxtId,
  onSelectRow,
}: {
  search: string;
  selectedTxtId: string | null;
  onSelectRow: (txtId: string | null) => void;
}) {
  const { books } = useLibraryBooks();
  const sorted = useMemo(() => allBooksSorted(books ?? []), [books]);
  const filtered = useMemo(() => {
    if (!search.trim()) return sorted;
    return sorted.filter((book) => matchesSearch(book, search));
  }, [sorted, search]);

  function selectRow(txtId: string) {
    onSelectRow(txtId);
  }

  return (
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
  );
}
