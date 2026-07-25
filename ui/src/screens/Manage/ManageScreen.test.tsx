// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
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
    listUsers: vi.fn(),
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

function userRow(id: number): HTMLElement {
  return screen.getByText(`User #${id}`, { exact: false }).closest("button") as HTMLElement;
}

beforeEach(() => {
  vi.mocked(adminUsers.listUsers).mockResolvedValue([1, 2]);
  vi.mocked(adminShares.listShares).mockResolvedValue([]);
});

describe("ManageScreen", () => {
  it("shows a back-to-library link and the same wordmark/search top bar as Library", async () => {
    setup();
    expect(screen.getByRole("link", { name: /library/i })).toHaveAttribute("href", "/library");
    expect(screen.getAllByText("Skypiea").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByLabelText(/search users/i)).toBeInTheDocument());
  });

  describe("account footer", () => {
    it("shows the display name as plain text, not a link, and wires Refresh/Lock", async () => {
      setup();
      expect(screen.getByText("Alice")).toBeInTheDocument();
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
      await waitFor(() => expect(userRow(1)).toBeInTheDocument());
      expect(userRow(2)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Users/ })).toHaveTextContent("2");

      await userEvent.click(userRow(1));
      expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

      await userEvent.click(userRow(2));
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
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
      await waitFor(() => expect(userRow(1)).toBeInTheDocument());
      vi.mocked(adminUsers.listUsers).mockResolvedValue([1, 2, 3]);

      await userEvent.click(screen.getByRole("button", { name: "Create" }));
      await userEvent.type(screen.getByLabelText("Username"), "carol");
      await userEvent.type(screen.getByLabelText("Password"), "hunter2");
      await userEvent.type(screen.getByLabelText("Display name"), "Carol");
      await userEvent.type(screen.getByLabelText("Regular-user Turso token"), "user-token");
      await userEvent.click(screen.getByRole("button", { name: "Create user" }));

      await waitFor(() =>
        expect(adminUsers.createUser).toHaveBeenCalledWith(
          {},
          "libsql://example",
          expect.objectContaining({ endpoint: "https://x" }),
          { username: "carol", password: "hunter2", displayName: "Carol", userTursoAuthToken: "user-token" },
        ),
      );
      await waitFor(() => expect(userRow(3)).toBeInTheDocument());
    });

    it("requires the row's own id typed in before enabling Confirm delete, then deletes", async () => {
      setup();
      await waitFor(() => expect(userRow(2)).toBeInTheDocument());
      await userEvent.click(userRow(2));
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
      await waitFor(() => expect(userRow(2)).toBeInTheDocument());
      await userEvent.click(userRow(2));
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
    it("filters the Users list by id", async () => {
      vi.mocked(adminUsers.listUsers).mockResolvedValue([1, 2, 22]);
      setup();
      await waitFor(() => expect(userRow(22)).toBeInTheDocument());

      await userEvent.type(screen.getByLabelText(/search users/i), "22");

      expect(userRow(22)).toBeInTheDocument();
      expect(screen.queryByText("User #1", { exact: false })).not.toBeInTheDocument();
    });

    it("filters the Books list by title", async () => {
      setup();
      await userEvent.click(screen.getByRole("button", { name: /^Books/ }));
      await waitFor(() => expect(screen.getByLabelText(/search books/i)).toBeInTheDocument());

      await userEvent.type(screen.getByLabelText(/search books/i), "nonexistent");

      expect(screen.queryByText("Book One")).not.toBeInTheDocument();
      expect(screen.getByText("No books match here yet.")).toBeInTheDocument();
    });
  });

  describe("virtualization", () => {
    it("renders only a bounded window of rows for a large Users list, not all of them", async () => {
      vi.mocked(adminUsers.listUsers).mockResolvedValue(Array.from({ length: 500 }, (_, i) => i + 1));
      setup();

      await waitFor(() => expect(screen.getAllByRole("button", { name: /^User #\d+/ }).length).toBeGreaterThan(0));
      const rows = screen.getAllByRole("button", { name: /^User #\d+/ });
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
      await userEvent.click(screen.getByRole("button", { name: /^Books/ }));

      const rows = screen.getAllByRole("button", { name: /^Title \d+$/ });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(100); // well under the full 500 -- proves the window is bounded
    });
  });
});
