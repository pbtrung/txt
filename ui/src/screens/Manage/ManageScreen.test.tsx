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
  [1, { txtId: 1, name: "n1", title: "Book One", subjects: [], rawMetadata: [] }],
]);

const deleteTxt = vi.fn().mockResolvedValue(undefined);
const getTxtKey = vi.fn().mockResolvedValue(new Uint8Array(64).fill(3));

function setup() {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session: {
      creds: { tursoDatabaseUrl: "libsql://example" },
      db: {} as never,
      userId: 1,
      r2Config: {
        endpoint: "https://x",
        region: "auto",
        bucket: "b",
        readOnlyAccessKeyId: "ro-id",
        readOnlySecretAccessKey: "ro-secret",
      },
      metadataById,
      isAdmin: true,
    } as unknown as VaultContextModule.VaultSession,
    error: null,
    accessMap: new Map(),
    bookmarksMap: new Map(),
    refreshing: false,
    progress: null,
    unlock: vi.fn(),
    lock: vi.fn(),
    refresh: vi.fn(),
    getTxtKey,
    recordReadPosition: vi.fn(),
    removeAccessEntry: vi.fn(),
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry: vi.fn(),
    deleteTxt,
  });
  return render(
    <MemoryRouter>
      <ManageScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(adminUsers.listUsers).mockResolvedValue([1, 2]);
  vi.mocked(adminShares.listShares).mockResolvedValue([]);
});

describe("ManageScreen", () => {
  describe("Users", () => {
    it("lists every user and hides Delete on the admin's own row", async () => {
      setup();
      await waitFor(() => expect(screen.getByText("User #1")).toBeInTheDocument());
      expect(screen.getByText("User #2")).toBeInTheDocument();

      const ownRow = screen.getByText("User #1").closest("li") as HTMLElement;
      expect(within(ownRow).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

      const otherRow = screen.getByText("User #2").closest("li") as HTMLElement;
      expect(within(otherRow).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });

    it("creates a user via the form and reloads the list", async () => {
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
      await waitFor(() => expect(screen.getByText("User #1")).toBeInTheDocument());
      vi.mocked(adminUsers.listUsers).mockResolvedValue([1, 2, 3]);

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
      await waitFor(() => expect(screen.getByText("User #3")).toBeInTheDocument());
    });

    it("requires the row's own id typed in before enabling Confirm delete, then deletes", async () => {
      setup();
      await waitFor(() => expect(screen.getByText("User #2")).toBeInTheDocument());
      const row = screen.getByText("User #2").closest("li") as HTMLElement;

      await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
      const confirmButton = within(row).getByRole("button", { name: "Confirm delete" });
      expect(confirmButton).toBeDisabled();

      await userEvent.type(within(row).getByRole("textbox"), "2");
      expect(confirmButton).toBeEnabled();

      await userEvent.click(confirmButton);
      expect(adminUsers.deleteUser).toHaveBeenCalledWith({}, 1, 2);
    });

    it("rotates a user's root key and shows the new value", async () => {
      vi.mocked(adminUsers.rotateUserRootKey).mockResolvedValue("new-root-key-b64");
      setup();
      await waitFor(() => expect(screen.getByText("User #2")).toBeInTheDocument());
      const row = screen.getByText("User #2").closest("li") as HTMLElement;

      await userEvent.click(within(row).getByRole("button", { name: "Rotate root key" }));
      await userEvent.type(within(row).getByPlaceholderText(/current root key/i), "old-key-b64");
      await userEvent.click(within(row).getByRole("button", { name: "Rotate" }));

      expect(adminUsers.rotateUserRootKey).toHaveBeenCalledWith({}, 2, "old-key-b64");
      await waitFor(() => expect(within(row).getByText("new-root-key-b64")).toBeInTheDocument());
    });
  });

  describe("Txt", () => {
    it("deletes a txt after typing its id to confirm", async () => {
      setup();
      // "Book One" also appears as a <select> option in the Shares section
      // below, so scope the lookup to the Txt section specifically.
      const txtSection = screen.getByRole("heading", { name: "Txt" }).closest("section") as HTMLElement;
      const row = within(txtSection).getByText("Book One").closest("li") as HTMLElement;

      await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
      const confirmButton = within(row).getByRole("button", { name: "Confirm delete" });
      expect(confirmButton).toBeDisabled();

      await userEvent.type(within(row).getByRole("textbox"), "1");
      expect(confirmButton).toBeEnabled();
      await userEvent.click(confirmButton);

      expect(deleteTxt).toHaveBeenCalledWith(1);
    });
  });

  describe("Shares", () => {
    it("grants a share of one of the admin's own txt to a recipient", async () => {
      setup();
      await userEvent.selectOptions(screen.getByLabelText("Txt"), "1");
      await userEvent.type(screen.getByLabelText("Recipient user id"), "2");
      await userEvent.click(screen.getByRole("button", { name: "Grant share" }));

      await waitFor(() => expect(getTxtKey).toHaveBeenCalledWith(1));
      expect(adminShares.grantShare).toHaveBeenCalledWith({}, 1, expect.any(Uint8Array), 2);
    });

    it("revokes an existing share", async () => {
      vi.mocked(adminShares.listShares).mockResolvedValue([{ id: 5, txtId: 1, toUserId: 2 }]);
      setup();
      await waitFor(() => expect(screen.getByText(/Book One.*user #2/)).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
      expect(adminShares.revokeShare).toHaveBeenCalledWith({}, 5);
    });
  });
});
