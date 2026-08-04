// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BookInfo } from "../../data/metadata";
import * as VaultContextModule from "../../state/VaultContext";
import { ManageScreen } from "./ManageScreen";

vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<
    typeof import("../../state/VaultContext")
  >("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});
vi.mock("../../data/adminUsers", async () => {
  const actual = await vi.importActual<typeof import("../../data/adminUsers")>(
    "../../data/adminUsers",
  );
  return { ...actual, listUsersWithInfo: vi.fn() };
});
vi.mock("../../data/adminShares", async () => {
  const actual = await vi.importActual<typeof import("../../data/adminShares")>(
    "../../data/adminShares",
  );
  return { ...actual, listShares: vi.fn() };
});

import { listShares } from "../../data/adminShares";
import { listUsersWithInfo } from "../../data/adminUsers";

const metadataById = new Map<string, BookInfo>([
  [
    "txt-1",
    {
      txtId: "txt-1",
      name: "n1",
      title: "Book One",
      author: "Author One",
      subjects: ["A"],
      rawMetadata: [],
    },
  ],
]);

const lock = vi.fn();
const refresh = vi.fn().mockResolvedValue(undefined);

function setup(refreshing = false) {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session: {
      displayName: "Alice",
      instantDb: {},
      auth: {},
      authId: "auth-1",
      isAdmin: true,
      umk: new Uint8Array(),
      keyStorePrivKey: new Uint8Array(),
      credStoreKey: new Uint8Array(),
      r2Config: { endpoint: "https://x", region: "auto", bucket: "b" },
      metadataById,
      docKeys: new Map(),
      txtAccess: { id: null, key: new Uint8Array() },
      txtBookmarks: { id: null, key: new Uint8Array() },
    } as unknown as VaultContextModule.VaultSession,
    error: null,
    accessMap: {},
    bookmarksMap: {},
    refreshing,
    progress: null,
    unlock: vi.fn(),
    lock,
    refresh,
    recordReadPosition: vi.fn(),
    removeAccessEntry: vi.fn(),
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry: vi.fn(),
  });
  return render(
    <MemoryRouter>
      <ManageScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listUsersWithInfo).mockResolvedValue([
    {
      id: "auth-1",
      email: "admin@example.com",
      displayName: "Alice",
      isAdmin: true,
    },
    {
      id: "user-2",
      email: "bob@example.com",
      displayName: "Bob",
      isAdmin: false,
    },
  ]);
  vi.mocked(listShares).mockResolvedValue([
    {
      id: "share-1",
      txtId: "txt-1",
      fromUserId: "auth-1",
      toUserId: "user-2",
    },
  ]);
});

describe("ManageScreen", () => {
  it("loads users and shares before showing the shell", async () => {
    setup();

    await waitFor(() =>
      expect(screen.getByLabelText(/search users/i)).toBeInTheDocument(),
    );

    expect(screen.getAllByText("Skypiea").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /back to library/i })[0]).toHaveAttribute(
      "href",
      "/library",
    );
    expect(screen.getByRole("button", { name: /^Users/ })).toHaveTextContent(
      "2",
    );
    expect(screen.getByRole("button", { name: /^Books/ })).toHaveTextContent(
      "1",
    );
    expect(screen.getByRole("button", { name: /^Shares/ })).toHaveTextContent(
      "1",
    );
    expect(screen.getByRole("button", { name: /^Alice/ })).toHaveTextContent(
      "(you)",
    );
  });

  it("switches between Users, Books, and Shares read-only lists", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Books/ }));
    expect(screen.getByLabelText(/search books/i)).toBeInTheDocument();
    expect(screen.getByText("Book One")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Shares/ }));
    expect(screen.getByLabelText(/search shares/i)).toBeInTheDocument();
    expect(screen.getByText("Book One")).toBeInTheDocument();
    expect(screen.getByText("Shared with Bob (user-2)")).toBeInTheDocument();
  });

  it("filters the active section with the top search field", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/search users/i), "bob");

    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Alice/ })).toBeNull();
  });

  it("refreshes the vault and reloads users/shares", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    const userCallsBefore = vi.mocked(listUsersWithInfo).mock.calls.length;
    const shareCallsBefore = vi.mocked(listShares).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(refresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(vi.mocked(listUsersWithInfo).mock.calls.length).toBeGreaterThan(
        userCallsBefore,
      ),
    );
    expect(vi.mocked(listShares).mock.calls.length).toBeGreaterThan(
      shareCallsBefore,
    );
  });
});
