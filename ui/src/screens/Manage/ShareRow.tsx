// One row in the admin Manage screen's Shares list: the shared txt's title
// on top, then who it's shared with underneath -- two lines, same shape as
// BookRow's own list rows (see docs/ui.md's "Users' and Shares' rows also
// carry a small leading icon"), rather than SelectableRow's single
// truncated line every other Manage section already outgrew a dedicated
// row component for.

import type { CSSProperties } from "react";
import { ClickableRow } from "../../components/ClickableRow";
import { userLabel } from "./manageShared";

// Same shape as BookRow's own two-line rows (py-3 padding + title/subtitle)
// -- a plain constant, safe since every field here is text-truncate'd.
export const SHARE_ROW_HEIGHT = 80;

interface ShareRowProps {
  /** The shared txt's title, or a `txt #<id>` fallback if it's since gone
   * missing from session.metadataById -- resolved by the caller (see
   * SharesSection.tsx), not looked up here. */
  title: string;
  toUserId: number;
  /** The recipient's display name, resolved by the caller from the same
   * cached Users list ManageScreen already loads for the Users section --
   * undefined if it's since gone missing (a deleted account) or just hasn't
   * loaded yet, in which case userLabel falls back to "Unnamed user". */
  recipientDisplayName?: string;
  selected: boolean;
  onClick: () => void;
  style?: CSSProperties;
}

export function ShareRow({ title, toUserId, recipientDisplayName, selected, onClick, style }: ShareRowProps) {
  return (
    <ClickableRow
      onClick={onClick}
      style={style}
      className={`list-group-item list-group-item-action d-flex align-items-center gap-3 py-3 ${selected ? "active" : ""}`}
    >
      <i className={`bi bi-share ${selected ? "" : "text-body-secondary"} flex-shrink-0`} aria-hidden="true" />
      <span className="overflow-hidden" style={{ minWidth: 0 }}>
        <span className="d-block fw-semibold text-truncate">{title}</span>
        <span className={`d-block small text-truncate ${selected ? "" : "text-body-secondary"}`}>
          Shared with {userLabel(recipientDisplayName, toUserId)}
        </span>
      </span>
    </ClickableRow>
  );
}
