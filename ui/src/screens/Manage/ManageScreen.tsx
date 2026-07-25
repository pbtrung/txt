// Admin-only Manage screen (docs/ui.md) -- reachable by clicking the
// account name in Library's nav footer, gated by RequireAdmin (session.isAdmin,
// see crypto/jwt.ts). Three independent sections: Users (create/list/reset
// password/rotate root key/delete), Txt (the admin's own txt: delete only --
// no "add" here, that stays --txt-ingest-only), and Shares (grant/revoke,
// scoped to the admin's own txt as owner). See the plan this was built from
// for why each of those scopes/omissions is deliberate, not an oversight.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import {
  AdminUsersError,
  createUser,
  deleteUser,
  listUsers,
  rotateUserRootKey,
  updateUserPassword,
} from "../../data/adminUsers";
import { grantShare, listShares, revokeShare, type ShareEntry } from "../../data/adminShares";
import { useVault, type VaultSession } from "../../state/VaultContext";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Triggers a browser download of `data` as pretty-printed JSON -- used for
 * both a newly-created user's full credential file and a rotated root
 * key's one-field JSON. */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface UserRowProps {
  session: VaultSession;
  userId: number;
  onChanged: () => void;
}

function UserRow({ session, userId, onChanged }: UserRowProps) {
  const isSelf = userId === session.userId;

  const [resetOpen, setResetOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [rotateOpen, setRotateOpen] = useState(false);
  const [oldRootKey, setOldRootKey] = useState("");
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [newRootKey, setNewRootKey] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleResetPassword(e: FormEvent) {
    e.preventDefault();
    setResetBusy(true);
    setResetError(null);
    try {
      await updateUserPassword(session.db, userId, newPassword);
      setNewPassword("");
      setResetOpen(false);
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

  async function handleDelete() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteUser(session.db, session.userId, userId);
      onChanged();
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleteBusy(false);
    }
  }

  return (
    <li className="list-group-item">
      <div className="d-flex align-items-center justify-content-between gap-2">
        <span className="fw-semibold">User #{userId}</span>
        <span className="d-flex gap-2">
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setResetOpen((v) => !v)}>
            Reset password
          </button>
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setRotateOpen((v) => !v)}>
            Rotate root key
          </button>
          {!isSelf && (
            <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setConfirmOpen((v) => !v)}>
              Delete
            </button>
          )}
        </span>
      </div>

      {resetOpen && (
        <form onSubmit={(e) => void handleResetPassword(e)} className="d-flex gap-2 align-items-center mt-2">
          <input
            type="password"
            className="form-control form-control-sm"
            style={{ maxWidth: "16rem" }}
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={resetBusy}>
            Save
          </button>
          {resetError && <span className="text-danger small">{resetError}</span>}
        </form>
      )}

      {rotateOpen && (
        <div className="mt-2">
          <form onSubmit={(e) => void handleRotate(e)} className="d-flex gap-2 align-items-center">
            <input
              type="text"
              className="form-control form-control-sm"
              style={{ maxWidth: "24rem" }}
              placeholder="This user's current root key (base64)"
              value={oldRootKey}
              onChange={(e) => setOldRootKey(e.target.value)}
              required
            />
            <button type="submit" className="btn btn-sm btn-primary" disabled={rotateBusy}>
              Rotate
            </button>
          </form>
          {rotateError && <div className="text-danger small mt-1">{rotateError}</div>}
          {newRootKey && (
            <div className="small mt-1">
              New root key: <code>{newRootKey}</code>{" "}
              <button
                type="button"
                className="btn btn-sm btn-link p-0"
                onClick={() => downloadJson(`user_${userId}_root_key.json`, { user_root_key: newRootKey })}
              >
                Download
              </button>
            </div>
          )}
        </div>
      )}

      {confirmOpen && (
        <div className="mt-2">
          <p className="small text-body-secondary mb-1">
            This deletes user #{userId}&apos;s entire account: every txt they own (R2 storage for those becomes orphaned
            until <code>python txt.py --txt-clean-bucket</code> is run), their shares, and their read
            position/bookmarks. Type <strong>{userId}</strong> to confirm.
          </p>
          <div className="d-flex gap-2 align-items-center">
            <input
              type="text"
              className="form-control form-control-sm"
              style={{ maxWidth: "8rem" }}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={confirmText !== String(userId) || deleteBusy}
              onClick={() => void handleDelete()}
            >
              Confirm delete
            </button>
          </div>
          {deleteError && <div className="text-danger small mt-1">{deleteError}</div>}
        </div>
      )}
    </li>
  );
}

function UsersSection({ session }: { session: VaultSession }) {
  const [userIds, setUserIds] = useState<number[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      setUserIds(await listUsers(session.db));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [session.db]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [userTursoAuthToken, setUserTursoAuthToken] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const creds = await createUser(session.db, session.creds.tursoDatabaseUrl, session.r2Config, {
        username,
        password,
        displayName,
        userTursoAuthToken,
      });
      downloadJson(`${username}_creds.json`, creds);
      setUsername("");
      setPassword("");
      setDisplayName("");
      setUserTursoAuthToken("");
      await loadUsers();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="mb-5">
      <h2 className="h5">Users</h2>
      {loadError && (
        <div className="alert alert-danger py-2" role="alert">
          {loadError}
        </div>
      )}

      <form onSubmit={(e) => void handleCreate(e)} className="row row-cols-auto g-2 align-items-end mb-3">
        <div className="col">
          <label htmlFor="manage-new-username" className="form-label small mb-1">
            Username
          </label>
          <input
            id="manage-new-username"
            type="text"
            className="form-control form-control-sm"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="col">
          <label htmlFor="manage-new-password" className="form-label small mb-1">
            Password
          </label>
          <input
            id="manage-new-password"
            type="password"
            className="form-control form-control-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div className="col">
          <label htmlFor="manage-new-display-name" className="form-label small mb-1">
            Display name
          </label>
          <input
            id="manage-new-display-name"
            type="text"
            className="form-control form-control-sm"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </div>
        <div className="col">
          <label htmlFor="manage-new-user-token" className="form-label small mb-1">
            Regular-user Turso token
          </label>
          <input
            id="manage-new-user-token"
            type="text"
            className="form-control form-control-sm"
            style={{ minWidth: "16rem" }}
            value={userTursoAuthToken}
            onChange={(e) => setUserTursoAuthToken(e.target.value)}
            required
          />
        </div>
        <div className="col">
          <button type="submit" className="btn btn-sm btn-primary" disabled={creating}>
            Create user
          </button>
        </div>
        {createError && (
          <div className="col-12">
            <span className="text-danger small">{createError}</span>
          </div>
        )}
      </form>

      <ul className="list-group">
        {(userIds ?? []).map((id) => (
          <UserRow key={id} session={session} userId={id} onChanged={() => void loadUsers()} />
        ))}
      </ul>
    </section>
  );
}

interface TxtRowProps {
  session: VaultSession;
  txtId: number;
  title: string;
  deleteTxt: (txtId: number) => Promise<void>;
}

function TxtRow({ session: _session, txtId, title, deleteTxt }: TxtRowProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteTxt(txtId);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <li className="list-group-item">
      <div className="d-flex align-items-center justify-content-between gap-2">
        <span className="text-truncate">{title}</span>
        <button
          type="button"
          className="btn btn-sm btn-outline-danger flex-shrink-0"
          onClick={() => setConfirmOpen((v) => !v)}
        >
          Delete
        </button>
      </div>
      {confirmOpen && (
        <div className="mt-2">
          <p className="small text-body-secondary mb-1">
            Its R2 part storage becomes orphaned until <code>python txt.py --txt-clean-bucket</code> is run. Type{" "}
            <strong>{txtId}</strong> to confirm.
          </p>
          <div className="d-flex gap-2 align-items-center">
            <input
              type="text"
              className="form-control form-control-sm"
              style={{ maxWidth: "8rem" }}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={confirmText !== String(txtId) || busy}
              onClick={() => void handleDelete()}
            >
              Confirm delete
            </button>
          </div>
          {error && <div className="text-danger small mt-1">{error}</div>}
        </div>
      )}
    </li>
  );
}

function TxtSection({ session }: { session: VaultSession }) {
  const { deleteTxt } = useVault();
  const books = useMemo(
    () => Array.from(session.metadataById.values()).sort((a, b) => a.title.localeCompare(b.title)),
    [session.metadataById],
  );

  return (
    <section className="mb-5">
      <h2 className="h5">Txt</h2>
      <p className="small text-body-secondary">
        Only deletion is available here -- adding a new txt stays a <code>--txt-ingest</code>-only operation.
      </p>
      {books.length === 0 ? (
        <p className="text-body-secondary">No txt yet.</p>
      ) : (
        <ul className="list-group">
          {books.map((book) => (
            <TxtRow key={book.txtId} session={session} txtId={book.txtId} title={book.title} deleteTxt={deleteTxt} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SharesSection({ session }: { session: VaultSession }) {
  const ownTxtIds = useMemo(() => Array.from(session.metadataById.keys()), [session.metadataById]);
  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadShares = useCallback(async () => {
    try {
      setShares(await listShares(session.db, ownTxtIds));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [session.db, ownTxtIds]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  const { getTxtKey } = useVault();
  const [grantTxtId, setGrantTxtId] = useState<string>("");
  const [recipientUserId, setRecipientUserId] = useState("");
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  async function handleGrant(e: FormEvent) {
    e.preventDefault();
    setGranting(true);
    setGrantError(null);
    try {
      const txtId = Number(grantTxtId);
      const txtKey = await getTxtKey(txtId);
      await grantShare(session.db, txtId, txtKey, Number(recipientUserId));
      setRecipientUserId("");
      await loadShares();
    } catch (err) {
      setGrantError(errorMessage(err));
    } finally {
      setGranting(false);
    }
  }

  async function handleRevoke(shareId: number) {
    await revokeShare(session.db, shareId);
    await loadShares();
  }

  const books = useMemo(
    () => Array.from(session.metadataById.values()).sort((a, b) => a.title.localeCompare(b.title)),
    [session.metadataById],
  );

  return (
    <section className="mb-5">
      <h2 className="h5">Shares</h2>
      {loadError && (
        <div className="alert alert-danger py-2" role="alert">
          {loadError}
        </div>
      )}

      <form onSubmit={(e) => void handleGrant(e)} className="row row-cols-auto g-2 align-items-end mb-3">
        <div className="col">
          <label htmlFor="manage-grant-txt" className="form-label small mb-1">
            Txt
          </label>
          <select
            id="manage-grant-txt"
            className="form-select form-select-sm"
            value={grantTxtId}
            onChange={(e) => setGrantTxtId(e.target.value)}
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
        </div>
        <div className="col">
          <label htmlFor="manage-grant-recipient" className="form-label small mb-1">
            Recipient user id
          </label>
          <input
            id="manage-grant-recipient"
            type="number"
            className="form-control form-control-sm"
            value={recipientUserId}
            onChange={(e) => setRecipientUserId(e.target.value)}
            required
          />
        </div>
        <div className="col">
          <button type="submit" className="btn btn-sm btn-primary" disabled={granting}>
            Grant share
          </button>
        </div>
        {grantError && (
          <div className="col-12">
            <span className="text-danger small">{grantError}</span>
          </div>
        )}
      </form>

      {shares && shares.length === 0 && <p className="text-body-secondary">No shares yet.</p>}
      {shares && shares.length > 0 && (
        <ul className="list-group">
          {shares.map((share) => (
            <li key={share.id} className="list-group-item d-flex align-items-center justify-content-between gap-2">
              <span className="text-truncate">
                {session.metadataById.get(share.txtId)?.title ?? `txt #${share.txtId}`} &rarr; user #{share.toUserId}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary flex-shrink-0"
                onClick={() => void handleRevoke(share.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ManageScreen() {
  const navigate = useNavigate();
  const { session } = useVault();

  if (!session) return null;

  return (
    <div className="shell-60 d-flex flex-column vh-100">
      <div className="border-bottom d-flex align-items-center gap-3 ps-2 ps-sm-3 pe-3 py-2">
        <button
          type="button"
          className="btn btn-link text-decoration-none px-0"
          onClick={() => navigate("/library")}
          aria-label="Back to library"
          title="Back to library"
        >
          <i className="bi bi-arrow-left" aria-hidden="true" />
        </button>
        <span className="fw-semibold">Manage</span>
      </div>
      <div className="flex-grow-1 overflow-auto p-3">
        <UsersSection session={session} />
        <TxtSection session={session} />
        <SharesSection session={session} />
      </div>
    </div>
  );
}
