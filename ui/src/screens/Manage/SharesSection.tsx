// Manage screen's Shares section: existing grants on the admin's own txt.
// Create grants a new one (recipient dropdown excludes the admin's own
// account -- only the admin ever owns/shares txt at all, see credentials.md,
// so sharing with themselves would be meaningless); Delete opens a
// lightweight confirm panel (DeleteSharePanel below) rather than firing
// immediately -- simpler than Users/Books' type-the-id ConfirmDeleteField,
// since a share is still easy to re-grant, unlike an account or a txt.

import { useMemo, useState, type FormEvent } from "react";

import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import { grantShare, revokeShare, type ShareEntry } from "../../data/adminShares";
import type { UserSummary } from "../../data/adminUsers";
import type { BookInfo } from "../../data/metadata";
import { useVault, type VaultSession } from "../../state/VaultContext";
import { FormField, errorMessage, userLabel } from "./manageShared";
import { ShareRow, SHARE_ROW_HEIGHT } from "./ShareRow";

function GrantShareForm({
  session,
  books,
  users,
  onGranted,
  onClose,
}: {
  session: VaultSession;
  books: BookInfo[];
  users: UserSummary[];
  onGranted: () => void;
  onClose: () => void;
}) {
  const { getTxtKey } = useVault();
  const [txtId, setTxtId] = useState("");
  const [recipientUserId, setRecipientUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the admin ever owns/shares txt at all (see file comment) -- sharing
  // with their own account would be a meaningless grant, so it's excluded
  // here rather than left for the admin to notice and avoid themselves.
  const recipients = useMemo(() => users.filter((u) => u.id !== session.userId), [users, session.userId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = Number(txtId);
      const txtKey = await getTxtKey(id);
      await grantShare(session.db, id, txtKey, Number(recipientUserId));
      setRecipientUserId("");
      onGranted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Grant a share" onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <FormField label="Txt" htmlFor="manage-grant-txt">
          <select
            id="manage-grant-txt"
            className="form-select form-select-sm themed-control"
            value={txtId}
            onChange={(e) => setTxtId(e.target.value)}
            required
          >
            <option value="" disabled>
              Choose a txt
            </option>
            {books.map((book) => (
              <option key={book.txtId} value={book.txtId}>
                {book.title}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Recipient" htmlFor="manage-grant-recipient">
          {/* Same cached Users list ManageScreen already loads for the
              Users section (see its own doc comment) -- picking a
              recipient by name/id here costs no extra query. */}
          <select
            id="manage-grant-recipient"
            className="form-select form-select-sm themed-control"
            value={recipientUserId}
            onChange={(e) => setRecipientUserId(e.target.value)}
            required
          >
            <option value="" disabled>
              Choose a recipient
            </option>
            {recipients.map((user) => (
              <option key={user.id} value={user.id}>
                {userLabel(user.displayName, user.id)}
              </option>
            ))}
          </select>
        </FormField>
        <button type="submit" className="btn btn-sm btn-primary mt-1" disabled={busy}>
          Grant share
        </button>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Modal>
  );
}

function DeleteSharePanel({
  session,
  share,
  title,
  recipientLabel,
  onRevoked,
  onClose,
}: {
  session: VaultSession;
  share: ShareEntry;
  title: string;
  recipientLabel: string;
  onRevoked: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await revokeShare(session.db, share.id);
      onRevoked();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Revoke share" onClose={onClose}>
      <p className="small text-body-secondary">
        This immediately revokes {recipientLabel}&apos;s access to &ldquo;{title}&rdquo;. They can be granted access
        again later.
      </p>
      <div className="d-flex gap-2">
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger d-flex align-items-center gap-2"
          onClick={() => void handleConfirm()}
          disabled={busy}
        >
          {busy && <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />}
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
  books,
  users,
  shares,
  search,
  selectedShareId,
  onSelectRow,
  mode,
  onSetMode,
  onChanged,
}: {
  session: VaultSession;
  books: BookInfo[];
  users: UserSummary[];
  shares: ShareEntry[];
  search: string;
  selectedShareId: number | null;
  onSelectRow: (id: number | null) => void;
  mode: SharesMode;
  onSetMode: (mode: SharesMode) => void;
  onChanged: () => void;
}) {
  // Recipient display names, keyed by id -- resolved from the same Users
  // list ManageScreen already loads for the Users section, not a second
  // fetch of its own.
  const displayNameById = useMemo(() => new Map(users.map((user) => [user.id, user.displayName])), [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shares;
    return shares.filter((s) => {
      const title = session.metadataById.get(s.txtId)?.title ?? "";
      const recipient = userLabel(displayNameById.get(s.toUserId), s.toUserId);
      return title.toLowerCase().includes(q) || recipient.toLowerCase().includes(q);
    });
  }, [shares, search, session.metadataById, displayNameById]);

  const selectedShare = selectedShareId !== null ? shares.find((s) => s.id === selectedShareId) : undefined;

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      {mode === "create" && (
        <GrantShareForm
          session={session}
          books={books}
          users={users}
          onGranted={() => {
            onSetMode("none");
            onChanged();
          }}
          onClose={() => onSetMode("none")}
        />
      )}
      {mode === "delete" && selectedShare && (
        <DeleteSharePanel
          session={session}
          share={selectedShare}
          title={session.metadataById.get(selectedShare.txtId)?.title ?? `txt #${selectedShare.txtId}`}
          recipientLabel={userLabel(displayNameById.get(selectedShare.toUserId), selectedShare.toUserId)}
          onRevoked={() => {
            onSetMode("none");
            onSelectRow(null);
            onChanged();
          }}
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
            title={session.metadataById.get(share.txtId)?.title ?? `txt #${share.txtId}`}
            toUserId={share.toUserId}
            recipientDisplayName={displayNameById.get(share.toUserId)}
            selected={selectedShareId === share.id}
            onClick={() => onSelectRow(share.id)}
          />
        )}
      />
    </div>
  );
}
