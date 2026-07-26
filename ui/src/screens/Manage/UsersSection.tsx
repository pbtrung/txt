// Manage screen's Users section: create/list/edit (password reset + root-
// key rotation, both in one panel)/delete. Delete is hidden for the
// admin's own row -- an admin can never delete themselves through this
// screen (see ManageScreen.tsx's toolbarButtons, which omits it there).

import { useMemo, useState, type FormEvent } from "react";

import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import {
  AdminUsersError,
  createUser,
  deleteUser,
  rotateUserRootKey,
  updateUserPassword,
  type DownloadableUserCreds,
  type UserSummary,
} from "../../data/adminUsers";
import type { VaultSession } from "../../state/VaultContext";
import { ConfirmDeleteField, FORM_WIDTH, FormField, downloadJson, errorMessage, yieldToPaint } from "./manageShared";
import { UserRow, USER_ROW_HEIGHT } from "./UserRow";

function CreateUserForm({
  session,
  onCreated,
  onClose,
}: {
  session: VaultSession;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [tursoDatabaseUrl, setTursoDatabaseUrl] = useState(session.creds.tursoDatabaseUrl);
  const [displayName, setDisplayName] = useState("");
  const [userTursoAuthToken, setUserTursoAuthToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once creation succeeds. While non-null, the modal shows the
  // downloadable credential JSON instead of the form, and can only be
  // closed via the explicit "I've saved this" button below -- its Modal's
  // onClose becomes a no-op meanwhile (not the ×/backdrop-click/Escape it
  // normally responds to), since this is the one chance to save the
  // generated password/user_root_key, neither of which is ever held
  // anywhere in a retrievable form again afterward.
  const [createdCreds, setCreatedCreds] = useState<DownloadableUserCreds | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Lets the spinner/disabled state actually paint before createUser's
    // own synchronous compress+encrypt work blocks the main thread.
    await yieldToPaint();
    try {
      setCreatedCreds(
        await createUser(session.db, session.umk, session.r2Config, {
          tursoDatabaseUrl,
          displayName,
          userTursoAuthToken,
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (createdCreds) {
    return (
      <Modal title="Save this user's credentials" onClose={() => {}}>
        <div style={FORM_WIDTH}>
          <p className="small text-body-secondary">
            This is the only time the password and root key are ever shown -- download or copy this now, then confirm
            below. Neither can be recovered afterward.
          </p>
          <pre
            className="small bg-body-tertiary border rounded p-2"
            style={{ maxHeight: "16rem", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
          >
            {JSON.stringify(createdCreds, null, 2)}
          </pre>
          <div className="d-flex gap-2 mt-2">
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={() => downloadJson(`${createdCreds.username}_creds.json`, createdCreds)}
            >
              Download
            </button>
            <button type="button" className="btn btn-primary" onClick={onCreated}>
              I&apos;ve saved this -- close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create user" onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)} style={FORM_WIDTH}>
        <FormField label="Turso database URL" htmlFor="manage-new-turso-url">
          <input
            id="manage-new-turso-url"
            type="text"
            className="form-control themed-control"
            value={tursoDatabaseUrl}
            onChange={(e) => setTursoDatabaseUrl(e.target.value)}
            required
          />
        </FormField>
        <FormField label="Display name" htmlFor="manage-new-display-name">
          <input
            id="manage-new-display-name"
            type="text"
            className="form-control themed-control"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </FormField>
        <FormField label="Regular-user Turso token" htmlFor="manage-new-user-token">
          <input
            id="manage-new-user-token"
            type="text"
            className="form-control themed-control"
            value={userTursoAuthToken}
            onChange={(e) => setUserTursoAuthToken(e.target.value)}
            required
          />
        </FormField>
        <button type="submit" className="btn btn-primary mt-1 d-flex align-items-center gap-2" disabled={busy}>
          {busy && <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />}
          Create user
        </button>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Modal>
  );
}

function EditUserPanel({ session, userId, onClose }: { session: VaultSession; userId: number; onClose: () => void }) {
  const [newPassword, setNewPassword] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

  const [oldRootKey, setOldRootKey] = useState("");
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [newRootKey, setNewRootKey] = useState<string | null>(null);

  async function handleResetPassword(e: FormEvent) {
    e.preventDefault();
    setResetBusy(true);
    setResetError(null);
    setResetDone(false);
    try {
      await updateUserPassword(session.db, userId, newPassword);
      setNewPassword("");
      setResetDone(true);
    } catch (err) {
      setResetError(errorMessage(err));
    } finally {
      setResetBusy(false);
    }
  }

  async function handleRotate(e: FormEvent) {
    e.preventDefault();
    setRotateBusy(true);
    setRotateError(null);
    try {
      const rotated = await rotateUserRootKey(session.db, userId, oldRootKey);
      setNewRootKey(rotated);
      setOldRootKey("");
    } catch (err) {
      setRotateError(err instanceof AdminUsersError ? err.message : errorMessage(err));
    } finally {
      setRotateBusy(false);
    }
  }

  return (
    <Modal title={`Edit user #${userId}`} onClose={onClose}>
      <div style={FORM_WIDTH}>
        <h4 className="h6 small text-body-secondary text-uppercase mb-2">Reset password</h4>
        <form onSubmit={(e) => void handleResetPassword(e)}>
          <FormField label="New password" htmlFor="manage-edit-password">
            <input
              id="manage-edit-password"
              type="password"
              className="form-control themed-control"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </FormField>
          <button type="submit" className="btn btn-primary" disabled={resetBusy}>
            Save
          </button>
          {resetDone && <div className="text-success small mt-2">Password updated.</div>}
          {resetError && <div className="text-danger small mt-2">{resetError}</div>}
        </form>

        <h4 className="h6 small text-body-secondary text-uppercase mb-2 mt-4">Rotate root key</h4>
        <form onSubmit={(e) => void handleRotate(e)}>
          <FormField label="Current root key (base64)" htmlFor="manage-edit-root-key">
            <input
              id="manage-edit-root-key"
              type="text"
              className="form-control themed-control"
              value={oldRootKey}
              onChange={(e) => setOldRootKey(e.target.value)}
              required
            />
          </FormField>
          <button type="submit" className="btn btn-primary" disabled={rotateBusy}>
            Rotate
          </button>
          {rotateError && <div className="text-danger small mt-2">{rotateError}</div>}
          {newRootKey && (
            <div className="small mt-2">
              New key: <code className="text-break">{newRootKey}</code>
              <button
                type="button"
                className="btn btn-sm btn-link p-0 ms-2"
                onClick={() => downloadJson(`user_${userId}_root_key.json`, { user_root_key: newRootKey })}
              >
                Download
              </button>
            </div>
          )}
        </form>
      </div>
    </Modal>
  );
}

function DeleteUserPanel({
  session,
  userId,
  onDeleted,
  onClose,
}: {
  session: VaultSession;
  userId: number;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteUser(session.db, session.userId, userId);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Delete user #${userId}`} onClose={onClose}>
      <p className="small text-body-secondary" style={FORM_WIDTH}>
        This deletes user #{userId}&apos;s entire account: every txt they own, their shares, and their read
        position/bookmarks. Type <strong>{userId}</strong> to confirm.
      </p>
      <ConfirmDeleteField
        idToMatch={userId}
        confirmText={confirmText}
        onConfirmTextChange={setConfirmText}
        onConfirm={() => void handleDelete()}
        busy={busy}
      />
      {error && <div className="text-danger small mt-2">{error}</div>}
    </Modal>
  );
}

export type UsersMode = "none" | "create" | "edit" | "delete";

export function UsersSection({
  session,
  users,
  search,
  selectedUserId,
  mode,
  onSelectRow,
  onSetMode,
  onChanged,
}: {
  session: VaultSession;
  users: UserSummary[];
  search: string;
  selectedUserId: number | null;
  mode: UsersMode;
  onSelectRow: (id: number | null) => void;
  onSetMode: (mode: UsersMode) => void;
  onChanged: () => void;
}) {
  // users.creds can never hold the admin's own display name (it's always
  // NULL for that row -- see adminUsers.ts), but the admin's session already
  // carries it (same value the nav footer shows), so patch it in here --
  // once, ahead of both search and rendering -- rather than showing the
  // "Unnamed user" fallback for the one row that could actually be named.
  const withSelfName = useMemo(
    () => users.map((u) => (u.id === session.userId ? { ...u, displayName: session.creds.displayName } : u)),
    [users, session.userId, session.creds.displayName],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return withSelfName;
    return withSelfName.filter((u) => String(u.id).includes(q) || (u.displayName ?? "").toLowerCase().includes(q));
  }, [withSelfName, search]);

  function selectRow(id: number) {
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
        <CreateUserForm session={session} onCreated={afterChange} onClose={() => onSetMode("none")} />
      )}
      {mode === "edit" && selectedUserId !== null && (
        <EditUserPanel session={session} userId={selectedUserId} onClose={() => onSetMode("none")} />
      )}
      {mode === "delete" && selectedUserId !== null && (
        <DeleteUserPanel
          session={session}
          userId={selectedUserId}
          onDeleted={afterChange}
          onClose={() => onSetMode("none")}
        />
      )}

      <VirtualizedListGroup
        className="flex-grow-1"
        items={filtered}
        getKey={(user) => user.id}
        estimateRowHeight={USER_ROW_HEIGHT}
        emptyMessage="No users match here yet."
        renderRow={(user) => (
          <UserRow
            user={user}
            isSelf={user.id === session.userId}
            selected={selectedUserId === user.id}
            onClick={() => selectRow(user.id)}
          />
        )}
      />
    </div>
  );
}
