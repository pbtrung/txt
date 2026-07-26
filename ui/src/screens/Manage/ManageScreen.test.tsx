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
    createUser: vi.fn(),
    listUsersWithInfo: vi.fn(),
    updateUserPassword: vi.fn(),
    rotateUserRootKey: vi.fn(),
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

beforeEach(() => {
  vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
    { id: 1, displayName: "Alice", bookCount: 0 },
    { id: 2, displayName: "Bob", bookCount: 0 },
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
        { id: 1, displayName: undefined, bookCount: 0 },
        { id: 2, displayName: "Bob", bookCount: 0 },
      ]);
      setup();
      await waitFor(() => expect(userRow("Alice")).toBeInTheDocument());
      expect(screen.queryByText("Unnamed user", { exact: false })).not.toBeInTheDocument();
    });

    it("creates a user via the Create panel and reloads the list", async () => {
      vi.mocked(adminUsers.createUser).mockResolvedValue({
        turso_database_url: "libsql://example",
        turso_auth_token: "user-token",
        username: "carol",
        username_lookup_key: "a",
        password: "hunter2",
        display_name: "Carol",
        user_root_key: "b",
      });
      setup();
      await waitFor(() => expect(userRow("Alice")).toBeInTheDocument());
      vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
        { id: 1, displayName: "Alice", bookCount: 0 },
        { id: 2, displayName: "Bob", bookCount: 0 },
        { id: 3, displayName: "Carol", bookCount: 0 },
      ]);

      await userEvent.click(screen.getByRole("button", { name: "Create" }));
      await userEvent.type(screen.getByLabelText("Username"), "carol");
      await userEvent.type(screen.getByLabelText("Password"), "hunter2");
      await userEvent.type(screen.getByLabelText("Display name"), "Carol");
      await userEvent.type(screen.getByLabelText("Regular-user Turso token"), "user-token");
      await userEvent.click(screen.getByRole("button", { name: "Create user" }));

      await waitFor(() =>
        expect(adminUsers.createUser).toHaveBeenCalledWith(
          {},
          undefined,
          "libsql://example",
          expect.objectContaining({ endpoint: "https://x" }),
          { username: "carol", password: "hunter2", displayName: "Carol", userTursoAuthToken: "user-token" },
        ),
      );
      await waitFor(() => expect(userRow("Carol")).toBeInTheDocument());
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
      await userEvent.type(screen.getByLabelText("Recipient user id"), "2");
      await userEvent.click(screen.getByRole("button", { name: "Grant share" }));

      await waitFor(() => expect(getTxtKey).toHaveBeenCalledWith(1));
      expect(adminShares.grantShare).toHaveBeenCalledWith({}, 1, expect.any(Uint8Array), 2);
    });

    it("revokes a selected share immediately, no confirm step", async () => {
      vi.mocked(adminShares.listShares).mockResolvedValue([{ id: 5, txtId: 1, toUserId: 2 }]);
      setup();
      await goToShares();
      await waitFor(() => expect(screen.getByText(/Book One.*user #2/)).toBeInTheDocument());

      await userEvent.click(screen.getByText(/Book One.*user #2/));
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));

      expect(adminShares.revokeShare).toHaveBeenCalledWith({}, 5);
    });
  });

  describe("search", () => {
    it("filters the Users list by display name", async () => {
      vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
        { id: 1, displayName: "Alice", bookCount: 0 },
        { id: 2, displayName: "Bob", bookCount: 0 },
        { id: 22, displayName: "Zoe", bookCount: 0 },
      ]);
      setup();
      await waitFor(() => expect(userRow("Zoe")).toBeInTheDocument());

      await userEvent.type(screen.getByLabelText(/search users/i), "zoe");

      expect(userRow("Zoe")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Alice/ })).not.toBeInTheDocument();
    });

    it("filters the Users list by id", async () => {
      vi.mocked(adminUsers.listUsersWithInfo).mockResolvedValue([
        { id: 1, displayName: "Alice", bookCount: 0 },
        { id: 2, displayName: "Bob", bookCount: 0 },
        { id: 22, displayName: "Zoe", bookCount: 0 },
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
        Array.from({ length: 500 }, (_, i) => ({ id: i + 1, displayName: `Person ${i + 1}`, bookCount: 0 })),
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
