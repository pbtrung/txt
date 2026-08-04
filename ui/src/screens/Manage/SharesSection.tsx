import { useMemo } from "react";

import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import type { ShareEntry } from "../../data/adminShares";
import type { UserSummary } from "../../data/adminUsers";
import type { BookInfo } from "../../data/metadata";
import { ShareRow, SHARE_ROW_HEIGHT } from "./ShareRow";
import { userLabel } from "./manageShared";

const unknownUser = (id: string) => ({ id, displayName: undefined });

export function SharesSection({
  booksById,
  users,
  shares,
  search,
  selectedShareId,
  onSelectRow,
}: {
  booksById: Map<string, BookInfo>;
  users: UserSummary[];
  shares: ShareEntry[];
  search: string;
  selectedShareId: string | null;
  onSelectRow: (id: string | null) => void;
}) {
  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shares;
    return shares.filter((share) => {
      const title = booksById.get(share.txtId)?.title ?? share.txtId;
      const recipient = userLabel(
        usersById.get(share.toUserId) ?? unknownUser(share.toUserId),
      );
      return (
        title.toLowerCase().includes(q) || recipient.toLowerCase().includes(q)
      );
    });
  }, [shares, search, booksById, usersById]);

  return (
    <VirtualizedListGroup
      className="flex-grow-1"
      items={filtered}
      getKey={(share) => share.id}
      estimateRowHeight={SHARE_ROW_HEIGHT}
      emptyMessage="No shares match here yet."
      renderRow={(share) => (
        <ShareRow
          title={booksById.get(share.txtId)?.title ?? share.txtId}
          recipient={
            usersById.get(share.toUserId) ?? unknownUser(share.toUserId)
          }
          selected={selectedShareId === share.id}
          onClick={() => onSelectRow(share.id)}
        />
      )}
    />
  );
}
