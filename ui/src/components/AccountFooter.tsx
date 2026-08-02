// The nav's account footer -- person icon, display name, Refresh/Lock --
// pinned to the bottom of Library's left nav (the lg+ sidebar and the
// below-lg dropdown alike). Refresh/Lock render as one merged Bootstrap
// button group (adjoining borders, no gap between them) rather than two
// separately-spaced buttons.

export function AccountFooter({
  onRefresh,
  onLock,
  refreshing,
  refreshAriaLabel,
  displayName,
}: {
  onRefresh: () => void;
  onLock: () => void;
  refreshing: boolean;
  refreshAriaLabel: string;
  displayName?: string;
}) {
  return (
    <div className="border-top pt-2 mt-2 d-flex align-items-center justify-content-between gap-2">
      <span className="d-flex align-items-center gap-2 text-truncate">
        <i
          className="bi bi-person-circle text-body-secondary flex-shrink-0"
          aria-hidden="true"
        />
        {displayName && <span className="text-truncate">{displayName}</span>}
      </span>
      <div
        className="btn-group flex-shrink-0"
        role="group"
        aria-label="Account actions"
      >
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary border-primary"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshAriaLabel}
          title={refreshAriaLabel}
        >
          {refreshing ? (
            <span
              className="spinner-border spinner-border-sm text-primary"
              role="status"
              aria-hidden="true"
            />
          ) : (
            <i
              className="bi bi-arrow-clockwise text-primary"
              aria-hidden="true"
            />
          )}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary border-primary"
          onClick={onLock}
          aria-label="Lock"
          title="Lock"
        >
          <i className="bi bi-unlock text-primary" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
