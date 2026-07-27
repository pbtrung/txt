// The nav's account footer -- person icon, display name, Refresh/Lock --
// pinned to the bottom of both Library's and Manage's left nav (the lg+
// sidebar and the below-lg dropdown alike). Refresh/Lock render as one
// merged Bootstrap button group (adjoining borders, no gap between them)
// rather than two separately-spaced buttons. Library's own name is a
// link to /manage for an admin session (RequireAdmin guards the route
// itself; this is just "don't offer it" for a regular user, not the
// real enforcement); Manage's is always plain text, since that screen
// already *is* where that link would go.

import { InternalLink } from "./InternalLink";

export function AccountFooter({
  displayName,
  manageLink = false,
  onRefresh,
  onLock,
  refreshing,
  refreshAriaLabel,
}: {
  displayName: string | undefined;
  /** Renders displayName as a link to /manage instead of plain text. */
  manageLink?: boolean;
  onRefresh: () => void;
  onLock: () => void;
  refreshing: boolean;
  refreshAriaLabel: string;
}) {
  return (
    <div className="border-top pt-2 mt-2 d-flex align-items-center justify-content-between gap-2">
      <span className="d-flex align-items-center gap-2 text-truncate">
        <i className="bi bi-person-circle text-body-secondary flex-shrink-0" aria-hidden="true" />
        {/* No `small` here -- matches NavItem's own default (unstyled)
            font-size, so the signed-in name reads at the same size as the
            nav entries above it, not smaller. */}
        {manageLink ? (
          <InternalLink to="/manage" className="text-truncate">
            {displayName}
          </InternalLink>
        ) : (
          <span className="text-body-secondary text-truncate">{displayName}</span>
        )}
      </span>
      <div className="btn-group flex-shrink-0" role="group" aria-label="Account actions">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary border-primary"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshAriaLabel}
          title={refreshAriaLabel}
        >
          {refreshing ? (
            <span className="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true" />
          ) : (
            <i className="bi bi-arrow-clockwise text-primary" aria-hidden="true" />
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
