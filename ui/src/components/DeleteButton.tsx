// The small "x" that removes a single row (Library's Continue Reading/Recent
// Bookmarks, Reader's Bookmarks dropdown) without triggering the row's own
// click (which would otherwise navigate/jump somewhere) -- shared here since
// all three call sites want the exact same button, just with their own
// aria-label and delete callback.

interface DeleteButtonProps {
  onClick: () => void;
  ariaLabel: string;
}

export function DeleteButton({ onClick, ariaLabel }: DeleteButtonProps) {
  return (
    <button
      type="button"
      className="btn btn-xs btn-outline-secondary border-0 flex-shrink-0"
      aria-label={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <i className="bi bi-x-lg" aria-hidden="true" />
    </button>
  );
}
