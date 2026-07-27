// Manage screen's Users section: create/list/edit (password reset + root-
// key rotation, both in one panel)/delete. Delete is hidden for the
// admin's own row -- an admin can never delete themselves through this
// screen (see ManageScreen.tsx's toolbarButtons, which omits it there).

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import {
  AdminUsersError,
  deleteUser,
  generateNewUser,
  persistNewUser,
  rotateUserRootKey,
  updateGeneratedNewUser,
  updateUserPassword,
  type GeneratedNewUser,
  type UserSummary,
} from "../../data/adminUsers";
import type { VaultSession } from "../../state/VaultContext";
import { ConfirmDeleteField, FormField, downloadJson, errorMessage, yieldToPaint } from "./manageShared";
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
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  // Set once generation succeeds -- pure computation (see adminUsers.ts's
  // generateNewUser), nothing written to the database yet. While non-null,
  // the modal shows the downloadable credential JSON instead of the form.
  // Unlike an earlier version of this flow, the modal stays freely
  // closeable here: there's nothing to lose by backing out, since
  // persistNewUser (the only step that actually writes anything) hasn't run.
  const [generated, setGenerated] = useState<GeneratedNewUser | null>(null);
  const [copied, setCopied] = useState(false);
  // Cleared/reset on every click (not just set once) so the "Copied!"
  // alert re-appears for each copy, not only the first -- and clearing any
  // pending one first means a rapid second click restarts the same 2s
  // window rather than the first click's timeout cutting it short.
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    };
  }, []);
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const [persistBusy, setPersistBusy] = useState(false);
  // What persistNewUser is doing right now (its own account-then-
  // credentials write phases) -- shown beside the Create button's spinner,
  // same pattern as BooksSection's Edit Save.
  const [persistProgress, setPersistProgress] = useState<string | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  // Toggles the review step into editing the same three admin-supplied
  // fields the initial form took -- see updateGeneratedNewUser, which
  // leaves the generated username/password/keys untouched.
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    setGenerateBusy(true);
    setGenerateError(null);
    // Lets the spinner/disabled state actually paint before
    // generateNewUser's own synchronous compress+encrypt work blocks the
    // main thread.
    await yieldToPaint();
    try {
      setGenerated(
        await generateNewUser(session.umk, session.r2Config, {
          tursoDatabaseUrl,
          displayName,
          userTursoAuthToken,
        }),
      );
    } catch (err) {
      setGenerateError(errorMessage(err));
    } finally {
      setGenerateBusy(false);
    }
  }

  async function handleCreate() {
    if (!generated) return;
    setPersistBusy(true);
    setPersistError(null);
    setPersistProgress(null);
    await yieldToPaint();
    try {
      // The very last step that ever touches the database for a new
      // account -- everything up to here (this generated bundle, the
      // admin's confirmation checkbox) is local state only.
      await persistNewUser(session.db, generated, setPersistProgress);
      onCreated();
    } catch (err) {
      setPersistError(errorMessage(err));
    } finally {
      setPersistBusy(false);
      setPersistProgress(null);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(JSON.stringify(generated!.downloadable, null, 2));
    setCopied(true);
    if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }

  function startEditing() {
    if (!generated) return;
    setTursoDatabaseUrl(generated.downloadable.turso_database_url);
    setDisplayName(generated.downloadable.display_name);
    setUserTursoAuthToken(generated.downloadable.turso_auth_token);
    setEditError(null);
    setEditing(true);
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!generated) return;
    setEditBusy(true);
    setEditError(null);
    await yieldToPaint();
    try {
      setGenerated(
        await updateGeneratedNewUser(session.umk, generated, {
          tursoDatabaseUrl,
          displayName,
          userTursoAuthToken,
        }),
      );
      // The JSON just changed -- any earlier "I've saved this"/"Copied!"
      // state referred to the *previous* content, so both reset here rather
      // than letting Create stay enabled for content the admin never
      // actually saved.
      setConfirmedSaved(false);
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
      setCopied(false);
      setEditing(false);
    } catch (err) {
      setEditError(errorMessage(err));
    } finally {
      setEditBusy(false);
    }
  }

  if (generated && editing) {
    return (
      <Modal title="Edit credentials" onClose={onClose}>
        <form onSubmit={(e) => void handleSaveEdit(e)}>
          <FormField label="Turso database URL" htmlFor="manage-new-turso-url">
            <input
              id="manage-new-turso-url"
              type="text"
              className="form-control form-control-sm themed-control"
              value={tursoDatabaseUrl}
              onChange={(e) => setTursoDatabaseUrl(e.target.value)}
              required
            />
          </FormField>
          <FormField label="Display name" htmlFor="manage-new-display-name">
            <input
              id="manage-new-display-name"
              type="text"
              className="form-control form-control-sm themed-control"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </FormField>
          <FormField label="Regular-user Turso token" htmlFor="manage-new-user-token">
            <input
              id="manage-new-user-token"
              type="text"
              className="form-control form-control-sm themed-control"
              value={userTursoAuthToken}
              onChange={(e) => setUserTursoAuthToken(e.target.value)}
              required
            />
          </FormField>
          <div className="d-flex gap-2 mt-1">
            <button
              type="submit"
              className="btn btn-sm btn-primary d-flex align-items-center gap-2"
              disabled={editBusy}
            >
              {editBusy && <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />}
              Save
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => setEditing(false)}
              disabled={editBusy}
            >
              Cancel
            </button>
          </div>
          {editError && <div className="text-danger small mt-2">{editError}</div>}
        </form>
      </Modal>
    );
  }

  if (generated) {
    const creds = generated.downloadable;
    return (
      <Modal title="Save this user's credentials" onClose={onClose}>
        <div>
          <p className="small text-body-secondary">
            This is the only time the password and root key are ever shown -- download or copy this now, then confirm
            below. Neither can be recovered afterward.
          </p>
          <pre
            className="small bg-body-tertiary border rounded p-2"
            style={{ maxHeight: "16rem", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
          >
            {JSON.stringify(creds, null, 2)}
          </pre>
          <div className="d-flex gap-2 mt-2">
            <button type="button" className="btn btn-sm btn-outline-secondary border-primary" onClick={startEditing}>
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary border-primary"
              onClick={() => void handleCopy()}
            >
              Copy
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary border-primary"
              onClick={() => downloadJson(`${creds.username}_creds.json`, creds)}
            >
              Download
            </button>
          </div>
          {copied && <div className="text-success small mt-2">Copied to clipboard!</div>}
          <div className="form-check mt-3">
            <input
              id="manage-new-user-confirmed-saved"
              type="checkbox"
              className="form-check-input"
              checked={confirmedSaved}
              onChange={(e) => setConfirmedSaved(e.target.checked)}
            />
            <label className="form-check-label small" htmlFor="manage-new-user-confirmed-saved">
              I&apos;ve saved this configuration (downloaded or copied)
            </label>
          </div>
          <div className="d-flex align-items-center gap-2 mt-2">
            <button
              type="button"
              className="btn btn-sm btn-primary d-flex align-items-center gap-2"
              disabled={!confirmedSaved || persistBusy}
              onClick={() => void handleCreate()}
            >
              {persistBusy && <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />}
              Create user
            </button>
            {persistBusy && persistProgress && <span className="small text-body-secondary">{persistProgress}</span>}
          </div>
          {persistError && <div className="text-danger small mt-2">{persistError}</div>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create user" onClose={onClose}>
      <form onSubmit={(e) => void handleGenerate(e)}>
        <FormField label="Turso database URL" htmlFor="manage-new-turso-url">
          <input
            id="manage-new-turso-url"
            type="text"
            className="form-control form-control-sm themed-control"
            value={tursoDatabaseUrl}
            onChange={(e) => setTursoDatabaseUrl(e.target.value)}
            required
          />
        </FormField>
        <FormField label="Display name" htmlFor="manage-new-display-name">
          <input
            id="manage-new-display-name"
            type="text"
            className="form-control form-control-sm themed-control"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </FormField>
        <FormField label="Regular-user Turso token" htmlFor="manage-new-user-token">
          <input
            id="manage-new-user-token"
            type="text"
            className="form-control form-control-sm themed-control"
            value={userTursoAuthToken}
            onChange={(e) => setUserTursoAuthToken(e.target.value)}
            required
          />
        </FormField>
        <button
          type="submit"
          className="btn btn-sm btn-primary mt-1 d-flex align-items-center gap-2"
          disabled={generateBusy}
        >
          {generateBusy && <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />}
          Generate credentials
        </button>
        {generateError && <div className="text-danger small mt-2">{generateError}</div>}
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
      <div>
        <h4 className="h6 small text-body-secondary text-uppercase mb-2">Reset password</h4>
        <form onSubmit={(e) => void handleResetPassword(e)}>
          <FormField label="New password" htmlFor="manage-edit-password">
            <input
              id="manage-edit-password"
              type="password"
              className="form-control form-control-sm themed-control"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </FormField>
          <button type="submit" className="btn btn-sm btn-primary" disabled={resetBusy}>
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
              className="form-control form-control-sm themed-control"
              value={oldRootKey}
              onChange={(e) => setOldRootKey(e.target.value)}
              required
            />
          </FormField>
          <button type="submit" className="btn btn-sm btn-primary" disabled={rotateBusy}>
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
      <p className="small text-body-secondary">
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
  // The admin's own display name is already patched in by ManageScreen.tsx
  // (users.creds can never hold it -- that row's creds is always NULL, see
  // adminUsers.ts), shared with SharesSection's recipient list the same way.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => String(u.id).includes(q) || (u.displayName ?? "").toLowerCase().includes(q));
  }, [users, search]);

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
