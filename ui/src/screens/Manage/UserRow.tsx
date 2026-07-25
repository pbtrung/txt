// One row in the admin Manage screen's Users list: display name (if known --
// recovered from users.creds, wrapped under the admin's own umk, see
// adminUsers.ts's listUsersWithInfo) or a plain fallback, then how many txt
// this account owns (almost always 0 for a regular user -- only the admin
// ever holds any, see the plan this screen was built from -- except the
// admin's own row). One line, matching Library's BROWSE_ENTRY_ROW_HEIGHT
// single-line rows rather than BookRow's two-line shape.

import type { CSSProperties } from "react";
import { ClickableRow } from "../../components/ClickableRow";
import type { UserSummary } from "../../data/adminUsers";

export const USER_ROW_HEIGHT = 44;

interface UserRowProps {
  user: UserSummary;
  isSelf: boolean;
  selected: boolean;
  onClick: () => void;
  style?: CSSProperties;
}

export function UserRow({ user, isSelf, selected, onClick, style }: UserRowProps) {
  return (
    <ClickableRow
      onClick={onClick}
      style={style}
      className={`list-group-item list-group-item-action d-flex align-items-center gap-3 py-2 ${selected ? "active" : ""}`}
    >
      <i className={`bi bi-person-circle ${selected ? "" : "text-body-secondary"} flex-shrink-0`} aria-hidden="true" />
      <span className="flex-grow-1 text-truncate fw-semibold" style={{ minWidth: 0 }}>
        {user.displayName ?? "Unnamed user"}
        {isSelf && <span className={`small ms-2 ${selected ? "" : "text-body-secondary"}`}>(you)</span>}
      </span>
      <span className={`small flex-shrink-0 ${selected ? "" : "text-body-secondary"}`}>
        {user.bookCount} {user.bookCount === 1 ? "book" : "books"}
      </span>
    </ClickableRow>
  );
}
