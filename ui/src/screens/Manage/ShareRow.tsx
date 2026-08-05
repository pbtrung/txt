import type { CSSProperties } from "react";

import { ClickableRow } from "../../components/ClickableRow";
import { userDisplayLabel } from "./manageShared";

export const SHARE_ROW_HEIGHT = 80;

interface ShareRowProps {
  title: string;
  recipient: { id: string; displayName?: string; email?: string };
  selected: boolean;
  onClick: () => void;
  style?: CSSProperties;
}

export function ShareRow({
  title,
  recipient,
  selected,
  onClick,
  style,
}: ShareRowProps) {
  return (
    <ClickableRow
      onClick={onClick}
      style={style}
      className={`list-group-item list-group-item-action d-flex align-items-center gap-3 py-3 ${selected ? "active" : ""}`}
    >
      <i
        className={`bi bi-share ${selected ? "" : "text-body-secondary"} flex-shrink-0`}
        aria-hidden="true"
      />
      <span className="overflow-hidden" style={{ minWidth: 0 }}>
        <span className="d-block fw-semibold text-truncate">{title}</span>
        <span
          className={`d-block small text-truncate ${selected ? "" : "text-body-secondary"}`}
        >
          Shared with {userDisplayLabel(recipient)}
        </span>
      </span>
    </ClickableRow>
  );
}
