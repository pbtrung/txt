import { useMemo, useState } from "react";

import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import { revokeShare, type ShareEntry } from "../../data/adminShares";
import type { UserSummary } from "../../data/adminUsers";
import type { BookInfo } from "../../data/metadata";
import type { VaultSession } from "../../state/VaultContext";
import { ShareRow, SHARE_ROW_HEIGHT } from "./ShareRow";
import { errorMessage, userDisplayLabel } from "./manageShared";

const unknownUser = (id: string) => ({ id, displayName: undefined });

function RevokeSharePanel({
  session,
  share,
  title,
  recipient,
  onRevoked,
  onClose,
}: {
  session: VaultSession;
  share: ShareEntry;
  title: string;
  recipient: { id: string; displayName?: string; email?: string };
  onRevoked: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRevoke() {
    setBusy(true);
    setError(null);
    try {
      await revokeShare(session.instantDb, share.id);
      onRevoked();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Revoke share" onClose={onClose}>
      <p className="small text-body-secondary">
        This immediately revokes {userDisplayLabel(recipient)}&apos;s access to{" "}
        <strong>{title}</strong>.
      </p>
      <div className="d-flex gap-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger d-flex align-items-center gap-2"
          onClick={() => void handleRevoke()}
          disabled={busy}
        >
          {busy && (
            <span
              className="spinner-border spinner-border-sm"
              role="status"
              aria-hidden="true"
            />
          )}
          Revoke share
        </button>
      </div>
      {error && <div className="text-danger small mt-2">{error}</div>}
    </Modal>
  );
}

export type SharesMode = "none" | "delete";

export function SharesSection({
  session,
  booksById,
  users,
  shares,
  search,
  selectedShareId,
  mode,
  onSelectRow,
  onSetMode,
  onChanged,
}: {
  session: VaultSession;
  booksById: Map<string, BookInfo>;
  users: UserSummary[];
  shares: ShareEntry[];
  search: string;
  selectedShareId: string | null;
  mode: SharesMode;
  onSelectRow: (id: string | null) => void;
  onSetMode: (mode: SharesMode) => void;
  onChanged: () => void;
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
      const recipient = userDisplayLabel(
        usersById.get(share.toUserId) ?? unknownUser(share.toUserId),
      );
      return (
        title.toLowerCase().includes(q) || recipient.toLowerCase().includes(q)
      );
    });
  }, [shares, search, booksById, usersById]);
  const selectedShare = selectedShareId
    ? shares.find((share) => share.id === selectedShareId)
    : undefined;

  function selectRow(id: string) {
    onSelectRow(id);
    onSetMode("none");
  }

  function afterChange() {
    onSetMode("none");
    onSelectRow(null);
    onChanged();
  }

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      {mode === "delete" && selectedShare && (
        <RevokeSharePanel
          session={session}
          share={selectedShare}
          title={
            booksById.get(selectedShare.txtId)?.title ?? selectedShare.txtId
          }
          recipient={
            usersById.get(selectedShare.toUserId) ??
            unknownUser(selectedShare.toUserId)
          }
          onRevoked={afterChange}
          onClose={() => onSetMode("none")}
        />
      )}

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
            onClick={() => selectRow(share.id)}
          />
        )}
      />
    </div>
  );
}
