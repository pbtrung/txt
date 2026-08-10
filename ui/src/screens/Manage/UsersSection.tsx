import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { Modal } from "../../components/Modal";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import {
  createUser,
  deleteUser,
  generateUserRootKey,
  getUserCreds,
  updateUserCreds,
  type UserCredentialFields,
  type UserSummary,
} from "../../data/adminUsers";
import type { VaultSession } from "../../state/VaultContext";
import {
  ConfirmDeleteField,
  FormField,
  downloadJson,
  errorMessage,
  yieldToPaint,
} from "./manageShared";
import { UserRow, USER_ROW_HEIGHT } from "./UserRow";

const CREDENTIAL_REVIEW_TTL_MS = 2 * 60 * 1000;
const CREDENTIAL_FIELD_KEYS = [
  "instantAppId",
  "instantClientName",
  "firebaseEmail",
  "firebasePassword",
  "firebaseApiKey",
  "displayName",
  "userRootKey",
] as const satisfies readonly (keyof UserCredentialFields)[];

function credentialDefaults(session: VaultSession): UserCredentialFields {
  return {
    instantAppId: session.instantAppId,
    instantClientName: session.instantClientName,
    firebaseEmail: "",
    firebasePassword: "",
    firebaseApiKey: session.firebaseApiKey,
    displayName: "",
    userRootKey: generateUserRootKey(),
  };
}

function credentialsJson(values: UserCredentialFields): Record<string, string> {
  return {
    instant_app_id: values.instantAppId,
    instant_client_name: values.instantClientName,
    firebase_email: values.firebaseEmail,
    firebase_password: values.firebasePassword,
    firebase_api_key: values.firebaseApiKey,
    user_root_key: values.userRootKey,
  };
}

function credentialsJsonText(values: UserCredentialFields): string {
  return JSON.stringify(credentialsJson(values), null, 2);
}

function credentialsFilename(values: UserCredentialFields): string {
  const base =
    values.firebaseEmail.trim() || values.displayName.trim() || "user";
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safe || "user"}-creds.json`;
}

function credentialsChanged(
  a: UserCredentialFields,
  b: UserCredentialFields,
): boolean {
  return CREDENTIAL_FIELD_KEYS.some((key) => a[key] !== b[key]);
}

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard unavailable");
  }
  await navigator.clipboard.writeText(text);
}

function CredentialFields({
  values,
  onChange,
  showDisplayName = true,
}: {
  values: UserCredentialFields;
  onChange: (values: UserCredentialFields) => void;
  showDisplayName?: boolean;
}) {
  const [passwordVisible, setPasswordVisible] = useState(false);

  function update<K extends keyof UserCredentialFields>(
    key: K,
    value: UserCredentialFields[K],
  ) {
    onChange({ ...values, [key]: value });
  }

  return (
    <>
      <FormField label="Instant app ID" htmlFor="manage-user-instant-app-id">
        <input
          id="manage-user-instant-app-id"
          type="text"
          className="form-control form-control-sm themed-control"
          value={values.instantAppId}
          onChange={(e) => update("instantAppId", e.target.value)}
          required
        />
      </FormField>
      <FormField
        label="Instant client name"
        htmlFor="manage-user-instant-client-name"
      >
        <input
          id="manage-user-instant-client-name"
          type="text"
          className="form-control form-control-sm themed-control"
          value={values.instantClientName}
          onChange={(e) => update("instantClientName", e.target.value)}
          required
        />
      </FormField>
      <FormField label="Firebase email" htmlFor="manage-user-firebase-email">
        <input
          id="manage-user-firebase-email"
          type="email"
          className="form-control form-control-sm themed-control"
          value={values.firebaseEmail}
          onChange={(e) => update("firebaseEmail", e.target.value)}
          required
        />
      </FormField>
      <FormField
        label="Firebase password"
        htmlFor="manage-user-firebase-password"
      >
        <div className="input-group input-group-sm">
          <input
            id="manage-user-firebase-password"
            type={passwordVisible ? "text" : "password"}
            className="form-control themed-control"
            value={values.firebasePassword}
            onChange={(e) => update("firebasePassword", e.target.value)}
            required
          />
          <button
            type="button"
            className="btn btn-outline-secondary border-primary"
            onClick={() => setPasswordVisible((visible) => !visible)}
            aria-label={
              passwordVisible
                ? "Hide Firebase password"
                : "Show Firebase password"
            }
            title={
              passwordVisible
                ? "Hide Firebase password"
                : "Show Firebase password"
            }
          >
            <i
              className={`bi ${passwordVisible ? "bi-eye-slash" : "bi-eye"} text-primary`}
              aria-hidden="true"
            />
          </button>
        </div>
      </FormField>
      <FormField
        label="Firebase API key"
        htmlFor="manage-user-firebase-api-key"
      >
        <input
          id="manage-user-firebase-api-key"
          type="text"
          className="form-control form-control-sm themed-control"
          value={values.firebaseApiKey}
          onChange={(e) => update("firebaseApiKey", e.target.value)}
          required
        />
      </FormField>
      {showDisplayName && (
        <FormField label="Display name" htmlFor="manage-user-display-name">
          <input
            id="manage-user-display-name"
            type="text"
            className="form-control form-control-sm themed-control"
            value={values.displayName}
            onChange={(e) => update("displayName", e.target.value)}
            required
          />
        </FormField>
      )}
      <FormField label="User root key" htmlFor="manage-user-root-key">
        <div className="input-group input-group-sm">
          <input
            id="manage-user-root-key"
            type="text"
            className="form-control themed-control"
            value={values.userRootKey}
            disabled
          />
          <button
            type="button"
            className="btn btn-outline-danger"
            onClick={() => update("userRootKey", generateUserRootKey())}
            aria-label="Regenerate user root key"
            title="Regenerate user root key"
          >
            <i
              className="bi bi-arrow-clockwise text-danger"
              aria-hidden="true"
            />
          </button>
        </div>
      </FormField>
    </>
  );
}

function CredentialReviewModal({
  title,
  values,
  busy,
  primaryLabel,
  primaryDisabled = false,
  progress,
  error,
  children,
  onPrimary,
  onEdit,
  onClose,
}: {
  title: string;
  values: UserCredentialFields;
  busy: boolean;
  primaryLabel: string;
  primaryDisabled?: boolean;
  progress?: string | null;
  error?: string | null;
  children?: ReactNode;
  onPrimary: () => void;
  onEdit?: () => void;
  onClose: () => void;
}) {
  const [jsonText, setJsonText] = useState(() => credentialsJsonText(values));
  const [expired, setExpired] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setJsonText(credentialsJsonText(values));
    setExpired(false);
    setActionMessage(null);
    setActionError(null);
    const timeout = window.setTimeout(() => {
      setJsonText("");
      setExpired(true);
    }, CREDENTIAL_REVIEW_TTL_MS);
    return () => window.clearTimeout(timeout);
  }, [values]);

  useEffect(() => {
    if (!actionMessage) return;
    const timeout = window.setTimeout(() => setActionMessage(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [actionMessage]);

  async function handleCopy() {
    try {
      setActionError(null);
      await copyText(jsonText);
      setActionMessage("Copied");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  function handleDownload() {
    try {
      setActionError(null);
      downloadJson(credentialsFilename(values), credentialsJson(values));
      setActionMessage("Downloaded");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const disabled = busy || expired;

  return (
    <Modal title={title} onClose={onClose}>
      {expired ? (
        <div className="alert alert-warning py-2 px-3 small" role="alert">
          Credentials cleared.
        </div>
      ) : (
        <FormField label="Credentials JSON" htmlFor="manage-user-creds-json">
          <textarea
            id="manage-user-creds-json"
            className="form-control form-control-sm themed-control"
            style={{
              minHeight: "16rem",
              fontFamily: "var(--bs-font-monospace)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
            value={jsonText}
            readOnly
            spellCheck={false}
          />
        </FormField>
      )}

      {children}

      <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary border-primary d-flex align-items-center gap-1"
          onClick={() => void handleCopy()}
          disabled={disabled}
        >
          <i className="bi bi-clipboard text-primary" aria-hidden="true" />
          Copy
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary border-primary d-flex align-items-center gap-1"
          onClick={handleDownload}
          disabled={disabled}
        >
          <i className="bi bi-download text-primary" aria-hidden="true" />
          Download
        </button>
        {onEdit && (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary border-primary d-flex align-items-center gap-1"
            onClick={onEdit}
            disabled={busy}
          >
            <i className="bi bi-pencil text-primary" aria-hidden="true" />
            Edit
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-primary d-flex align-items-center gap-2"
          disabled={disabled || primaryDisabled}
          onClick={onPrimary}
        >
          {busy && (
            <span
              className="spinner-border spinner-border-sm"
              role="status"
              aria-hidden="true"
            />
          )}
          {primaryLabel}
        </button>
        {busy && progress && (
          <span className="small text-body-secondary">{progress}</span>
        )}
        {actionMessage && (
          <span className="small text-body-secondary">{actionMessage}</span>
        )}
      </div>
      {(error || actionError) && (
        <div className="text-danger small mt-2">{error ?? actionError}</div>
      )}
    </Modal>
  );
}

function CreateUserForm({
  session,
  onCreated,
  onClose,
}: {
  session: VaultSession;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState(() => credentialDefaults(session));
  const [reviewValues, setReviewValues] = useState<UserCredentialFields | null>(
    null,
  );
  const [downloadConfirmed, setDownloadConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setProgress(null);
    setDownloadConfirmed(false);
    setReviewValues({ ...values });
  }

  async function handleCreate() {
    if (!reviewValues) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    await yieldToPaint();
    try {
      await createUser(session.instantDb, session, reviewValues, setProgress);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (reviewValues) {
    return (
      <CredentialReviewModal
        title="Review new user credentials"
        values={reviewValues}
        busy={busy}
        primaryLabel="Create"
        primaryDisabled={!downloadConfirmed}
        progress={progress}
        error={error}
        onPrimary={() => void handleCreate()}
        onEdit={() => {
          setReviewValues(null);
          setDownloadConfirmed(false);
          setError(null);
          setProgress(null);
        }}
        onClose={onClose}
      >
        <div className="form-check mb-2">
          <input
            id="manage-create-user-creds-confirm"
            className="form-check-input"
            type="checkbox"
            checked={downloadConfirmed}
            onChange={(e) => setDownloadConfirmed(e.target.checked)}
            disabled={busy}
          />
          <label
            className="form-check-label small"
            htmlFor="manage-create-user-creds-confirm"
          >
            I downloaded this JSON to a local file
          </label>
        </div>
      </CredentialReviewModal>
    );
  }

  return (
    <Modal title="Create user" onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <CredentialFields values={values} onChange={setValues} />
        <div className="d-flex align-items-center gap-2 mt-1">
          <button
            type="submit"
            className="btn btn-sm btn-primary d-flex align-items-center gap-2"
            disabled={busy}
          >
            {busy && (
              <span
                className="spinner-border spinner-border-sm"
                role="status"
                aria-hidden="true"
              />
            )}
            Create user
          </button>
          {busy && progress && (
            <span className="small text-body-secondary">{progress}</span>
          )}
        </div>
        {error && <div className="text-danger small mt-2">{error}</div>}
      </form>
    </Modal>
  );
}

function EditUserPanel({
  session,
  user,
  onSaved,
  onClose,
}: {
  session: VaultSession;
  user: UserSummary;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [initialValues, setInitialValues] =
    useState<UserCredentialFields | null>(null);
  const [values, setValues] = useState<UserCredentialFields | null>(null);
  const [reviewValues, setReviewValues] = useState<UserCredentialFields | null>(
    null,
  );
  const [downloadConfirmed, setDownloadConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const stored = await getUserCreds(session.instantDb, session, user.id);
        if (!cancelled) {
          const nextValues = stored
            ? { ...stored, displayName: "" }
            : {
                ...credentialDefaults(session),
                firebaseEmail: user.email ?? "",
                displayName: "",
              };
          setInitialValues(nextValues);
          setValues(nextValues);
          setReviewValues(null);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [session, user]);

  const hasChanges =
    initialValues && values ? credentialsChanged(initialValues, values) : false;
  const reviewHasChanges =
    initialValues && reviewValues
      ? credentialsChanged(initialValues, reviewValues)
      : false;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!values || !hasChanges) return;
    setError(null);
    setDownloadConfirmed(false);
    setReviewValues({ ...values });
  }

  async function handleSave() {
    if (!reviewValues || !reviewHasChanges || !downloadConfirmed) return;
    setBusy(true);
    setError(null);
    await yieldToPaint();
    try {
      await updateUserCreds(session.instantDb, session, user.id, reviewValues);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (reviewValues) {
    return (
      <CredentialReviewModal
        title={`Review ${user.displayName || user.email}`}
        values={reviewValues}
        busy={busy}
        primaryLabel="Save"
        primaryDisabled={!reviewHasChanges || !downloadConfirmed}
        error={error}
        onPrimary={() => void handleSave()}
        onEdit={() => {
          setReviewValues(null);
          setDownloadConfirmed(false);
          setError(null);
        }}
        onClose={onClose}
      >
        <div className="form-check mb-2">
          <input
            id="manage-edit-user-creds-confirm"
            className="form-check-input"
            type="checkbox"
            checked={downloadConfirmed}
            onChange={(e) => setDownloadConfirmed(e.target.checked)}
            disabled={busy}
          />
          <label
            className="form-check-label small"
            htmlFor="manage-edit-user-creds-confirm"
          >
            I downloaded this JSON to a local file
          </label>
        </div>
      </CredentialReviewModal>
    );
  }

  return (
    <Modal title={`Edit ${user.displayName || user.email}`} onClose={onClose}>
      {loading && <div className="text-body-secondary small">Loading...</div>}
      {!loading && values && (
        <form onSubmit={(e) => void handleSubmit(e)}>
          <CredentialFields
            values={values}
            onChange={setValues}
            showDisplayName={false}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary d-flex align-items-center gap-2"
            disabled={busy || !hasChanges}
          >
            {busy && (
              <span
                className="spinner-border spinner-border-sm"
                role="status"
                aria-hidden="true"
              />
            )}
            Proceed
          </button>
        </form>
      )}
      {error && <div className="text-danger small mt-2">{error}</div>}
    </Modal>
  );
}

function DeleteUserPanel({
  session,
  user,
  onDeleted,
  onClose,
}: {
  session: VaultSession;
  user: UserSummary;
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
      await deleteUser(session.instantDb, session, user.id);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Delete ${user.displayName ?? user.email ?? user.id}`}
      onClose={onClose}
    >
      <p className="small text-body-secondary">
        This removes the user&apos;s InstantDB app data. Type{" "}
        <strong>{user.id}</strong> to confirm.
      </p>
      <ConfirmDeleteField
        idToMatch={user.id}
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
  onUserDeleted,
}: {
  session: VaultSession;
  users: UserSummary[];
  search: string;
  selectedUserId: string | null;
  mode: UsersMode;
  onSelectRow: (id: string | null) => void;
  onSetMode: (mode: UsersMode) => void;
  onChanged: () => void;
  onUserDeleted: () => void;
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

  const selectedUser = selectedUserId
    ? users.find((user) => user.id === selectedUserId)
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

  function afterDelete() {
    afterChange();
    onUserDeleted();
  }

  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      {mode === "create" && (
        <CreateUserForm
          session={session}
          onCreated={afterChange}
          onClose={() => onSetMode("none")}
        />
      )}
      {mode === "edit" && selectedUser && (
        <EditUserPanel
          session={session}
          user={selectedUser}
          onSaved={afterChange}
          onClose={() => onSetMode("none")}
        />
      )}
      {mode === "delete" && selectedUser && (
        <DeleteUserPanel
          session={session}
          user={selectedUser}
          onDeleted={afterDelete}
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
            isSelf={user.id === session.authId}
            selected={selectedUserId === user.id}
            onClick={() => selectRow(user.id)}
          />
        )}
      />
    </div>
  );
}
