import { useEffect, useMemo, useState, type FormEvent } from "react";

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
  errorMessage,
  yieldToPaint,
} from "./manageShared";
import { UserRow, USER_ROW_HEIGHT } from "./UserRow";

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

function CredentialFields({
  values,
  onChange,
}: {
  values: UserCredentialFields;
  onChange: (values: UserCredentialFields) => void;
}) {
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
        <input
          id="manage-user-firebase-password"
          type="password"
          className="form-control form-control-sm themed-control"
          value={values.firebasePassword}
          onChange={(e) => update("firebasePassword", e.target.value)}
          required
        />
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
      <FormField label="User root key" htmlFor="manage-user-root-key">
        <div className="input-group input-group-sm">
          <input
            id="manage-user-root-key"
            type="text"
            className="form-control themed-control"
            value={values.userRootKey}
            onChange={(e) => update("userRootKey", e.target.value)}
            required
          />
          <button
            type="button"
            className="btn btn-outline-secondary border-primary"
            onClick={() => update("userRootKey", generateUserRootKey())}
          >
            Generate
          </button>
        </div>
      </FormField>
    </>
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
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setProgress(null);
    await yieldToPaint();
    try {
      await createUser(session.instantDb, session, values, setProgress);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
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
  const [values, setValues] = useState<UserCredentialFields | null>(null);
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
          setValues(
            stored ?? {
              ...credentialDefaults(session),
              firebaseEmail: user.email ?? "",
              displayName: user.displayName ?? "",
            },
          );
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!values) return;
    setBusy(true);
    setError(null);
    await yieldToPaint();
    try {
      await updateUserCreds(session.instantDb, session, user.id, values);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit ${user.displayName ?? user.email ?? user.id}`}
      onClose={onClose}
    >
      {loading && <div className="text-body-secondary small">Loading...</div>}
      {!loading && values && (
        <form onSubmit={(e) => void handleSubmit(e)}>
          <CredentialFields values={values} onChange={setValues} />
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
            Save
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
