import type { CSSProperties } from "react";

import { ClickableRow } from "../../components/ClickableRow";
import type { UserSummary } from "../../data/adminUsers";

// Matches the left navigation's default one-line Bootstrap list-group item:
// 1.5rem line-height + 0.5rem top/bottom padding + 1px bottom border.
export const USER_ROW_HEIGHT = 41;

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
  const displayName = user.displayName?.trim() || user.email?.trim() || "User";
  return (
    <ClickableRow
      onClick={onClick}
      style={style}
      className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 ${selected ? "active" : ""}`}
    >
      <span
        className="d-flex align-items-center gap-2 overflow-hidden"
        style={{ minWidth: 0 }}
      >
        <i
          className={`bi ${user.isAdmin ? "bi-shield-lock" : "bi-person-circle"} ${selected ? "" : "text-body-secondary"} flex-shrink-0`}
          aria-hidden="true"
        />
        <span className="text-truncate">{displayName}</span>
      </span>
      {isSelf && (
        <span
          className={`small flex-shrink-0 ${selected ? "" : "text-body-secondary"}`}
        >
          (you)
        </span>
      )}
    </ClickableRow>
  );
}
