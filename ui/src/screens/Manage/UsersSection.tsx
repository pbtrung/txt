import { useMemo } from "react";

import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import type { UserSummary } from "../../data/adminUsers";
import { UserRow, USER_ROW_HEIGHT } from "./UserRow";

export function UsersSection({
  sessionAuthId,
  users,
  search,
  selectedUserId,
  onSelectRow,
}: {
  sessionAuthId: string;
  users: UserSummary[];
  search: string;
  selectedUserId: string | null;
  onSelectRow: (id: string | null) => void;
}) {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((user) =>
      [user.id, user.email, user.displayName]
        .filter((part): part is string => Boolean(part))
        .some((part) => part.toLowerCase().includes(q)),
    );
  }, [users, search]);

  function selectRow(id: string) {
    onSelectRow(id);
  }

  return (
    <VirtualizedListGroup
      className="flex-grow-1"
      items={filtered}
      getKey={(user) => user.id}
      estimateRowHeight={USER_ROW_HEIGHT}
      emptyMessage="No users match here yet."
      renderRow={(user) => (
        <UserRow
          user={user}
          isSelf={user.id === sessionAuthId}
          selected={selectedUserId === user.id}
          onClick={() => selectRow(user.id)}
        />
      )}
    />
  );
}
