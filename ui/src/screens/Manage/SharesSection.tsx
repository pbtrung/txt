import { useMemo, useState, type FormEvent } from "react";

import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import {
  grantShare,
  revokeShare,
  type ShareEntry,
} from "../../data/adminShares";
import type { UserSummary } from "../../data/adminUsers";
import type { BookInfo } from "../../data/metadata";
import type { VaultSession } from "../../state/VaultContext";
import { ShareRow, SHARE_ROW_HEIGHT } from "./ShareRow";
import {
  FormField,
  errorMessage,
  truncateOptionLabel,
  userDisplayLabel,
  yieldToPaint,
} from "./manageShared";

const unknownUser = (id: string) => ({ id, displayName: undefined });

function GrantShareForm({
  session,
  books,
  users,
  shares,
  onGranted,
  onClose,
}: {
  session: VaultSession;
  books: BookInfo[];
  users: UserSummary[];
  shares: ShareEntry[];
  onGranted: () => void;
  onClose: () => void;
}) {
  const [txtId, setTxtId] = useState("");
  const [toUserId, setToUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sharedUserIds = useMemo(
    () =>
      new Set(
        shares
          .filter((share) => share.txtId === txtId)
          .map((share) => share.toUserId),
      ),
    [shares, txtId],
  );
  const recipients = useMemo(
    () =>
      users.filter(
        (user) => user.id !== session.authId && !sharedUserIds.has(user.id),
      ),
    [users, session.authId, sharedUserIds],
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    await yieldToPaint();
    try {
      await grantShare(session.instantDb, session, txtId, toUserId);
      onGranted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Grant share" onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <FormField label="Book" htmlFor="manage-grant-book">
          <select
            id="manage-grant-book"
            className="form-select form-select-sm themed-control"
            value={txtId}
            onChange={(e) => {
              setTxtId(e.target.value);
              setToUserId("");
            }}
            required
          >
            <option value="" disabled>
              Choose a book
            </option>
            {books.map((book) => (
              <option key={book.txtId} value={book.txtId}>
                {truncateOptionLabel(book.title)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Recipient" htmlFor="manage-grant-recipient">
          <select
            id="manage-grant-recipient"
            className="form-select form-select-sm themed-control"
            value={toUserId}
            onChange={(e) => setToUserId(e.target.value)}
            required
            disabled={!txtId}
          >
            <option value="" disabled>
              Choose a recipient
            </option>
            {recipients.map((user) => (
              <option key={user.id} value={user.id}>
                {truncateOptionLabel(userDisplayLabel(user))}
              </option>
            ))}
          </select>
        </FormField>
        <button
          type="submit"
          className="btn btn-sm btn-primary d-flex align-items-center gap-2 mt-1"
          disabled={busy || !txtId || !toUserId}
        >
          {busy && (
            <span
              className="spinner-border spinner-border-sm"
              role="status"
              aria-hidden="true"
            />
          )}
          Grant share
        </button>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Modal>
  );
}

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

export type SharesMode = "none" | "create" | "delete";

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
  const books = useMemo(
    () =>
      Array.from(booksById.values()).sort((a, b) =>
        a.title.localeCompare(b.title),
      ),
    [booksById],
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
      {mode === "create" && (
        <GrantShareForm
          session={session}
          books={books}
          users={users}
          shares={shares}
          onGranted={afterChange}
          onClose={() => onSetMode("none")}
        />
      )}
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
