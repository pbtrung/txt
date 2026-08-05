import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { DropdownToggleButton } from "../../components/DropdownToggleButton";
import { InternalLink } from "../../components/InternalLink";
import { ProgressStatus } from "../../components/ProgressStatus";
import { Wordmark } from "../../components/Wordmark";
import { listShares, type ShareEntry } from "../../data/adminShares";
import { listUsersWithInfo, type UserSummary } from "../../data/adminUsers";
import { useDropdown } from "../../hooks/useDropdown";
import { useVault } from "../../state/VaultContext";
import { BooksSection, type BooksMode } from "./BooksSection";
import { ManageNavContent, type Section } from "./ManageNav";
import {
  ManageToolbar,
  errorMessage,
  type ToolbarButtonConfig,
} from "./manageShared";
import { SharesSection, type SharesMode } from "./SharesSection";
import { UsersSection, type UsersMode } from "./UsersSection";

const INITIAL_LOAD_PHASES = ["Loading users", "Loading shares"] as const;

function phaseProgress(index: number) {
  return {
    label: INITIAL_LOAD_PHASES[index]!,
    step: index + 1,
    total: INITIAL_LOAD_PHASES.length,
  };
}

type ModeSetter<T extends string> = Dispatch<SetStateAction<T>>;

function nextMode<T extends string>(current: T, next: T): T {
  return current === next ? ("none" as T) : next;
}

function userToolbarButtons(
  mode: UsersMode,
  setMode: ModeSetter<UsersMode>,
  selectedId: string | null,
  authId: string,
): ToolbarButtonConfig[] {
  return [
    {
      key: "create",
      icon: "bi-plus-lg",
      label: "Create",
      onClick: () => setMode(nextMode(mode, "create")),
    },
    {
      key: "edit",
      icon: "bi-pencil",
      label: "Edit",
      disabled: selectedId === null,
      onClick: () => setMode(nextMode(mode, "edit")),
    },
    {
      key: "delete",
      icon: "bi-trash",
      label: "Delete",
      variant: "danger",
      disabled: selectedId === null || selectedId === authId,
      onClick: () => setMode(nextMode(mode, "delete")),
    },
  ];
}

function bookToolbarButtons(
  mode: BooksMode,
  setMode: ModeSetter<BooksMode>,
  selectedId: string | null,
): ToolbarButtonConfig[] {
  return [
    {
      key: "edit",
      icon: "bi-pencil",
      label: "Edit",
      disabled: selectedId === null,
      onClick: () => setMode(nextMode(mode, "edit")),
    },
  ];
}

function shareToolbarButtons(
  mode: SharesMode,
  setMode: ModeSetter<SharesMode>,
  selectedId: string | null,
): ToolbarButtonConfig[] {
  return [
    {
      key: "create",
      icon: "bi-plus-lg",
      label: "Create",
      onClick: () => setMode(nextMode(mode, "create")),
    },
    {
      key: "delete",
      icon: "bi-trash",
      label: "Delete",
      variant: "danger",
      disabled: selectedId === null,
      onClick: () => setMode(nextMode(mode, "delete")),
    },
  ];
}

export function ManageScreen() {
  const { session, lock, refresh, refreshing, progress } = useVault();
  const [section, setSection] = useState<Section>("users");
  const [search, setSearch] = useState("");
  const nav = useDropdown();

  const [usersSelectedId, setUsersSelectedId] = useState<string | null>(null);
  const [usersMode, setUsersMode] = useState<UsersMode>("none");
  const [booksSelectedId, setBooksSelectedId] = useState<string | null>(null);
  const [booksMode, setBooksMode] = useState<BooksMode>("none");
  const [sharesSelectedId, setSharesSelectedId] = useState<string | null>(null);
  const [sharesMode, setSharesMode] = useState<SharesMode>("none");

  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [initialLoadStep, setInitialLoadStep] = useState<number | null>(0);

  const loadUsers = useCallback(async () => {
    if (!session) return;
    try {
      setUsersError(null);
      setUsers(await listUsersWithInfo(session.instantDb, session));
    } catch (err) {
      setUsersError(errorMessage(err));
    }
  }, [session]);

  const loadShares = useCallback(async () => {
    if (!session) return;
    try {
      setSharesError(null);
      setShares(await listShares(session.instantDb));
    } catch (err) {
      setSharesError(errorMessage(err));
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function loadInitial() {
      setInitialLoadStep(0);
      await loadUsers();
      if (cancelled) return;
      setInitialLoadStep(1);
      await loadShares();
      if (cancelled) return;
      setInitialLoadStep(null);
    }
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [session, loadUsers, loadShares]);

  const booksById = useMemo(
    () => session?.metadataById ?? new Map(),
    [session],
  );

  function selectSection(next: Section) {
    setSection(next);
    setSearch("");
    setUsersSelectedId(null);
    setUsersMode("none");
    setBooksSelectedId(null);
    setBooksMode("none");
    setSharesSelectedId(null);
    setSharesMode("none");
    nav.close();
  }

  async function handleRefresh() {
    nav.close();
    setRefreshError(null);
    try {
      await refresh();
      await Promise.all([loadUsers(), loadShares()]);
    } catch (err) {
      setRefreshError(errorMessage(err));
    }
  }

  if (!session) return null;

  const heading = { users: "Users", books: "Books", shares: "Shares" }[section];
  const isLoadingGate = refreshing || initialLoadStep !== null;
  const manageProgress =
    !refreshing && initialLoadStep !== null
      ? phaseProgress(initialLoadStep)
      : progress;
  const toolbarButtons: ToolbarButtonConfig[] = (() => {
    if (section === "users") {
      return userToolbarButtons(
        usersMode,
        setUsersMode,
        usersSelectedId,
        session.authId,
      );
    }
    if (section === "books") {
      return bookToolbarButtons(booksMode, setBooksMode, booksSelectedId);
    }
    if (section === "shares") {
      return shareToolbarButtons(sharesMode, setSharesMode, sharesSelectedId);
    }
    return [];
  })();

  return (
    <div className="shell-60 d-flex flex-column vh-100">
      <div className="border-bottom d-flex flex-nowrap align-items-stretch">
        <div className="library-nav border-end p-2 d-none d-lg-flex align-items-center justify-content-center position-relative">
          <InternalLink
            to="/library"
            className="position-absolute top-50 start-0 translate-middle-y ms-2 d-flex align-items-center text-decoration-none"
            aria-label="Back to Library"
            title="Back to Library"
          >
            <i
              className="bi bi-arrow-left text-body-secondary"
              aria-hidden="true"
            />
          </InternalLink>
          <Wordmark />
        </div>

        <div
          ref={nav.ref}
          className="dropdown position-relative d-lg-none d-flex align-items-center gap-2 ps-2 ps-sm-3 py-2"
        >
          <InternalLink
            to="/library"
            className="d-flex align-items-center text-decoration-none"
            aria-label="Back to Library"
            title="Back to Library"
          >
            <i
              className="bi bi-arrow-left text-body-secondary"
              aria-hidden="true"
            />
          </InternalLink>
          <DropdownToggleButton
            open={nav.open}
            onClick={nav.toggle}
            icon="bi-book"
            ariaLabel="Manage menu"
            className="d-flex align-items-center justify-content-center"
            disabled={isLoadingGate}
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
                usersCount={users?.length ?? 0}
                booksCount={booksById.size}
                sharesCount={shares?.length ?? 0}
                displayName={session.displayName ?? undefined}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={isLoadingGate}
              />
            </div>
          )}
        </div>

        <div
          className="flex-grow-1 d-flex align-items-center px-3 py-2"
          style={{ minWidth: 0 }}
        >
          <div className="position-relative manage-search-bar-width">
            <i
              className="bi bi-search position-absolute top-50 start-0 translate-middle-y ms-2 text-body-secondary pe-none"
              style={{ zIndex: 6 }}
              aria-hidden="true"
            />
            <div className="input-group">
              <input
                type="search"
                className="form-control form-control-sm themed-control"
                style={{ paddingLeft: "2rem" }}
                placeholder={`Search ${heading.toLowerCase()}`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={isLoadingGate}
                aria-label={`Search ${heading.toLowerCase()}`}
              />
              {!isLoadingGate && <ManageToolbar buttons={toolbarButtons} />}
            </div>
          </div>
        </div>
      </div>

      {refreshError && (
        <div className="alert alert-danger m-2 py-2 px-3 mb-0" role="alert">
          {refreshError}
        </div>
      )}

      <div className="flex-grow-1 d-flex flex-column flex-lg-row overflow-hidden">
        {isLoadingGate ? (
          <div
            className="flex-grow-1 d-flex flex-column align-items-center justify-content-center gap-1"
            role="status"
          >
            <ProgressStatus
              progress={manageProgress}
              fallbackLabel="Refreshing"
            />
          </div>
        ) : (
          <>
            <div className="library-nav border-end p-2 d-none d-lg-flex">
              <ManageNavContent
                section={section}
                selectSection={selectSection}
                usersCount={users?.length ?? 0}
                booksCount={booksById.size}
                sharesCount={shares?.length ?? 0}
                displayName={session.displayName ?? undefined}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={isLoadingGate}
              />
            </div>

            <div
              className="flex-grow-1 d-flex flex-column overflow-hidden"
              style={{ minWidth: 0 }}
            >
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

              <div className="flex-grow-1 d-flex flex-column overflow-hidden pt-2">
                {section === "users" && (
                  <UsersSection
                    session={session}
                    users={users ?? []}
                    search={search}
                    selectedUserId={usersSelectedId}
                    mode={usersMode}
                    onSelectRow={setUsersSelectedId}
                    onSetMode={setUsersMode}
                    onChanged={() => void loadUsers()}
                    onUserDeleted={() => void loadShares()}
                  />
                )}
                {section === "books" && (
                  <BooksSection
                    search={search}
                    selectedTxtId={booksSelectedId}
                    mode={booksMode}
                    onSelectRow={setBooksSelectedId}
                    onSetMode={setBooksMode}
                  />
                )}
                {section === "shares" && (
                  <SharesSection
                    session={session}
                    booksById={booksById}
                    users={users ?? []}
                    shares={shares ?? []}
                    search={search}
                    selectedShareId={sharesSelectedId}
                    mode={sharesMode}
                    onSelectRow={setSharesSelectedId}
                    onSetMode={setSharesMode}
                    onChanged={() => void loadShares()}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
