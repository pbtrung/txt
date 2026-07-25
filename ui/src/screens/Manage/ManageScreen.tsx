// Admin-only Manage screen (docs/ui.md) -- reachable by clicking the
// account name in Library's nav footer, gated by RequireAdmin (session.isAdmin,
// see crypto/jwt.ts). Mirrors Library's own two-pane shell exactly (same top
// bar: wordmark + search field; same lg+ persistent sidebar / below-lg
// dropdown split) rather than inventing a different layout for one more
// screen -- the nav here just has different content: a "Library" link back,
// then Users/Books/Shares. The search field filters whichever section is
// currently selected, not a fixed list the way Library's does.
//
// Three sections, each a select-a-row-then-act toolbar (Create/Edit/Delete,
// only the actions that actually apply):
// - Users: create/list/edit (password reset + root-key rotation, both in
//   one panel)/delete. Delete is hidden for the admin's own row -- an admin
//   can never delete themselves through this screen.
// - Books: the admin's own txt only (see the plan this was built from --
//   only the admin ever holds any). No Create -- that stays a
//   --txt-ingest-only operation. Edit changes curated metadata fields;
//   Delete now genuinely removes R2 parts too (see VaultContext's deleteTxt),
//   not just Turso rows.
// - Shares: existing grants on the admin's own txt. Create grants a new one;
//   Delete revokes the selected one immediately, no confirm step (unlike
//   Users/Books delete) -- a share is easy to re-grant, unlike an account or
//   a txt.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { DropdownToggleButton } from "../../components/DropdownToggleButton";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import { Wordmark } from "../../components/Wordmark";
import { useDropdown } from "../../hooks/useDropdown";
import {
  AdminUsersError,
  createUser,
  deleteUser,
  listUsers,
  rotateUserRootKey,
  updateUserPassword,
} from "../../data/adminUsers";
import { grantShare, listShares, revokeShare, type ShareEntry } from "../../data/adminShares";
import type { BookInfo } from "../../data/metadata";
import { useVault, type VaultSession } from "../../state/VaultContext";

type Section = "users" | "books" | "shares";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function NavItem({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <span className="text-truncate">{label}</span>
      <span className={`flex-shrink-0 ${active ? "" : "text-body-secondary"}`}>{count}</span>
    </button>
  );
}

function ManageNavContent({
  section,
  selectSection,
  usersCount,
  booksCount,
  sharesCount,
}: {
  section: Section;
  selectSection: (next: Section) => void;
  usersCount: number;
  booksCount: number;
  sharesCount: number;
}) {
  return (
    <div className="flex-grow-1 overflow-auto">
      <div className="list-group list-group-flush mb-3">
        <Link to="/library" className="list-group-item list-group-item-action d-flex align-items-center gap-2">
          <i className="bi bi-arrow-left" aria-hidden="true" />
          <span>Library</span>
        </Link>
      </div>
      <div className="list-group list-group-flush">
        <NavItem active={section === "users"} label="Users" count={usersCount} onClick={() => selectSection("users")} />
        <NavItem active={section === "books"} label="Books" count={booksCount} onClick={() => selectSection("books")} />
        <NavItem
          active={section === "shares"}
          label="Shares"
          count={sharesCount}
          onClick={() => selectSection("shares")}
        />
      </div>
    </div>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="d-flex gap-2 px-3 py-2 border-bottom">{children}</div>;
}

// Every row here is a single, text-truncate'd line (a user id, a book
// title, or a txt-title-to-recipient-id share) -- same reasoning as
// Library's BROWSE_ENTRY_ROW_HEIGHT: a plain constant is safe since the
// rendered height never depends on content.
const ROW_HEIGHT = 44;

function SelectableRow({
  selected,
  onClick,
  children,
  style,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      style={style}
      className={`list-group-item list-group-item-action text-start ${selected ? "active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Users ---

function CreateUserForm({ session, onCreated }: { session: VaultSession; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [userTursoAuthToken, setUserTursoAuthToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="p-3 border-bottom">
      <div className="row row-cols-auto g-2 align-items-end">
        <div className="col">
          <label htmlFor="manage-new-username" className="form-label small mb-1">
            Username
          </label>
          <input
            id="manage-new-username"
            type="text"
            className="form-control form-control-sm themed-control"
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
            className="form-control form-control-sm themed-control"
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
            className="form-control form-control-sm themed-control"
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
            className="form-control form-control-sm themed-control"
            style={{ minWidth: "16rem" }}
            value={userTursoAuthToken}
            onChange={(e) => setUserTursoAuthToken(e.target.value)}
            required
          />
        </div>
        <div className="col">
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
            Create user
          </button>
        </div>
      </div>
      {error && <div className="text-danger small mt-2">{error}</div>}
    </form>
  );
}

function EditUserPanel({ session, userId }: { session: VaultSession; userId: number }) {
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
    <div className="p-3 border-bottom">
      <h3 className="h6">Edit user #{userId}</h3>

      <form onSubmit={(e) => void handleResetPassword(e)} className="d-flex gap-2 align-items-end mb-3">
        <div>
          <label htmlFor="manage-edit-password" className="form-label small mb-1">
            New password
          </label>
          <input
            id="manage-edit-password"
            type="password"
            className="form-control form-control-sm themed-control"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn btn-sm btn-primary" disabled={resetBusy}>
          Save
        </button>
        {resetDone && <span className="text-success small">Password updated.</span>}
        {resetError && <span className="text-danger small">{resetError}</span>}
      </form>

      <form onSubmit={(e) => void handleRotate(e)} className="d-flex gap-2 align-items-end">
        <div>
          <label htmlFor="manage-edit-root-key" className="form-label small mb-1">
            Current root key (base64)
          </label>
          <input
            id="manage-edit-root-key"
            type="text"
            className="form-control form-control-sm themed-control"
            style={{ minWidth: "20rem" }}
            value={oldRootKey}
            onChange={(e) => setOldRootKey(e.target.value)}
            required
          />
        </div>
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
  );
}

function DeleteUserPanel({
  session,
  userId,
  onDeleted,
}: {
  session: VaultSession;
  userId: number;
  onDeleted: () => void;
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
    <div className="p-3 border-bottom">
      <p className="small text-body-secondary mb-1">
        This deletes user #{userId}&apos;s entire account: every txt they own, their shares, and their read
        position/bookmarks. Type <strong>{userId}</strong> to confirm.
      </p>
      <div className="d-flex gap-2 align-items-center">
        <input
          type="text"
          className="form-control form-control-sm themed-control"
          style={{ maxWidth: "8rem" }}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={confirmText !== String(userId) || busy}
          onClick={() => void handleDelete()}
        >
          Confirm delete
        </button>
      </div>
      {error && <div className="text-danger small mt-1">{error}</div>}
    </div>
  );
}

type UsersMode = "none" | "create" | "edit" | "delete";

function UsersSection({
  session,
  userIds,
  search,
  onChanged,
}: {
  session: VaultSession;
  userIds: number[];
  search: string;
  onChanged: () => void;
}) {
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [mode, setMode] = useState<UsersMode>("none");

  const filtered = useMemo(() => {
    const q = search.trim();
    return q ? userIds.filter((id) => String(id).includes(q)) : userIds;
  }, [userIds, search]);

  function selectRow(id: number) {
    setSelectedUserId(id);
    setMode("none");
  }

  function afterChange() {
    setMode("none");
    setSelectedUserId(null);
    onChanged();
  }

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      <Toolbar>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => setMode(mode === "create" ? "none" : "create")}
        >
          Create
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          disabled={selectedUserId === null}
          onClick={() => setMode(mode === "edit" ? "none" : "edit")}
        >
          Edit
        </button>
        {selectedUserId !== null && selectedUserId !== session.userId && (
          <button
            type="button"
            className="btn btn-sm btn-outline-danger"
            onClick={() => setMode(mode === "delete" ? "none" : "delete")}
          >
            Delete
          </button>
        )}
      </Toolbar>

      {mode === "create" && <CreateUserForm session={session} onCreated={afterChange} />}
      {mode === "edit" && selectedUserId !== null && <EditUserPanel session={session} userId={selectedUserId} />}
      {mode === "delete" && selectedUserId !== null && (
        <DeleteUserPanel session={session} userId={selectedUserId} onDeleted={afterChange} />
      )}

      <VirtualizedListGroup
        className="flex-grow-1"
        items={filtered}
        getKey={(id) => id}
        estimateRowHeight={ROW_HEIGHT}
        emptyMessage="No users match here yet."
        renderRow={(id) => (
          <SelectableRow selected={selectedUserId === id} onClick={() => selectRow(id)}>
            User #{id}
            {id === session.userId && <span className="text-body-secondary small ms-2">(you)</span>}
          </SelectableRow>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Books ---

function EditBookPanel({
  book,
  onSaved,
}: {
  book: BookInfo;
  onSaved: (edits: BookMetadataFormValues) => Promise<void>;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [publisher, setPublisher] = useState(book.publisher ?? "");
  const [subjects, setSubjects] = useState(book.subjects.join(", "));
  const [description, setDescription] = useState(book.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSaved({
        title: title.trim() || undefined,
        author: author.trim() || undefined,
        publisher: publisher.trim() || undefined,
        subjects: subjects
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        description: description.trim() || undefined,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="p-3 border-bottom">
      <h3 className="h6">Edit metadata -- {book.title}</h3>
      <div className="row g-2" style={{ maxWidth: "36rem" }}>
        <div className="col-12">
          <label htmlFor="manage-book-title" className="form-label small mb-1">
            Title
          </label>
          <input
            id="manage-book-title"
            type="text"
            className="form-control form-control-sm themed-control"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="col-12">
          <label htmlFor="manage-book-author" className="form-label small mb-1">
            Author
          </label>
          <input
            id="manage-book-author"
            type="text"
            className="form-control form-control-sm themed-control"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
        <div className="col-12">
          <label htmlFor="manage-book-publisher" className="form-label small mb-1">
            Publisher
          </label>
          <input
            id="manage-book-publisher"
            type="text"
            className="form-control form-control-sm themed-control"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
          />
        </div>
        <div className="col-12">
          <label htmlFor="manage-book-subjects" className="form-label small mb-1">
            Subjects (comma-separated)
          </label>
          <input
            id="manage-book-subjects"
            type="text"
            className="form-control form-control-sm themed-control"
            value={subjects}
            onChange={(e) => setSubjects(e.target.value)}
          />
        </div>
        <div className="col-12">
          <label htmlFor="manage-book-description" className="form-label small mb-1">
            Description
          </label>
          <textarea
            id="manage-book-description"
            className="form-control form-control-sm themed-control"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <button type="submit" className="btn btn-sm btn-primary mt-2" disabled={busy}>
        Save
      </button>
      {error && <div className="text-danger small mt-2">{error}</div>}
    </form>
  );
}

interface BookMetadataFormValues {
  title?: string;
  author?: string;
  publisher?: string;
  subjects: string[];
  description?: string;
}

function DeleteBookPanel({ book, onDeleted }: { book: BookInfo; onDeleted: () => Promise<void> }) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="p-3 border-bottom">
      <p className="small text-body-secondary mb-1">
        This permanently deletes &ldquo;{book.title}&rdquo; and its stored content. Type <strong>{book.txtId}</strong>{" "}
        to confirm.
      </p>
      <div className="d-flex gap-2 align-items-center">
        <input
          type="text"
          className="form-control form-control-sm themed-control"
          style={{ maxWidth: "8rem" }}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={confirmText !== String(book.txtId) || busy}
          onClick={() => void handleDelete()}
        >
          Confirm delete
        </button>
      </div>
      {error && <div className="text-danger small mt-1">{error}</div>}
    </div>
  );
}

type BooksMode = "none" | "edit" | "delete";

function BooksSection({ books, search }: { books: BookInfo[]; search: string }) {
  const { deleteTxt, updateBookMetadata } = useVault();
  const [selectedTxtId, setSelectedTxtId] = useState<number | null>(null);
  const [mode, setMode] = useState<BooksMode>("none");

  const sorted = useMemo(() => [...books].sort((a, b) => a.title.localeCompare(b.title)), [books]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((b) => b.title.toLowerCase().includes(q) || (b.author ?? "").toLowerCase().includes(q));
  }, [sorted, search]);

  const selectedBook = selectedTxtId !== null ? books.find((b) => b.txtId === selectedTxtId) : undefined;

  function selectRow(txtId: number) {
    setSelectedTxtId(txtId);
    setMode("none");
  }

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      <Toolbar>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          disabled={!selectedBook}
          onClick={() => setMode(mode === "edit" ? "none" : "edit")}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-danger"
          disabled={!selectedBook}
          onClick={() => setMode(mode === "delete" ? "none" : "delete")}
        >
          Delete
        </button>
      </Toolbar>

      {mode === "edit" && selectedBook && (
        <EditBookPanel
          book={selectedBook}
          onSaved={async (edits) => {
            await updateBookMetadata(selectedBook.txtId, edits);
            setMode("none");
          }}
        />
      )}
      {mode === "delete" && selectedBook && (
        <DeleteBookPanel
          book={selectedBook}
          onDeleted={async () => {
            await deleteTxt(selectedBook.txtId);
            setMode("none");
            setSelectedTxtId(null);
          }}
        />
      )}

      <VirtualizedListGroup
        className="flex-grow-1"
        items={filtered}
        getKey={(book) => book.txtId}
        estimateRowHeight={ROW_HEIGHT}
        emptyMessage="No books match here yet."
        renderRow={(book) => (
          <SelectableRow selected={selectedTxtId === book.txtId} onClick={() => selectRow(book.txtId)}>
            <span className="text-truncate d-block">{book.title}</span>
          </SelectableRow>
        )}
      />
    </div>
  );
}

// --------------------------------------------------------------- Shares ---

function GrantShareForm({
  session,
  books,
  onGranted,
}: {
  session: VaultSession;
  books: BookInfo[];
  onGranted: () => void;
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
    <form onSubmit={(e) => void handleSubmit(e)} className="p-3 border-bottom">
      <div className="row row-cols-auto g-2 align-items-end">
        <div className="col">
          <label htmlFor="manage-grant-txt" className="form-label small mb-1">
            Txt
          </label>
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
        </div>
        <div className="col">
          <label htmlFor="manage-grant-recipient" className="form-label small mb-1">
            Recipient user id
          </label>
          <input
            id="manage-grant-recipient"
            type="number"
            className="form-control form-control-sm themed-control"
            value={recipientUserId}
            onChange={(e) => setRecipientUserId(e.target.value)}
            required
          />
        </div>
        <div className="col">
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
            Grant share
          </button>
        </div>
      </div>
      {error && <div className="text-danger small mt-2">{error}</div>}
    </form>
  );
}

function SharesSection({
  session,
  books,
  shares,
  search,
  onChanged,
}: {
  session: VaultSession;
  books: BookInfo[];
  shares: ShareEntry[];
  search: string;
  onChanged: () => void;
}) {
  const [selectedShareId, setSelectedShareId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shares;
    return shares.filter((s) => {
      const title = session.metadataById.get(s.txtId)?.title ?? "";
      return title.toLowerCase().includes(q) || String(s.toUserId).includes(q);
    });
  }, [shares, search, session.metadataById]);

  async function handleRevoke() {
    if (selectedShareId === null) return;
    setRevokeError(null);
    try {
      await revokeShare(session.db, selectedShareId);
      setSelectedShareId(null);
      onChanged();
    } catch (err) {
      setRevokeError(errorMessage(err));
    }
  }

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      <Toolbar>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setCreating((v) => !v)}>
          Create
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-danger"
          disabled={selectedShareId === null}
          onClick={() => void handleRevoke()}
        >
          Delete
        </button>
        {revokeError && <span className="text-danger small align-self-center">{revokeError}</span>}
      </Toolbar>

      {creating && (
        <GrantShareForm
          session={session}
          books={books}
          onGranted={() => {
            setCreating(false);
            onChanged();
          }}
        />
      )}

      <VirtualizedListGroup
        className="flex-grow-1"
        items={filtered}
        getKey={(share) => share.id}
        estimateRowHeight={ROW_HEIGHT}
        emptyMessage="No shares match here yet."
        renderRow={(share) => (
          <SelectableRow selected={selectedShareId === share.id} onClick={() => setSelectedShareId(share.id)}>
            <span className="text-truncate d-block">
              {session.metadataById.get(share.txtId)?.title ?? `txt #${share.txtId}`} &rarr; user #{share.toUserId}
            </span>
          </SelectableRow>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Shell ---

export function ManageScreen() {
  const { session } = useVault();
  const [section, setSection] = useState<Section>("users");
  const [search, setSearch] = useState("");
  const nav = useDropdown();

  function selectSection(next: Section) {
    setSection(next);
    setSearch("");
    nav.close();
  }

  const [userIds, setUserIds] = useState<number[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const loadUsers = useCallback(async () => {
    if (!session) return;
    try {
      setUserIds(await listUsers(session.db));
    } catch (err) {
      setUsersError(errorMessage(err));
    }
  }, [session]);
  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const books = useMemo(() => (session ? Array.from(session.metadataById.values()) : []), [session]);
  const ownTxtIds = useMemo(() => (session ? Array.from(session.metadataById.keys()) : []), [session]);

  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const loadShares = useCallback(async () => {
    if (!session) return;
    try {
      setShares(await listShares(session.db, ownTxtIds));
    } catch (err) {
      setSharesError(errorMessage(err));
    }
  }, [session, ownTxtIds]);
  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  if (!session) return null;

  const heading = { users: "Users", books: "Books", shares: "Shares" }[section];

  return (
    <div className="shell-60 d-flex flex-column vh-100">
      <div className="border-bottom d-flex flex-nowrap align-items-stretch">
        <div className="library-nav border-end p-2 d-none d-lg-flex align-items-center justify-content-center">
          <Wordmark />
        </div>

        <div
          ref={nav.ref}
          className="dropdown position-relative d-lg-none d-flex align-items-center gap-2 ps-2 ps-sm-3 py-2"
        >
          <DropdownToggleButton
            open={nav.open}
            onClick={nav.toggle}
            icon="bi-book"
            ariaLabel="Manage menu"
            className="d-flex align-items-center justify-content-center"
          />
          <span className="fw-semibold d-none d-sm-inline">Skypiea</span>
          {nav.open && (
            <div
              className="dropdown-menu app-dropdown-menu app-dropdown-menu-start show p-2 d-flex flex-column"
              style={{ width: "16rem", maxWidth: "90vw", maxHeight: "70vh" }}
            >
              <ManageNavContent
                section={section}
                selectSection={selectSection}
                usersCount={userIds?.length ?? 0}
                booksCount={books.length}
                sharesCount={shares?.length ?? 0}
              />
            </div>
          )}
        </div>

        <div className="flex-grow-1 d-flex align-items-center px-3 py-2" style={{ minWidth: 0 }}>
          <div className="position-relative search-bar-width">
            <i
              className="bi bi-search position-absolute top-50 start-0 translate-middle-y ms-3 text-body-secondary pe-none"
              aria-hidden="true"
            />
            <input
              type="search"
              className="form-control themed-control ps-5"
              placeholder={`Search ${heading.toLowerCase()}`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={`Search ${heading.toLowerCase()}`}
            />
          </div>
        </div>
      </div>

      <div className="flex-grow-1 d-flex flex-column flex-lg-row overflow-hidden">
        <div className="library-nav border-end p-2 d-none d-lg-flex">
          <ManageNavContent
            section={section}
            selectSection={selectSection}
            usersCount={userIds?.length ?? 0}
            booksCount={books.length}
            sharesCount={shares?.length ?? 0}
          />
        </div>

        <div className="flex-grow-1 d-flex flex-column overflow-hidden" style={{ minWidth: 0 }}>
          <div className="px-3 py-2 border-bottom">
            <h2 className="h6 mb-0">{heading}</h2>
          </div>

          {usersError && section === "users" && (
            <div className="alert alert-danger m-2 py-2 px-3" role="alert">
              {usersError}
            </div>
          )}
          {sharesError && section === "shares" && (
            <div className="alert alert-danger m-2 py-2 px-3" role="alert">
              {sharesError}
            </div>
          )}

          {section === "users" && (
            <UsersSection
              session={session}
              userIds={userIds ?? []}
              search={search}
              onChanged={() => void loadUsers()}
            />
          )}
          {section === "books" && <BooksSection books={books} search={search} />}
          {section === "shares" && (
            <SharesSection
              session={session}
              books={books}
              shares={shares ?? []}
              search={search}
              onChanged={() => void loadShares()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
