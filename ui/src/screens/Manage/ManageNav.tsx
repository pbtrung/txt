// The Manage screen's left nav content -- Users/Books/Shares section
// picker plus the account footer -- shared between the lg+ persistent
// sidebar and the below-lg dropdown (ManageScreen.tsx renders this same
// component in both places, exactly like Library's own nav).

export type Section = "users" | "books" | "shares";

function NavItem({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <span className="text-truncate">{label}</span>
      <span className={`flex-shrink-0 ${active ? "" : "text-body-secondary"}`}>{count}</span>
    </button>
  );
}

export function ManageNavContent({
  section,
  selectSection,
  usersCount,
  booksCount,
  sharesCount,
  displayName,
  onLock,
  onRefresh,
  refreshing,
}: {
  section: Section;
  selectSection: (next: Section) => void;
  usersCount: number;
  booksCount: number;
  sharesCount: number;
  displayName: string | undefined;
  onLock: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <>
      <div className="flex-grow-1 overflow-auto">
        <div className="list-group list-group-flush">
          <NavItem
            active={section === "users"}
            label="Users"
            count={usersCount}
            onClick={() => selectSection("users")}
          />
          <NavItem
            active={section === "books"}
            label="Books"
            count={booksCount}
            onClick={() => selectSection("books")}
          />
          <NavItem
            active={section === "shares"}
            label="Shares"
            count={sharesCount}
            onClick={() => selectSection("shares")}
          />
        </div>
      </div>

      {/* Same account footer as Library's own nav -- person icon, display
          name, Refresh/Lock -- except display_name is never a link here
          (this screen already *is* where that link would go). */}
      <div className="border-top pt-2 mt-2 d-flex align-items-center justify-content-between gap-2">
        <span className="d-flex align-items-center gap-2 text-truncate">
          <i className="bi bi-person-circle text-body-secondary flex-shrink-0" aria-hidden="true" />
          <span className="small text-body-secondary text-truncate">{displayName}</span>
        </span>
        <span className="d-flex align-items-center gap-2 flex-shrink-0">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary border-primary flex-shrink-0"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh"
          >
            {refreshing ? (
              <span className="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true" />
            ) : (
              <i className="bi bi-arrow-clockwise text-primary" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary border-primary flex-shrink-0"
            onClick={onLock}
            aria-label="Lock"
            title="Lock"
          >
            <i className="bi bi-unlock text-primary" aria-hidden="true" />
          </button>
        </span>
      </div>
    </>
  );
}
