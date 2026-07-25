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
import { Link } from "react-router-dom";

import { DropdownToggleButton } from "../../components/DropdownToggleButton";
import { Wordmark } from "../../components/Wordmark";
import { useDropdown } from "../../hooks/useDropdown";
import { listUsersWithInfo, type UserSummary } from "../../data/adminUsers";
import { listShares, revokeShare, type ShareEntry } from "../../data/adminShares";
import { useVault } from "../../state/VaultContext";
import { BooksSection, type BooksMode } from "./BooksSection";
import { ManageNavContent, type Section } from "./ManageNav";
import { ManageToolbar, errorMessage, type ToolbarButtonConfig } from "./manageShared";
import { SharesSection, type SharesMode } from "./SharesSection";
import { UsersSection, type UsersMode } from "./UsersSection";

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
  const [sharesActionError, setSharesActionError] = useState<string | null>(null);

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
    setSharesActionError(null);
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

  // Revoking a share needs no confirm step (unlike Users/Books' Delete) --
  // it fires directly from the toolbar button instead of opening a panel.
  async function handleRevokeShare() {
    if (!session || sharesSelectedId === null) return;
    setSharesActionError(null);
    try {
      await revokeShare(session.db, sharesSelectedId);
      setSharesSelectedId(null);
      void loadShares();
    } catch (err) {
      setSharesActionError(errorMessage(err));
    }
  }

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
        onClick: () => void handleRevokeShare(),
      },
    ];
  }, [
    session,
    section,
    usersSelectedId,
    usersMode,
    booksSelectedId,
    booksMode,
    sharesSelectedId,
    sharesMode,
    handleRevokeShare,
  ]);

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
          <Link
            to="/library"
            className="position-absolute top-50 start-0 translate-middle-y ms-2 d-flex align-items-center text-decoration-none"
            aria-label="Back to Library"
            title="Back to Library"
          >
            <i className="bi bi-arrow-left text-body-secondary" aria-hidden="true" />
          </Link>
          <Wordmark />
        </div>

        <div
          ref={nav.ref}
          className="dropdown position-relative d-lg-none d-flex align-items-center gap-2 ps-2 ps-sm-3 py-2"
        >
          <Link
            to="/library"
            className="d-flex align-items-center text-decoration-none"
            aria-label="Back to Library"
            title="Back to Library"
          >
            <i className="bi bi-arrow-left text-body-secondary" aria-hidden="true" />
          </Link>
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
                usersCount={users?.length ?? 0}
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
          {/* One Bootstrap .input-group -- search box and action buttons as
              flush children -- so they read as one control (same height,
              adjoining borders) instead of two separate ones sitting next
              to each other. The search icon itself stays an overlay inside
              the input's own padding (exactly Library's search box), not a
              separate .input-group-text box -- position-relative here (not
              on the input-group's own children, which need to stay flush
              for its border-merging CSS to apply) anchors it. The icon has
              to come *after* the input in the DOM, not before: input-group's
              own CSS strips left-side border-radius from every child
              that's ':not(:first-child)', so with the icon first the input
              itself would count as the second child and lose its rounded
              left corner; position:absolute on the icon lets it still
              paint on the left visually regardless of DOM order. z-index 6
              keeps it above the input, whose own :focus state jumps to
              z-index 5 via input-group's own CSS (bootstrap.css's
              `.input-group > .form-control:focus`), the one time it'd
              otherwise cover the icon. */}
          <div className="input-group search-bar-width position-relative">
            <input
              type="search"
              className="form-control themed-control ps-5"
              placeholder={`Search ${heading.toLowerCase()}`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={refreshing}
              aria-label={`Search ${heading.toLowerCase()}`}
            />
            <i
              className="bi bi-search position-absolute top-50 start-0 translate-middle-y ms-3 text-body-secondary pe-none"
              style={{ zIndex: 6 }}
              aria-hidden="true"
            />
            {!refreshing && <ManageToolbar buttons={toolbarButtons} />}
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
                usersCount={users?.length ?? 0}
                booksCount={books.length}
                sharesCount={shares?.length ?? 0}
                displayName={session.creds.displayName}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={refreshing}
              />
            </div>

            <div className="flex-grow-1 d-flex flex-column overflow-hidden" style={{ minWidth: 0 }}>
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
              {sharesActionError && section === "shares" && (
                <div className="alert alert-danger m-2 py-2 px-3" role="alert">
                  {sharesActionError}
                </div>
              )}

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
