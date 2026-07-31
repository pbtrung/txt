// Admin-only Manage screen (docs/ui.md) -- reachable by clicking the
// account name in Library's nav footer, gated by RequireAdmin (session.isAdmin,
// see crypto/jwt.ts). Mirrors Library's own two-pane shell exactly (same top
// bar: wordmark + search field; same lg+ persistent sidebar / below-lg
// dropdown split; same account footer at the bottom of the nav, display_name
// just never a link here since this screen already *is* where that link
// would go) rather than inventing a different layout for one more screen.
// The search field filters whichever section is currently selected, not a
// fixed list the way Library's does. Unlike Library, the top bar also
// carries a small back-arrow (always a link to /library, distinct from the
// plain wordmark beside it) -- at lg+ centered over the sidebar's own box,
// below lg beside the drawer toggle -- so going back to Library is always
// one tap away.
//
// Three sections (UsersSection.tsx/BooksSection.tsx/SharesSection.tsx),
// each a select-a-row-then-act toolbar (Create/Edit/Delete, only the
// actions that actually apply, computed below in toolbarButtons and
// rendered as one Bootstrap .input-group merged with the search box, not
// a separate row inside each section's own content) -- see manageShared.tsx
// for the Modal-opening forms' shared pieces (FormField/ConfirmDeleteField/
// etc.) every section reuses instead of inventing its own:
// - Users: create/list/edit (password reset + root-key rotation, both in
//   one panel)/delete. Delete is hidden for the admin's own row -- an admin
//   can never delete themselves through this screen.
// - Books: the admin's own txt only (see the plan this was built from --
//   only the admin ever holds any). No Create -- that stays a
//   --txt-ingest-only operation.
// - Shares: existing grants on the admin's own txt. Delete revokes the
//   selected one immediately, no confirm step (unlike Users/Books delete).
//
// Every section's own row-selection + open-panel state is lifted up into
// this shell (rather than kept local to each section) since the toolbar
// acting on it now lives in the top bar, a sibling of the section content
// rather than a descendant of it.

import { useCallback, useEffect, useMemo, useState } from "react";

import { DropdownToggleButton } from "../../components/DropdownToggleButton";
import { InternalLink } from "../../components/InternalLink";
import { Wordmark } from "../../components/Wordmark";
import { useDropdown } from "../../hooks/useDropdown";
import { listUsersWithInfo, type UserSummary } from "../../data/adminUsers";
import { listShares, type ShareEntry } from "../../data/adminShares";
import { useVault } from "../../state/VaultContext";
import { BooksSection, type BooksMode } from "./BooksSection";
import { ManageNavContent, type Section } from "./ManageNav";
import { ManageToolbar, errorMessage, type ToolbarButtonConfig } from "./manageShared";
import { SharesSection, type SharesMode } from "./SharesSection";
import { UsersSection, type UsersMode } from "./UsersSection";

// Shown as the initial-load gate's step labels (see initialLoadStep
// below) -- same "Step N of M" + phase-label shape VaultContext's own
// UNLOCK_PHASES/REFRESH_PHASES drive on Unlock/Library, kept local here
// since Users/Shares are Manage-specific data, not part of the vault
// session those funnel through.
const INITIAL_LOAD_PHASES = ["Loading users", "Loading shares"] as const;

export function ManageScreen() {
  const { session, lock, refresh, refreshing } = useVault();
  const [section, setSection] = useState<Section>("users");
  const [search, setSearch] = useState("");
  const nav = useDropdown();

  // Every section's own selection + which panel (if any) is open -- lifted
  // up from each Section component rather than kept local to it, since the
  // toolbar acting on that selection now renders in the top bar (beside the
  // search box), a sibling of the section content, not a descendant of it.
  const [usersSelectedId, setUsersSelectedId] = useState<number | null>(null);
  const [usersMode, setUsersMode] = useState<UsersMode>("none");
  const [booksSelectedId, setBooksSelectedId] = useState<number | null>(null);
  const [booksMode, setBooksMode] = useState<BooksMode>("none");
  const [sharesSelectedId, setSharesSelectedId] = useState<number | null>(null);
  const [sharesMode, setSharesMode] = useState<SharesMode>("none");

  function selectSection(next: Section) {
    setSection(next);
    setSearch("");
    // A selection from one section shouldn't linger (mismatched against the
    // toolbar) after switching to another.
    setUsersSelectedId(null);
    setUsersMode("none");
    setBooksSelectedId(null);
    setBooksMode("none");
    setSharesSelectedId(null);
    setSharesMode("none");
    nav.close();
  }

  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const loadUsers = useCallback(async () => {
    if (!session) return;
    try {
      setUsers(await listUsersWithInfo(session.db, session.umk));
    } catch (err) {
      setUsersError(errorMessage(err));
    }
  }, [session]);

  const books = useMemo(() => (session ? Array.from(session.metadataById.values()) : []), [session]);

  // users.creds can never hold the admin's own display name (it's always
  // NULL for that row -- see adminUsers.ts), but the admin's session already
  // carries it (same value the nav footer shows), so patch it in here --
  // once, shared by both Users (its own list) and Shares (the recipient
  // dropdown/ShareRow's "Shared with" line) -- rather than showing the
  // "Unnamed user" fallback for the one row that could actually be named.
  const usersWithSelfName = useMemo(
    () =>
      (users ?? []).map((u) =>
        session && u.id === session.userId ? { ...u, displayName: session.creds.displayName } : u,
      ),
    [users, session],
  );

  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const loadShares = useCallback(async () => {
    if (!session) return;
    try {
      setShares(await listShares(session.db));
    } catch (err) {
      setSharesError(errorMessage(err));
    }
  }, [session]);

  // The first load (only -- Create/Edit/Delete's own onChanged and
  // handleRefresh below reload a single list directly, without this gate)
  // walks Users then Shares one at a time, showing a step counter for
  // each -- the same "Step N of M" + phase-label shape Unlock/Library's
  // own refresh spinner use -- instead of the shell appearing immediately
  // with both lists empty for the brief moment before they resolve.
  const [initialLoadStep, setInitialLoadStep] = useState<number | null>(0);
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
    // Keyed on `session` alone -- this should only re-run for a genuinely
    // new session (a fresh unlock), not every time loadUsers/loadShares
    // themselves are recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Refreshing re-loads the vault's own data (session.metadataById, via
  // VaultContext's refresh()) *and* this screen's own Users/Shares lists --
  // Library's Refresh only needs the former, but here all three can drift
  // out of date the same way.
  async function handleRefresh() {
    nav.close();
    await refresh();
    await Promise.all([loadUsers(), loadShares()]);
  }

  const heading = { users: "Users", books: "Books", shares: "Shares" }[section];

  // Either a refresh is in flight, or this is the very first load -- both
  // replace the sidebar+content region with a spinner instead of showing
  // it prematurely (empty lists, a toolbar with nothing to act on).
  const isLoadingGate = refreshing || initialLoadStep !== null;

  // Which Create/Edit/Delete buttons apply to the current section, given
  // its current selection -- rendered as one button group beside the
  // search box, not as a separate row inside the section's own content.
  const toolbarButtons: ToolbarButtonConfig[] = useMemo(() => {
    if (!session) return [];
    if (section === "users") {
      const buttons: ToolbarButtonConfig[] = [
        {
          key: "create",
          icon: "bi-plus-lg",
          label: "Create",
          onClick: () => setUsersMode(usersMode === "create" ? "none" : "create"),
        },
        {
          key: "edit",
          icon: "bi-pencil",
          label: "Edit",
          disabled: usersSelectedId === null,
          onClick: () => setUsersMode(usersMode === "edit" ? "none" : "edit"),
        },
      ];
      if (usersSelectedId !== null && usersSelectedId !== session.userId) {
        buttons.push({
          key: "delete",
          icon: "bi-trash",
          label: "Delete",
          variant: "danger",
          onClick: () => setUsersMode(usersMode === "delete" ? "none" : "delete"),
        });
      }
      return buttons;
    }
    if (section === "books") {
      return [
        {
          key: "edit",
          icon: "bi-pencil",
          label: "Edit",
          disabled: booksSelectedId === null,
          onClick: () => setBooksMode(booksMode === "edit" ? "none" : "edit"),
        },
        {
          key: "delete",
          icon: "bi-trash",
          label: "Delete",
          variant: "danger",
          disabled: booksSelectedId === null,
          onClick: () => setBooksMode(booksMode === "delete" ? "none" : "delete"),
        },
      ];
    }
    return [
      {
        key: "create",
        icon: "bi-plus-lg",
        label: "Create",
        onClick: () => setSharesMode(sharesMode === "create" ? "none" : "create"),
      },
      {
        key: "delete",
        icon: "bi-trash",
        label: "Delete",
        variant: "danger",
        disabled: sharesSelectedId === null,
        onClick: () => setSharesMode(sharesMode === "delete" ? "none" : "delete"),
      },
    ];
  }, [session, section, usersSelectedId, usersMode, booksSelectedId, booksMode, sharesSelectedId, sharesMode]);

  if (!session) return null;

  return (
    <div className="shell-60 d-flex flex-column vh-100">
      <div className="border-bottom d-flex flex-nowrap align-items-stretch">
        {/* Just the arrow is the back-to-Library link here (Manage is the
            one screen that isn't Library) -- the wordmark itself stays
            plain/centered, same as Library's own top bar, instead of a
            separate "<- Library" nav row above Users/Books/Shares. Below lg
            (no persistent sidebar to hold the arrow), it sits beside the
            drawer toggle instead, so going back to Library is always one
            tap away regardless of screen size. */}
        <div className="library-nav border-end p-2 d-none d-lg-flex align-items-center justify-content-center position-relative">
          <InternalLink
            to="/library"
            className="position-absolute top-50 start-0 translate-middle-y ms-2 d-flex align-items-center text-decoration-none"
            aria-label="Back to Library"
            title="Back to Library"
          >
            <i className="bi bi-arrow-left text-body-secondary" aria-hidden="true" />
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
            <i className="bi bi-arrow-left text-body-secondary" aria-hidden="true" />
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
                booksCount={books.length}
                sharesCount={shares?.length ?? 0}
                displayName={session.creds.displayName}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={isLoadingGate}
              />
            </div>
          )}
        </div>

        <div className="flex-grow-1 d-flex align-items-center px-3 py-2" style={{ minWidth: 0 }}>
          {/* One Bootstrap .input-group -- search box and action buttons as
              flush children -- so they read as one control (same height,
              adjoining borders) instead of two separate ones sitting next
              to each other. The search icon itself stays an overlay inside
              the input's own padding (exactly Library's search box), not a
              separate .input-group-text box -- it's a sibling of
              .input-group, not one of its children, specifically so it
              can't affect that group's own first-/last-child border-radius
              rules: with the icon rendered as a *child* of .input-group,
              the input would lose its right corner's rounding whenever the
              toolbar (its only sibling giving it a rounded right edge)
              hides during a loading gate, since the icon would then become
              the new last child instead. position-relative moves to this
              outer wrapper so the icon can still overlay the input's left
              padding regardless. z-index 6 keeps it above the input, whose
              own :focus state jumps to z-index 5 via input-group's own CSS
              (bootstrap.css's `.input-group > .form-control:focus`), the
              one time it'd otherwise cover the icon. */}
          <div className="search-bar-width position-relative">
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
            <i
              className="bi bi-search position-absolute top-50 start-0 translate-middle-y ms-2 text-body-secondary pe-none"
              style={{ zIndex: 6 }}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      <div className="flex-grow-1 d-flex flex-column flex-lg-row overflow-hidden">
        {isLoadingGate ? (
          <div className="flex-grow-1 d-flex flex-column align-items-center justify-content-center gap-1" role="status">
            <div className="spinner-border text-primary mb-1" aria-hidden="true" />
            {/* An explicit refresh (handleRefresh) takes priority in the
                label over the initial-load step count -- the two are
                mutually exclusive in real usage (Refresh isn't clickable
                until the initial load has already finished), but checking
                refreshing first keeps that assumption from mattering. */}
            <div className="small text-body-secondary">
              {!refreshing && initialLoadStep !== null
                ? `Step ${initialLoadStep + 1} of ${INITIAL_LOAD_PHASES.length}`
                : " "}
            </div>
            <div className="small text-body-secondary">
              {!refreshing && initialLoadStep !== null ? INITIAL_LOAD_PHASES[initialLoadStep] : "Refreshing"}…
            </div>
          </div>
        ) : (
          <>
            <div className="library-nav border-end p-2 d-none d-lg-flex">
              <ManageNavContent
                section={section}
                selectSection={selectSection}
                usersCount={users?.length ?? 0}
                booksCount={books.length}
                sharesCount={shares?.length ?? 0}
                displayName={session.creds.displayName}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={isLoadingGate}
              />
            </div>

            {/* pt-2 matches the sidebar's own p-2 top spacing, so the list
                starts the same distance below the border-bottom line the
                nav's own first item does -- there's no section heading
                here anymore to provide that breathing room on its own. */}
            <div className="flex-grow-1 d-flex flex-column overflow-hidden pt-2" style={{ minWidth: 0 }}>
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
                  users={usersWithSelfName}
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
                  books={books}
                  users={usersWithSelfName}
                  shares={shares ?? []}
                  search={search}
                  selectedShareId={sharesSelectedId}
                  onSelectRow={setSharesSelectedId}
                  mode={sharesMode}
                  onSetMode={setSharesMode}
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
