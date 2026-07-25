// Admin-only Manage screen (docs/ui.md) -- reachable by clicking the
// account name in Library's nav footer, gated by RequireAdmin (session.isAdmin,
// see crypto/jwt.ts). Mirrors Library's own two-pane shell exactly (same top
// bar: wordmark + search field; same lg+ persistent sidebar / below-lg
// dropdown split; same account footer at the bottom of the nav, display_name
// just never a link here since this screen already *is* where that link
// would go) rather than inventing a different layout for one more screen --
// the nav's own content differs: a "Library" link back, then Users/Books/
// Shares. The search field filters whichever section is currently
// selected, not a fixed list the way Library's does.
//
// Three sections, each a select-a-row-then-act toolbar (Create/Edit/Delete,
// only the actions that actually apply), every action opening the same
// kind of panel -- a bordered, shaded card directly under the toolbar, one
// vertically-stacked labeled field per row, capped at a readable width --
// rather than each form inventing its own layout:
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
  displayName,
  onLock,
  onRefresh,
  refreshing,
}: {
  section: Section;
  selectSection: (next: Section) => void;
  usersCount: number;
  booksCount: number;
  sharesCount: number;
  displayName: string | undefined;
  onLock: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <>
      <div className="flex-grow-1 overflow-auto">
        <div className="list-group list-group-flush mb-3">
          <Link to="/library" className="list-group-item list-group-item-action d-flex align-items-center gap-2">
            <i className="bi bi-arrow-left" aria-hidden="true" />
            <span>Library</span>
          </Link>
        </div>
        <div className="list-group list-group-flush">
          <NavItem
            active={section === "users"}
            label="Users"
            count={usersCount}
            onClick={() => selectSection("users")}
          />
          <NavItem
            active={section === "books"}
            label="Books"
            count={booksCount}
            onClick={() => selectSection("books")}
          />
          <NavItem
            active={section === "shares"}
            label="Shares"
            count={sharesCount}
            onClick={() => selectSection("shares")}
          />
        </div>
      </div>

      {/* Same account footer as Library's own nav -- person icon, display
          name, Refresh/Lock -- except display_name is never a link here
          (this screen already *is* where that link would go). */}
      <div className="border-top pt-2 mt-2 d-flex align-items-center justify-content-between gap-2">
        <span className="d-flex align-items-center gap-2 text-truncate">
          <i className="bi bi-person-circle text-body-secondary flex-shrink-0" aria-hidden="true" />
          <span className="small text-body-secondary text-truncate">{displayName}</span>
        </span>
        <span className="d-flex align-items-center gap-2 flex-shrink-0">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary border-primary flex-shrink-0"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh"
          >
            {refreshing ? (
              <span className="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true" />
            ) : (
              <i className="bi bi-arrow-clockwise text-primary" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary border-primary flex-shrink-0"
            onClick={onLock}
            aria-label="Lock"
            title="Lock"
          >
            <i className="bi bi-unlock text-primary" aria-hidden="true" />
          </button>
        </span>
      </div>
    </>
  );
}

// ------------------------------------------------------------- Shared UI ---

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="d-flex gap-2 px-3 py-2 border-bottom">{children}</div>;
}

function ToolbarButton({
  icon,
  variant = "secondary",
  disabled,
  onClick,
  children,
}: {
  icon: string;
  variant?: "secondary" | "danger";
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn btn-sm btn-outline-${variant} d-flex align-items-center gap-1`}
      disabled={disabled}
      onClick={onClick}
    >
      <i className={`bi ${icon}`} aria-hidden="true" />
      {children}
    </button>
  );
}

/** The card every Create/Edit/Delete action panel opens into, directly
 * under the toolbar -- one consistent container/heading style instead of
 * each form inventing its own. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="p-3 border-bottom bg-body-tertiary">
      <h3 className="h6 mb-3">{title}</h3>
      {children}
    </div>
  );
}

/** One labeled field, stacked label-above-input -- the one field layout
 * every form in this screen uses, instead of some forms stacking fields
 * and others laying them out in a row. */
function FormField({
  label,
  htmlFor,
  style,
  children,
}: {
  label: string;
  htmlFor: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className="mb-2" style={style}>
      <label htmlFor={htmlFor} className="form-label small mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

const FORM_WIDTH = { maxWidth: "26rem" };

function ConfirmDeleteField({
  idToMatch,
  confirmText,
  onConfirmTextChange,
  onConfirm,
  busy,
}: {
  idToMatch: number;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="d-flex gap-2 align-items-center">
      <input
        type="text"
        className="form-control form-control-sm themed-control"
        style={{ maxWidth: "8rem" }}
        value={confirmText}
        onChange={(e) => onConfirmTextChange(e.target.value)}
        aria-label={`Type ${idToMatch} to confirm`}
      />
      <button
        type="button"
        className="btn btn-sm btn-danger"
        disabled={confirmText !== String(idToMatch) || busy}
        onClick={onConfirm}
      >
        Confirm delete
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Users ---

// Every row here is a single, text-truncate'd line (a user id, a book
// title, or a txt-title-to-recipient-id share) -- same reasoning as
// Library's BROWSE_ENTRY_ROW_HEIGHT: a plain constant is safe since the
// rendered height never depends on content.
const ROW_HEIGHT = 44;

function SelectableRow({
  icon,
  selected,
  onClick,
  children,
  style,
}: {
  icon: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      style={style}
      className={`list-group-item list-group-item-action d-flex align-items-center gap-2 text-start ${selected ? "active" : ""}`}
      onClick={onClick}
    >
      <i className={`bi ${icon} ${selected ? "" : "text-body-secondary"} flex-shrink-0`} aria-hidden="true" />
      <span className="text-truncate">{children}</span>
    </button>
  );
}

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
    <Panel title="Create user">
      <form onSubmit={(e) => void handleSubmit(e)} style={FORM_WIDTH}>
        <FormField label="Username" htmlFor="manage-new-username">
          <input
            id="manage-new-username"
            type="text"
            className="form-control form-control-sm themed-control"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </FormField>
        <FormField label="Password" htmlFor="manage-new-password">
          <input
            id="manage-new-password"
            type="password"
            className="form-control form-control-sm themed-control"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
        <button type="submit" className="btn btn-sm btn-primary mt-1" disabled={busy}>
          Create user
        </button>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Panel>
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
    <Panel title={`Edit user #${userId}`}>
      <div className="row g-4" style={{ maxWidth: "40rem" }}>
        <div className="col-12 col-sm-6">
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
        </div>

        <div className="col-12 col-sm-6">
          <h4 className="h6 small text-body-secondary text-uppercase mb-2">Rotate root key</h4>
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
      </div>
    </Panel>
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
    <Panel title={`Delete user #${userId}`}>
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
    </Panel>
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
        <ToolbarButton icon="bi-plus-lg" onClick={() => setMode(mode === "create" ? "none" : "create")}>
          Create
        </ToolbarButton>
        <ToolbarButton
          icon="bi-pencil"
          disabled={selectedUserId === null}
          onClick={() => setMode(mode === "edit" ? "none" : "edit")}
        >
          Edit
        </ToolbarButton>
        {selectedUserId !== null && selectedUserId !== session.userId && (
          <ToolbarButton
            icon="bi-trash"
            variant="danger"
            onClick={() => setMode(mode === "delete" ? "none" : "delete")}
          >
            Delete
          </ToolbarButton>
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
          <SelectableRow icon="bi-person-circle" selected={selectedUserId === id} onClick={() => selectRow(id)}>
            User #{id}
            {id === session.userId && <span className="text-body-secondary small ms-2">(you)</span>}
          </SelectableRow>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Books ---

interface BookMetadataFormValues {
  title?: string;
  author?: string;
  publisher?: string;
  subjects: string[];
  description?: string;
}

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
    <Panel title={`Edit metadata -- ${book.title}`}>
      <form onSubmit={(e) => void handleSubmit(e)} style={FORM_WIDTH}>
        <FormField label="Title" htmlFor="manage-book-title">
          <input
            id="manage-book-title"
            type="text"
            className="form-control form-control-sm themed-control"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>
        <FormField label="Author" htmlFor="manage-book-author">
          <input
            id="manage-book-author"
            type="text"
            className="form-control form-control-sm themed-control"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </FormField>
        <FormField label="Publisher" htmlFor="manage-book-publisher">
          <input
            id="manage-book-publisher"
            type="text"
            className="form-control form-control-sm themed-control"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
          />
        </FormField>
        <FormField label="Subjects (comma-separated)" htmlFor="manage-book-subjects">
          <input
            id="manage-book-subjects"
            type="text"
            className="form-control form-control-sm themed-control"
            value={subjects}
            onChange={(e) => setSubjects(e.target.value)}
          />
        </FormField>
        <FormField label="Description" htmlFor="manage-book-description">
          <textarea
            id="manage-book-description"
            className="form-control form-control-sm themed-control"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        <button type="submit" className="btn btn-sm btn-primary mt-1" disabled={busy}>
          Save
        </button>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Panel>
  );
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
    <Panel title={`Delete "${book.title}"`}>
      <p className="small text-body-secondary" style={FORM_WIDTH}>
        This permanently deletes &ldquo;{book.title}&rdquo; and its stored content. Type <strong>{book.txtId}</strong>{" "}
        to confirm.
      </p>
      <ConfirmDeleteField
        idToMatch={book.txtId}
        confirmText={confirmText}
        onConfirmTextChange={setConfirmText}
        onConfirm={() => void handleDelete()}
        busy={busy}
      />
      {error && <div className="text-danger small mt-2">{error}</div>}
    </Panel>
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
        <ToolbarButton
          icon="bi-pencil"
          disabled={!selectedBook}
          onClick={() => setMode(mode === "edit" ? "none" : "edit")}
        >
          Edit
        </ToolbarButton>
        <ToolbarButton
          icon="bi-trash"
          variant="danger"
          disabled={!selectedBook}
          onClick={() => setMode(mode === "delete" ? "none" : "delete")}
        >
          Delete
        </ToolbarButton>
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
          <SelectableRow icon="bi-book" selected={selectedTxtId === book.txtId} onClick={() => selectRow(book.txtId)}>
            {book.title}
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
    <Panel title="Grant a share">
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
    </Panel>
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
        <ToolbarButton icon="bi-plus-lg" onClick={() => setCreating((v) => !v)}>
          Create
        </ToolbarButton>
        <ToolbarButton
          icon="bi-trash"
          variant="danger"
          disabled={selectedShareId === null}
          onClick={() => void handleRevoke()}
        >
          Delete
        </ToolbarButton>
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
          <SelectableRow
            icon="bi-share"
            selected={selectedShareId === share.id}
            onClick={() => setSelectedShareId(share.id)}
          >
            {session.metadataById.get(share.txtId)?.title ?? `txt #${share.txtId}`} &rarr; user #{share.toUserId}
          </SelectableRow>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Shell ---

export function ManageScreen() {
  const { session, lock, refresh, refreshing } = useVault();
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

  // Refreshing re-loads the vault's own data (session.metadataById, via
  // VaultContext's refresh()) *and* this screen's own Users/Shares lists --
  // Library's Refresh only needs the former, but here all three can drift
  // out of date the same way.
  async function handleRefresh() {
    nav.close();
    await refresh();
    await Promise.all([loadUsers(), loadShares()]);
  }

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
            disabled={refreshing}
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
                displayName={session.creds.displayName}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={refreshing}
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
              disabled={refreshing}
              aria-label={`Search ${heading.toLowerCase()}`}
            />
          </div>
        </div>
      </div>

      <div className="flex-grow-1 d-flex flex-column flex-lg-row overflow-hidden">
        {refreshing ? (
          <div className="flex-grow-1 d-flex flex-column align-items-center justify-content-center gap-1" role="status">
            <div className="spinner-border text-primary mb-1" aria-hidden="true" />
            <div className="small text-body-secondary">Refreshing…</div>
          </div>
        ) : (
          <>
            <div className="library-nav border-end p-2 d-none d-lg-flex">
              <ManageNavContent
                section={section}
                selectSection={selectSection}
                usersCount={userIds?.length ?? 0}
                booksCount={books.length}
                sharesCount={shares?.length ?? 0}
                displayName={session.creds.displayName}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={refreshing}
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
          </>
        )}
      </div>
    </div>
  );
}
