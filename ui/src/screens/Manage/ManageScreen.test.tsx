// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BookInfo } from "../../data/metadata";
import * as VaultContextModule from "../../state/VaultContext";
import { ManageScreen } from "./ManageScreen";

vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<typeof import("../../state/VaultContext")>("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});
vi.mock("../../data/adminUsers", async () => {
  const actual = await vi.importActual<typeof import("../../data/adminUsers")>("../../data/adminUsers");
  return {
    ...actual,
    generateNewUser: vi.fn(),
    updateGeneratedNewUser: vi.fn(),
    persistNewUser: vi.fn(),
    listUsersWithInfo: vi.fn(),
    updateUserPassword: vi.fn(),
    rotateUserRootKey: vi.fn(),
    getUserCreds: vi.fn(),
    deleteUser: vi.fn(),
  };
});
vi.mock("../../data/adminShares", async () => {
  const actual = await vi.importActual<typeof import("../../data/adminShares")>("../../data/adminShares");
  return { ...actual, listShares: vi.fn(), grantShare: vi.fn(), revokeShare: vi.fn() };
});

import * as adminUsers from "../../data/adminUsers";
import * as adminShares from "../../data/adminShares";

const metadataById = new Map<number, BookInfo>([
  [1, { txtId: 1, name: "n1", title: "Book One", author: "Author One", subjects: ["A"], rawMetadata: [] }],
]);

const deleteTxt = vi.fn().mockResolvedValue(undefined);
const updateBookMetadata = vi.fn().mockResolvedValue(undefined);
const getTxtKey = vi.fn().mockResolvedValue(new Uint8Array(64).fill(3));
const lock = vi.fn();
const refresh = vi.fn().mockResolvedValue(undefined);

function setup(refreshing = false, metadataByIdOverride: Map<number, BookInfo> = metadataById) {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session: {
      creds: { tursoDatabaseUrl: "libsql://example", displayName: "Alice" },
      db: {} as never,
      userId: 1,
      r2Config: {
        endpoint: "https://x",
        region: "auto",
        bucket: "b",
        readOnlyAccessKeyId: "ro-id",
        readOnlySecretAccessKey: "ro-secret",
      },
      metadataById: metadataByIdOverride,
      isAdmin: true,
    } as unknown as VaultContextModule.VaultSession,
    error: null,
    accessMap: new Map(),
    bookmarksMap: new Map(),
    refreshing,
    progress: null,
    unlock: vi.fn(),
    lock,
    refresh,
    getTxtKey,
    recordReadPosition: vi.fn(),
    removeAccessEntry: vi.fn(),
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry: vi.fn(),
    deleteTxt,
    updateBookMetadata,
  });
  return render(
    <MemoryRouter>
      <ManageScreen />
    </MemoryRouter>,
  );
}

// UserRow is a ClickableRow (a <div role="button">, not a real <button> --
// it needs to nest its own row-level actions elsewhere, same reasoning as
// Library's BookRow), so this looks it up by its accessible name (the
// display name text) directly instead of via .closest("button").
function userRow(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

/** A fake generateNewUser() result -- every non-downloadable field is an
 * empty placeholder blob, since these tests exercise the UI flow around
 * `generated`, never adminUsers.ts's own crypto (that's owner.test.ts's job). */
function fakeGeneratedNewUser(downloadable: adminUsers.DownloadableUserCreds): adminUsers.GeneratedNewUser {
  return {
    downloadable,
    usernameHash: new Uint8Array(),
    pwSalt: new Uint8Array(),
    pwHash: new Uint8Array(),
    umkBlob: new Uint8Array(),
    pubKey: new Uint8Array(),
    privKeyBlob: new Uint8Array(),
    r2ConfigBlob: new Uint8Array(),
    txtMetadataKeyBlob: new Uint8Array(),
    txtAccessKeyBlob: new Uint8Array(),
    txtAccessEmptyBlob: new Uint8Array(),
    bookmarkKeyBlob: new Uint8Array(),
    bookmarkEmptyBlob: new Uint8Array(),
    credsBlob: new Uint8Array(),
  };
}

beforeEach(() => {
  vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
    { id: 1, displayName: "Alice" },
    { id: 2, displayName: "Bob" },
  ]);
  vi.mocked(adminShares.listShares).mockResolvedValue([]);
});

describe("ManageScreen", () => {
  it("shows a back-to-library link and the same wordmark/search top bar as Library", async () => {
    setup();
    // Two back-to-Library links exist at once (the persistent lg+ sidebar's
    // and the below-lg drawer row's) -- only one is ever visible at a given
    // viewport width, but jsdom doesn't apply that media-query hiding.
    const libraryLinks = screen.getAllByRole("link", { name: /library/i });
    expect(libraryLinks.length).toBeGreaterThan(0);
    for (const link of libraryLinks) expect(link).toHaveAttribute("href", "/library");
    expect(screen.getAllByText("Skypiea").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByLabelText(/search users/i)).toBeInTheDocument());
  });

  describe("account footer", () => {
    it("shows the display name as plain text, not a link, and wires Refresh/Lock", async () => {
      setup();
      await waitFor(() => expect(screen.getByRole("button", { name: "Lock" })).toBeInTheDocument());
      // Scoped to the account footer -- "Alice" also appears, unrelated,
      // as the admin's own row in the Users list once loaded.
      const footer = screen.getByRole("button", { name: "Lock" }).closest("div.border-top") as HTMLElement;
      expect(within(footer).getByText("Alice")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Alice" })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Lock" }));
      expect(lock).toHaveBeenCalled();

      await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(refresh).toHaveBeenCalled();
    });

    it("replaces the sidebar and content pane with a single spinner while refreshing", () => {
      setup(true);
      expect(screen.queryByText("Alice")).not.toBeInTheDocument();
      expect(screen.getByText("Refreshing…")).toBeInTheDocument();
    });
  });

  describe("Users", () => {
    it("lists every user with a count in the nav, selecting one enables Edit but not Delete for the admin's own row", async () => {
      setup();
      await waitFor(() => expect(userRow("Alice")).toBeInTheDocument());
      expect(userRow("Bob")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Users/ })).toHaveTextContent("2");

      await userEvent.click(userRow("Alice"));
      expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

      await userEvent.click(userRow("Bob"));
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });

    it("shows the admin's own session display name on their own row, not the 'Unnamed user' fallback", async () => {
      // users.creds is always NULL for the admin's own row (see
      // adminUsers.ts), so listUsersWithInfo can never recover a
      // displayName for it from decryption -- the screen has to patch in
      // session.creds.displayName itself instead of showing the fallback.
      vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
        { id: 1, displayName: undefined },
        { id: 2, displayName: "Bob" },
      ]);
      setup();
      await waitFor(() => expect(userRow("Alice")).toBeInTheDocument());
      expect(screen.queryByText("Unnamed user", { exact: false })).not.toBeInTheDocument();
    });

    it("generates credentials without touching the db, gates Create behind the saved-it checkbox, then persists", async () => {
      const generated = fakeGeneratedNewUser({
        turso_database_url: "libsql://example",
        turso_auth_token: "user-token",
        username: "carol",
        username_lookup_key: "a",
        password: "hunter2",
        display_name: "Carol",
        user_root_key: "b",
      });
      vi.mocked(adminUsers.generateNewUser).mockResolvedValue(generated);
      vi.mocked(adminUsers.persistNewUser).mockResolvedValue(undefined);
      setup();
      await waitFor(() => expect(userRow("Alice")).toBeInTheDocument());
      vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
        { id: 1, displayName: "Alice" },
        { id: 2, displayName: "Bob" },
        { id: 3, displayName: "Carol" },
      ]);

      await userEvent.click(screen.getByRole("button", { name: "Create" }));
      // Turso database URL is prefilled from the admin's own session creds
      // (see CreateUserForm) -- left as-is here. username/password are no
      // longer typed in at all; they're generated by generateNewUser itself.
      await userEvent.type(screen.getByLabelText("Display name"), "Carol");
      await userEvent.type(screen.getByLabelText("Regular-user Turso token"), "user-token");
      await userEvent.click(screen.getByRole("button", { name: "Generate credentials" }));

      // generateNewUser is pure computation -- no db argument at all here
      // (session.db never appears), unlike persistNewUser below.
      await waitFor(() =>
        expect(adminUsers.generateNewUser).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ endpoint: "https://x" }),
          { tursoDatabaseUrl: "libsql://example", displayName: "Carol", userTursoAuthToken: "user-token" },
        ),
      );
      expect(adminUsers.persistNewUser).not.toHaveBeenCalled();

      // The modal now shows the generated credential JSON -- nothing's
      // written yet, so Create stays disabled until the admin confirms
      // they've saved it.
      await waitFor(() => expect(screen.getByText(/"username": "carol"/)).toBeInTheDocument());
      const createButton = screen.getByRole("button", { name: "Create user" });
      expect(createButton).toBeDisabled();

      await userEvent.click(screen.getByLabelText("I've saved this configuration (downloaded or copied)"));
      expect(createButton).toBeEnabled();

      await userEvent.click(createButton);
      await waitFor(() => expect(adminUsers.persistNewUser).toHaveBeenCalledWith({}, generated, expect.any(Function)));

      await waitFor(() => expect(userRow("Carol")).toBeInTheDocument());
    });

    it("copies the generated credentials JSON to the clipboard and shows a small confirmation alert", async () => {
      const generated = fakeGeneratedNewUser({
        turso_database_url: "libsql://example",
        turso_auth_token: "user-token",
        username: "carol",
        username_lookup_key: "a",
        password: "hunter2",
        display_name: "Carol",
        user_root_key: "b",
      });
      vi.mocked(adminUsers.generateNewUser).mockResolvedValue(generated);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      setup();
      await waitFor(() => expect(userRow("Alice")).toBeInTheDocument());

      await userEvent.click(screen.getByRole("button", { name: "Create" }));
      await userEvent.type(screen.getByLabelText("Display name"), "Carol");
      await userEvent.type(screen.getByLabelText("Regular-user Turso token"), "user-token");
      await userEvent.click(screen.getByRole("button", { name: "Generate credentials" }));
      await waitFor(() => expect(screen.getByText(/"username": "carol"/)).toBeInTheDocument());

      expect(screen.queryByText("Copied to clipboard!")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(generated.downloadable, null, 2));
      expect(screen.getByText("Copied to clipboard!")).toBeInTheDocument();
    });

    it("edits the generated credentials before creating -- no db write, and re-requires the saved-it confirmation", async () => {
      const generated = fakeGeneratedNewUser({
        turso_database_url: "libsql://example",
        turso_auth_token: "user-token",
        username: "carol",
        username_lookup_key: "a",
        password: "hunter2",
        display_name: "Carol",
        user_root_key: "b",
      });
      const updated = fakeGeneratedNewUser({ ...generated.downloadable, display_name: "Carolyn" });
      vi.mocked(adminUsers.generateNewUser).mockResolvedValue(generated);
      vi.mocked(adminUsers.updateGeneratedNewUser).mockResolvedValue(updated);
      // This file's adminUsers mocks aren't cleared between tests, so an
      // earlier test's own persistNewUser call would otherwise still be
      // sitting in its call history here -- clear it so the "not called"
      // assertion below only reflects this test's own actions.
      vi.mocked(adminUsers.persistNewUser).mockClear();
      setup();
      await waitFor(() => expect(userRow("Alice")).toBeInTheDocument());

      await userEvent.click(screen.getByRole("button", { name: "Create" }));
      await userEvent.type(screen.getByLabelText("Display name"), "Carol");
      await userEvent.type(screen.getByLabelText("Regular-user Turso token"), "user-token");
      await userEvent.click(screen.getByRole("button", { name: "Generate credentials" }));
      await waitFor(() => expect(screen.getByText(/"username": "carol"/)).toBeInTheDocument());

      // Confirm the box, then edit -- editing should undo that confirmation
      // (see below), since it no longer describes the *new* JSON. Scoped to
      // the modal dialog itself, since the Users toolbar behind it has its
      // own (disabled) "Edit" button with the same accessible name.
      await userEvent.click(screen.getByLabelText("I've saved this configuration (downloaded or copied)"));
      const dialog = screen.getByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Edit" }));

      const displayNameField = screen.getByLabelText("Display name");
      await userEvent.clear(displayNameField);
      await userEvent.type(displayNameField, "Carolyn");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(adminUsers.updateGeneratedNewUser).toHaveBeenCalledWith(undefined, generated, {
          tursoDatabaseUrl: "libsql://example",
          displayName: "Carolyn",
          userTursoAuthToken: "user-token",
        }),
      );
      // updateGeneratedNewUser is pure computation too -- persistNewUser is
      // still the only thing that would ever touch the db, and it hasn't.
      expect(adminUsers.persistNewUser).not.toHaveBeenCalled();

      await waitFor(() => expect(screen.getByText(/"display_name": "Carolyn"/)).toBeInTheDocument());
      const createButton = screen.getByRole("button", { name: "Create user" });
      expect(createButton).toBeDisabled();
    });

    it("requires the row's own id typed in before enabling Confirm delete, then deletes", async () => {
      setup();
      await waitFor(() => expect(userRow("Bob")).toBeInTheDocument());
      await userEvent.click(userRow("Bob"));
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));

      const confirmButton = screen.getByRole("button", { name: "Confirm delete" });
      expect(confirmButton).toBeDisabled();
      await userEvent.type(screen.getByRole("textbox"), "2");
      expect(confirmButton).toBeEnabled();

      await userEvent.click(confirmButton);
      expect(adminUsers.deleteUser).toHaveBeenCalledWith({}, 1, 2);
    });

    it("resets a password and rotates a root key from the Edit panel", async () => {
      vi.mocked(adminUsers.rotateUserRootKey).mockResolvedValue("new-root-key-b64");
      setup();
      await waitFor(() => expect(userRow("Bob")).toBeInTheDocument());
      await userEvent.click(userRow("Bob"));
      await userEvent.click(screen.getByRole("button", { name: "Edit" }));

      await userEvent.type(screen.getByLabelText("New password"), "new-password");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(adminUsers.updateUserPassword).toHaveBeenCalledWith({}, 2, "new-password");

      await userEvent.type(screen.getByLabelText(/current root key/i), "old-key-b64");
      await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
      expect(adminUsers.rotateUserRootKey).toHaveBeenCalledWith({}, 2, "old-key-b64");
      await waitFor(() => expect(screen.getByText("new-root-key-b64")).toBeInTheDocument());
    });

    it("shows the resolved display name in the Edit panel's title and reveals that account's stored creds", async () => {
      const storedCreds: adminUsers.DownloadableUserCreds = {
        turso_database_url: "libsql://example",
        turso_auth_token: "user-token",
        username: "bob",
        username_lookup_key: "a",
        password: "hunter2",
        display_name: "Bob",
        user_root_key: "b",
      };
      vi.mocked(adminUsers.getUserCreds).mockResolvedValue(storedCreds);
      setup();
      await waitFor(() => expect(userRow("Bob")).toBeInTheDocument());
      await userEvent.click(userRow("Bob"));
      await userEvent.click(screen.getByRole("button", { name: "Edit" }));

      expect(screen.getByRole("dialog", { name: "Edit Bob (#2)" })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Show creds" }));
      await waitFor(() => expect(adminUsers.getUserCreds).toHaveBeenCalledWith({}, undefined, 2));
      await waitFor(() =>
        expect(screen.getByLabelText("This account's stored credential JSON")).toHaveValue(
          JSON.stringify(storedCreds, null, 2),
        ),
      );
    });

    it("doesn't offer Show creds when editing the admin's own row", async () => {
      setup();
      await waitFor(() => expect(userRow("Alice")).toBeInTheDocument());
      await userEvent.click(userRow("Alice"));
      await userEvent.click(screen.getByRole("button", { name: "Edit" }));

      expect(screen.getByRole("dialog", { name: "Edit Alice (#1)" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show creds" })).not.toBeInTheDocument();
    });
  });

  describe("Books", () => {
    async function goToBooks() {
      await waitFor(() => expect(screen.getByRole("button", { name: /^Books/ })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: /^Books/ }));
    }

    it("lists the admin's own books and requires a selection before Edit/Delete enable", async () => {
      setup();
      await goToBooks();
      expect(screen.getByText("Book One")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();

      await userEvent.click(screen.getByText("Book One"));
      expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });

    it("edits curated metadata fields via the Edit panel", async () => {
      setup();
      await goToBooks();
      await userEvent.click(screen.getByText("Book One"));
      await userEvent.click(screen.getByRole("button", { name: "Edit" }));

      const titleInput = screen.getByLabelText("Title");
      await userEvent.clear(titleInput);
      await userEvent.type(titleInput, "New Title");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(updateBookMetadata).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ title: "New Title", author: "Author One", subjects: ["A"] }),
          expect.any(Function),
        ),
      );
    });

    it("deletes a book after typing its id to confirm", async () => {
      setup();
      await goToBooks();
      await userEvent.click(screen.getByText("Book One"));
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));

      const confirmButton = screen.getByRole("button", { name: "Confirm delete" });
      expect(confirmButton).toBeDisabled();
      await userEvent.type(screen.getByRole("textbox"), "1");
      expect(confirmButton).toBeEnabled();
      await userEvent.click(confirmButton);

      expect(deleteTxt).toHaveBeenCalledWith(1);
    });
  });

  describe("Shares", () => {
    async function goToShares() {
      await waitFor(() => expect(screen.getByRole("button", { name: /^Shares/ })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: /^Shares/ }));
    }

    it("grants a share of one of the admin's own txt to a recipient", async () => {
      setup();
      await goToShares();
      await userEvent.click(screen.getByRole("button", { name: "Create" }));
      await userEvent.selectOptions(screen.getByLabelText("Txt"), "1");
      // Recipient is a dropdown of the same cached Users list the Users
      // section already loaded (Bob's display name), not a free-typed id.
      await userEvent.selectOptions(screen.getByLabelText("Recipient"), "2");
      await userEvent.click(screen.getByRole("button", { name: "Grant share" }));

      await waitFor(() => expect(getTxtKey).toHaveBeenCalledWith(1));
      expect(adminShares.grantShare).toHaveBeenCalledWith({}, 1, expect.any(Uint8Array), 2);
    });

    it("doesn't list the admin's own account as a possible recipient", async () => {
      setup();
      await goToShares();
      await userEvent.click(screen.getByRole("button", { name: "Create" }));

      // session.userId is 1 (Alice) -- only Bob (id 2) should be selectable.
      const recipientSelect = screen.getByLabelText("Recipient") as HTMLSelectElement;
      const optionLabels = Array.from(recipientSelect.options).map((o) => o.textContent);
      expect(optionLabels.some((label) => label?.includes("Alice"))).toBe(false);
      expect(optionLabels.some((label) => label?.includes("Bob"))).toBe(true);
    });

    it("requires an explicit confirmation before revoking a selected share", async () => {
      vi.mocked(adminShares.listShares).mockResolvedValue([{ id: 5, txtId: 1, toUserId: 2 }]);
      setup();
      await goToShares();
      // ShareRow renders the title and recipient as two separate lines --
      // see ShareRow.tsx -- rather than one line joined by an arrow.
      await waitFor(() => expect(screen.getByText("Book One")).toBeInTheDocument());
      // Recipient shows the resolved display name (Bob, from the shared
      // Users cache -- see beforeEach's listUsersWithInfo mock), not just
      // the bare numeric id.
      expect(screen.getByText("Shared with Bob (#2)")).toBeInTheDocument();

      await userEvent.click(screen.getByText("Book One"));
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));

      // Clicking Delete opens a confirmation modal instead of revoking
      // right away.
      expect(adminShares.revokeShare).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("dialog", { name: "Revoke share" });
      expect(within(dialog).getByText(/Book One/)).toBeInTheDocument();

      await userEvent.click(within(dialog).getByRole("button", { name: "Revoke share" }));
      expect(adminShares.revokeShare).toHaveBeenCalledWith({}, 5);
    });

    it("cancelling the revoke confirmation leaves the share untouched", async () => {
      vi.mocked(adminShares.listShares).mockResolvedValue([{ id: 5, txtId: 1, toUserId: 2 }]);
      // This file's adminShares mocks aren't cleared between tests -- an
      // earlier test's own successful revokeShare call would otherwise
      // still be sitting in its call history here.
      vi.mocked(adminShares.revokeShare).mockClear();
      setup();
      await goToShares();
      await waitFor(() => expect(screen.getByText("Book One")).toBeInTheDocument());

      await userEvent.click(screen.getByText("Book One"));
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));

      const dialog = await screen.findByRole("dialog", { name: "Revoke share" });
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("dialog", { name: "Revoke share" })).not.toBeInTheDocument();
      expect(adminShares.revokeShare).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("filters the Users list by display name", async () => {
      vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
        { id: 1, displayName: "Alice" },
        { id: 2, displayName: "Bob" },
        { id: 22, displayName: "Zoe" },
      ]);
      setup();
      await waitFor(() => expect(userRow("Zoe")).toBeInTheDocument());

      await userEvent.type(screen.getByLabelText(/search users/i), "zoe");

      expect(userRow("Zoe")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Alice/ })).not.toBeInTheDocument();
    });

    it("filters the Users list by id", async () => {
      vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
        { id: 1, displayName: "Alice" },
        { id: 2, displayName: "Bob" },
        { id: 22, displayName: "Zoe" },
      ]);
      setup();
      await waitFor(() => expect(userRow("Zoe")).toBeInTheDocument());

      await userEvent.type(screen.getByLabelText(/search users/i), "22");

      expect(userRow("Zoe")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Alice/ })).not.toBeInTheDocument();
    });

    it("filters the Books list by title", async () => {
      setup();
      await waitFor(() => expect(screen.getByRole("button", { name: /^Books/ })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: /^Books/ }));
      await waitFor(() => expect(screen.getByLabelText(/search books/i)).toBeInTheDocument());

      await userEvent.type(screen.getByLabelText(/search books/i), "nonexistent");

      expect(screen.queryByText("Book One")).not.toBeInTheDocument();
      expect(screen.getByText("No books match here yet.")).toBeInTheDocument();
    });
  });

  describe("virtualization", () => {
    it("renders only a bounded window of rows for a large Users list, not all of them", async () => {
      vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue(
        Array.from({ length: 500 }, (_, i) => ({ id: i + 1, displayName: `Person ${i + 1}` })),
      );
      setup();

      await waitFor(() => expect(screen.getAllByRole("button", { name: /^Person \d+/ }).length).toBeGreaterThan(0));
      const rows = screen.getAllByRole("button", { name: /^Person \d+/ });
      expect(rows.length).toBeLessThan(100); // well under the full 500 -- proves the window is bounded
    });

    it("renders only a bounded window of rows for a large Books list, not all of them", async () => {
      const manyBooks = new Map<number, BookInfo>(
        Array.from({ length: 500 }, (_, i) => [
          i + 1,
          { txtId: i + 1, name: `n${i + 1}`, title: `Title ${i + 1}`, subjects: [], rawMetadata: [] },
        ]),
      );
      setup(false, manyBooks);
      await waitFor(() => expect(screen.getByRole("button", { name: /^Books/ })).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: /^Books/ }));

      const rows = screen.getAllByRole("button", { name: /^Title \d+$/ });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(100); // well under the full 500 -- proves the window is bounded
    });
  });
});
