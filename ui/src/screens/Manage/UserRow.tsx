import type { CSSProperties } from "react";

import { ClickableRow } from "../../components/ClickableRow";
import type { UserSummary } from "../../data/adminUsers";

export const USER_ROW_HEIGHT = 54;

interface UserRowProps {
  user: UserSummary;
  isSelf: boolean;
  selected: boolean;
  onClick: () => void;
  style?: CSSProperties;
}

export function UserRow({
  user,
  isSelf,
  selected,
  onClick,
  style,
}: UserRowProps) {
  const primary = user.displayName ?? user.email ?? "Unnamed user";
  return (
    <ClickableRow
      onClick={onClick}
      style={style}
      className={`list-group-item list-group-item-action d-flex align-items-center gap-3 py-2 ${selected ? "active" : ""}`}
    >
      <i
        className={`bi ${user.isAdmin ? "bi-shield-lock" : "bi-person-circle"} ${selected ? "" : "text-body-secondary"} flex-shrink-0`}
        aria-hidden="true"
      />
      <span className="overflow-hidden" style={{ minWidth: 0 }}>
        <span className="d-block fw-semibold text-truncate">
          {primary}
          {isSelf && (
            <span
              className={`small ms-2 ${selected ? "" : "text-body-secondary"}`}
            >
              (you)
            </span>
          )}
        </span>
        {user.email && user.email !== primary && (
          <span
            className={`d-block small text-truncate ${selected ? "" : "text-body-secondary"}`}
          >
            {user.email}
          </span>
        )}
      </span>
    </ClickableRow>
  );
}
