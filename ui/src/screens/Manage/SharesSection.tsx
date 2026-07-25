// Manage screen's Shares section: existing grants on the admin's own txt.
// Create grants a new one; revoking (the shell's toolbar "Delete" button --
// see ManageScreen.tsx's handleRevokeShare) fires immediately, no confirm
// step (unlike Users/Books delete) -- a share is easy to re-grant, unlike
// an account or a txt.

import { useMemo, useState, type FormEvent } from "react";

import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import { grantShare, type ShareEntry } from "../../data/adminShares";
import type { BookInfo } from "../../data/metadata";
import { useVault, type VaultSession } from "../../state/VaultContext";
import { FORM_WIDTH, FormField, SelectableRow, errorMessage } from "./manageShared";

// Every row here is a single, text-truncate'd line (a txt-title-to-
// recipient-id share) -- same reasoning as Library's own
// BROWSE_ENTRY_ROW_HEIGHT: a plain constant is safe since the rendered
// height never depends on content.
const ROW_HEIGHT = 44;

function GrantShareForm({
  session,
  books,
  onGranted,
  onClose,
}: {
  session: VaultSession;
  books: BookInfo[];
  onGranted: () => void;
  onClose: () => void;
}) {
  const { getTxtKey } = useVault();
  const [txtId, setTxtId] = useState("");
  const [recipientUserId, setRecipientUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <form onSubmit={(e) => void handleSubmit(e)} style={FORM_WIDTH}>
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
        <FormField label="Recipient user id" htmlFor="manage-grant-recipient">
          <input
            id="manage-grant-recipient"
            type="number"
            className="form-control form-control-sm themed-control"
            value={recipientUserId}
            onChange={(e) => setRecipientUserId(e.target.value)}
            required
          />
        </FormField>
        <button type="submit" className="btn btn-sm btn-primary mt-1" disabled={busy}>
          Grant share
        </button>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Modal>
  );
}

export type SharesMode = "none" | "create";

export function SharesSection({
  session,
  books,
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
  shares: ShareEntry[];
  search: string;
  selectedShareId: number | null;
  onSelectRow: (id: number | null) => void;
  mode: SharesMode;
  onSetMode: (mode: SharesMode) => void;
  onChanged: () => void;
}) {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shares;
    return shares.filter((s) => {
      const title = session.metadataById.get(s.txtId)?.title ?? "";
      return title.toLowerCase().includes(q) || String(s.toUserId).includes(q);
    });
  }, [shares, search, session.metadataById]);

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      {mode === "create" && (
        <GrantShareForm
          session={session}
          books={books}
          onGranted={() => {
            onSetMode("none");
            onChanged();
          }}
          onClose={() => onSetMode("none")}
        />
      )}

      <VirtualizedListGroup
        className="flex-grow-1"
        items={filtered}
        getKey={(share) => share.id}
        estimateRowHeight={ROW_HEIGHT}
        emptyMessage="No shares match here yet."
        renderRow={(share) => (
          <SelectableRow icon="bi-share" selected={selectedShareId === share.id} onClick={() => onSelectRow(share.id)}>
            {session.metadataById.get(share.txtId)?.title ?? `txt #${share.txtId}`} &rarr; user #{share.toUserId}
          </SelectableRow>
        )}
      />
    </div>
  );
}
