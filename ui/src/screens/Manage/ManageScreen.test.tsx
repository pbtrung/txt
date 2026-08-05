// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchBookInfo } from "../../data/bookMetadata";
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
  return {
    ...actual,
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    generateUserRootKey: vi.fn(() => "generated-root-key"),
    getUserCreds: vi.fn(),
    listUsersWithInfo: vi.fn(),
    updateUserCreds: vi.fn(),
  };
});
vi.mock("../../data/adminShares", async () => {
  const actual = await vi.importActual<typeof import("../../data/adminShares")>(
    "../../data/adminShares",
  );
  return {
    ...actual,
    grantShare: vi.fn(),
    listShares: vi.fn(),
    revokeShare: vi.fn(),
  };
});
vi.mock("../../data/bookMetadata", async () => {
  const actual = await vi.importActual<
    typeof import("../../data/bookMetadata")
  >("../../data/bookMetadata");
  return {
    ...actual,
    fetchBookInfo: vi.fn(),
  };
});

import { grantShare, listShares, revokeShare } from "../../data/adminShares";
import {
  createUser,
  deleteUser,
  getUserCreds,
  listUsersWithInfo,
  updateUserCreds,
} from "../../data/adminUsers";

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
const updateBookMetadata = vi.fn().mockResolvedValue(undefined);
const syncBookInfo = vi.fn();
type MetadataSubscriptionResult = {
  data?: { txt?: { txtMetadata?: unknown[] }[] };
};
type SubscribeQuery = (
  query: unknown,
  cb: (result: MetadataSubscriptionResult) => void,
) => () => void;
const subscribeQuery = vi.fn<SubscribeQuery>(() => vi.fn());

function setup(refreshing = false) {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session: {
      displayName: "Alice",
      instantDb: { subscribeQuery },
      auth: {},
      authId: "auth-1",
      instantAppId: "app-1",
      instantClientName: "firebase",
      firebaseApiKey: "fake-api-key",
      isAdmin: true,
      umk: new Uint8Array(),
      keyStorePrivKey: new Uint8Array(),
      credStoreKey: new Uint8Array(),
      r2Config: { endpoint: "https://x", region: "auto", bucket: "b" },
      metadataById,
      docKeys: new Map([["txt-1", new Uint8Array()]]),
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
    updateBookMetadata,
    syncBookInfo,
  });
  return render(
    <MemoryRouter>
      <ManageScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
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
  vi.mocked(createUser).mockResolvedValue("user-3");
  vi.mocked(getUserCreds).mockResolvedValue({
    instantAppId: "app-1",
    instantClientName: "firebase",
    firebaseEmail: "bob@example.com",
    firebasePassword: "pw",
    firebaseApiKey: "fake-api-key",
    displayName: "Bob",
    userRootKey: "stored-root-key",
  });
  vi.mocked(updateUserCreds).mockResolvedValue(undefined);
  vi.mocked(deleteUser).mockResolvedValue(undefined);
  vi.mocked(grantShare).mockResolvedValue(undefined);
  vi.mocked(revokeShare).mockResolvedValue(undefined);
  vi.mocked(fetchBookInfo).mockResolvedValue(metadataById.get("txt-1")!);
  updateBookMetadata.mockResolvedValue(undefined);
  subscribeQuery.mockReturnValue(vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ManageScreen", () => {
  it("loads users and shares before showing the shell", async () => {
    setup();

    await waitFor(() =>
      expect(screen.getByLabelText(/search users/i)).toBeInTheDocument(),
    );

    expect(screen.getAllByText("Skypiea").length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /back to library/i })[0],
    ).toHaveAttribute("href", "/library");
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

  it("uses email fallback instead of an unnamed or auth-id label", async () => {
    vi.mocked(listUsersWithInfo).mockResolvedValue([
      {
        id: "user-without-name",
        email: "fallback@example.com",
        isAdmin: false,
      },
    ]);
    vi.mocked(listShares).mockResolvedValue([]);

    setup();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^fallback@example.com/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Unnamed user")).toBeNull();
    expect(screen.queryByText("user-without-name")).toBeNull();
  });

  it("switches between Users, Books, and Shares lists", async () => {
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

  it("edits book metadata from the Books toolbar", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Books/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Book One/ }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.getByRole("dialog", { name: "Edit Book One" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchBookInfo).toHaveBeenCalledOnce());
    const title = screen.getByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, "Book Uno");
    const subjects = screen.getByLabelText("Subjects (comma-separated)");
    await userEvent.clear(subjects);
    await userEvent.type(subjects, "A, Edited");
    await userEvent.type(screen.getByLabelText("Publisher"), "Press");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateBookMetadata).toHaveBeenCalledOnce());
    expect(updateBookMetadata).toHaveBeenCalledWith(
      "txt-1",
      {
        title: "Book Uno",
        author: "Author One",
        publisher: "Press",
        subjects: ["A", "Edited"],
        description: undefined,
      },
      expect.any(Function),
    );
  });

  it("syncs only the selected book when InstantDB reports metadata changes", async () => {
    const callbacks: ((result: MetadataSubscriptionResult) => void)[] = [];
    const unsubscribe = vi.fn();
    subscribeQuery.mockImplementation(
      (_query: unknown, cb: (result: MetadataSubscriptionResult) => void) => {
        callbacks.push(cb);
        return unsubscribe;
      },
    );
    vi.mocked(fetchBookInfo).mockResolvedValue({
      ...metadataById.get("txt-1")!,
      title: "Book One Live",
    });

    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Books/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Book One/ }));

    await waitFor(() => expect(subscribeQuery).toHaveBeenCalledOnce());
    expect(subscribeQuery.mock.calls[0]![0]).toEqual({
      txt: {
        $: { where: { id: "txt-1" }, fields: [] },
        txtMetadata: { $: { fields: ["content"] } },
      },
    });

    const emit = callbacks[0]!;
    emit({ data: { txt: [{ txtMetadata: [{}] }] } });
    emit({ data: { txt: [{ txtMetadata: [{}] }] } });

    await waitFor(() =>
      expect(syncBookInfo).toHaveBeenCalledWith(
        "txt-1",
        expect.objectContaining({ title: "Book One Live" }),
      ),
    );
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

  it("creates users from the toolbar modal", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    const userCallsBefore = vi.mocked(listUsersWithInfo).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(
      screen.getByRole("dialog", { name: "Create user" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Instant app ID")).toHaveValue("app-1");
    expect(screen.getByLabelText("Instant client name")).toHaveValue(
      "firebase",
    );
    expect(screen.getByLabelText("Firebase API key")).toHaveValue(
      "fake-api-key",
    );
    expect(screen.getByLabelText("User root key")).toHaveValue(
      "generated-root-key",
    );

    await userEvent.type(
      screen.getByLabelText("Firebase email"),
      "new@example.com",
    );
    await userEvent.type(screen.getByLabelText("Firebase password"), "pw");
    await userEvent.type(screen.getByLabelText("Display name"), "New User");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));

    let review = screen.getByRole("dialog", {
      name: "Review new user credentials",
    });
    const json = within(review).getByLabelText(
      "Credentials JSON",
    ) as HTMLTextAreaElement;
    expect(json.value).toContain('"firebase_email": "new@example.com"');
    expect(json.value).toContain('"user_root_key": "generated-root-key"');

    await userEvent.click(within(review).getByRole("button", { name: "Edit" }));
    expect(
      screen.getByRole("dialog", { name: "Create user" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));

    review = screen.getByRole("dialog", {
      name: "Review new user credentials",
    });
    const create = within(review).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    await userEvent.click(
      within(review).getByLabelText("I downloaded this JSON to a local file"),
    );
    expect(create).toBeEnabled();
    await userEvent.click(create);

    await waitFor(() => expect(createUser).toHaveBeenCalledOnce());
    expect(createUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authId: "auth-1" }),
      expect.objectContaining({
        instantAppId: "app-1",
        instantClientName: "firebase",
        firebaseEmail: "new@example.com",
        firebasePassword: "pw",
        firebaseApiKey: "fake-api-key",
        displayName: "New User",
        userRootKey: "generated-root-key",
      }),
      expect.any(Function),
    );
    await waitFor(() =>
      expect(vi.mocked(listUsersWithInfo).mock.calls.length).toBeGreaterThan(
        userCallsBefore,
      ),
    );
  });

  it("loads and saves stored user credentials from the edit modal", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^Bob/ }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() =>
      expect(getUserCreds).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ authId: "auth-1" }),
        "user-2",
      ),
    );
    const displayName = screen.getByLabelText("Display name");
    const firstSave = screen.getByRole("button", { name: "Save" });
    expect(firstSave).toBeDisabled();
    const password = screen.getByLabelText(
      "Firebase password",
    ) as HTMLInputElement;
    expect(password.type).toBe("password");
    await userEvent.click(
      screen.getByRole("button", { name: "Show Firebase password" }),
    );
    expect(password.type).toBe("text");
    await userEvent.clear(displayName);
    await userEvent.type(displayName, "Bobby");
    expect(firstSave).toBeEnabled();
    await userEvent.click(firstSave);

    const review = screen.getByRole("dialog", { name: "Review Bob" });
    const json = within(review).getByLabelText(
      "Credentials JSON",
    ) as HTMLTextAreaElement;
    expect(json.value).toContain('"display_name": "Bobby"');
    await userEvent.click(within(review).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateUserCreds).toHaveBeenCalledOnce());
    expect(updateUserCreds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authId: "auth-1" }),
      "user-2",
      expect.objectContaining({ displayName: "Bobby" }),
    );
  });

  it("deletes a user after typed confirmation and reloads shares", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    const shareCallsBefore = vi.mocked(listShares).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: /^Bob/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.type(
      screen.getByLabelText("Type user-2 to confirm"),
      "user-2",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm delete" }),
    );

    await waitFor(() => expect(deleteUser).toHaveBeenCalledOnce());
    expect(deleteUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authId: "auth-1" }),
      "user-2",
    );
    await waitFor(() =>
      expect(vi.mocked(listShares).mock.calls.length).toBeGreaterThan(
        shareCallsBefore,
      ),
    );
  });

  it("grants a share from the Shares toolbar", async () => {
    vi.mocked(listShares).mockResolvedValue([]);
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    const shareCallsBefore = vi.mocked(listShares).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: /^Shares/ }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await userEvent.selectOptions(screen.getByLabelText("Book"), "txt-1");
    await userEvent.selectOptions(screen.getByLabelText("Recipient"), "user-2");
    await userEvent.click(screen.getByRole("button", { name: "Grant share" }));

    await waitFor(() => expect(grantShare).toHaveBeenCalledOnce());
    expect(grantShare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authId: "auth-1" }),
      "txt-1",
      "user-2",
    );
    await waitFor(() =>
      expect(vi.mocked(listShares).mock.calls.length).toBeGreaterThan(
        shareCallsBefore,
      ),
    );
  });

  it("revokes a selected share from the Shares toolbar", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    const shareCallsBefore = vi.mocked(listShares).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: /^Shares/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Book One/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke share" }));

    await waitFor(() => expect(revokeShare).toHaveBeenCalledOnce());
    expect(revokeShare).toHaveBeenCalledWith(expect.anything(), "share-1");
    await waitFor(() =>
      expect(vi.mocked(listShares).mock.calls.length).toBeGreaterThan(
        shareCallsBefore,
      ),
    );
  });
});
