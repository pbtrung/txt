// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/vue";
import userEvent from "@testing-library/user-event";
import { defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter, RouterView, useRoute, type Router } from "vue-router";
import { describe, expect, it, vi } from "vitest";

import type { BookmarksMap } from "../../data/bookmarks";
import type { LibraryBook } from "./libraryModel";

vi.mock("../../state/vault", () => ({ useVault: vi.fn() }));
vi.mock("./useLibraryBooks", () => ({ useLibraryBooks: vi.fn() }));

import LibraryScreen from "./LibraryScreen.vue";
import * as vaultModule from "../../state/vault";
import * as useLibraryBooksModule from "./useLibraryBooks";

function book(overrides: Partial<LibraryBook> & { txtId: number }): LibraryBook {
  return {
    info: {
      txtId: overrides.txtId,
      name: `n${overrides.txtId}`,
      title: `Title ${overrides.txtId}`,
      subjects: [],
      rawMetadata: [],
    },
    lastPartNum: null,
    lastAccessedMs: null,
    ...overrides,
  };
}

const books: LibraryBook[] = [
  book({
    txtId: 1,
    info: {
      txtId: 1,
      name: "n1",
      title: "The White Order",
      author: "L. E. Modesitt, Jr.",
      subjects: ["Fantasy", "Military"],
      publisher: "Tor Publishing Group",
      rawMetadata: [],
    },
    lastPartNum: 14,
    lastAccessedMs: 2000,
  }),
  book({
    txtId: 2,
    info: {
      txtId: 2,
      name: "n2",
      title: "21 Lessons for the 21st Century",
      author: "Yuval Noah Harari",
      subjects: ["History"],
      rawMetadata: [],
    },
    lastPartNum: 18,
    lastAccessedMs: 3000,
  }),
  book({
    txtId: 3,
    info: { txtId: 3, name: "n3", title: "Never Opened Yet", subjects: [], rawMetadata: [] },
  }),
];

const removeAccessEntry = vi.fn();
const removeBookmarkEntry = vi.fn();
const lock = vi.fn();

const CurrentPath = defineComponent({
  setup() {
    const route = useRoute();
    return () => h("div", ["Reader for ", route.path, route.fullPath.slice(route.path.length)]);
  },
});

function createTestRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/library", component: LibraryScreen },
      { path: "/read/:txtId", component: CurrentPath },
    ],
  });
}

async function renderLibrary(bookmarksMap: BookmarksMap = new Map()) {
  vi.mocked(vaultModule.useVault).mockReturnValue({
    status: ref("unlocked"),
    session: ref({ creds: { displayName: "Alice" } } as vaultModule.VaultSession),
    error: ref(null),
    accessMap: ref(new Map()),
    bookmarksMap: ref(bookmarksMap),
    unlock: vi.fn(),
    lock,
    getTxtKey: vi.fn(),
    recordReadPosition: vi.fn(),
    removeAccessEntry,
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry,
  } as unknown as ReturnType<typeof vaultModule.useVault>);
  vi.mocked(useLibraryBooksModule.useLibraryBooks).mockReturnValue({
    books: ref(books),
    loading: ref(false),
  } as unknown as ReturnType<typeof useLibraryBooksModule.useLibraryBooks>);

  const router = createTestRouter();
  await router.push("/library");
  const AppStub = defineComponent({ setup: () => () => h(RouterView) });
  return render(AppStub, { global: { plugins: [router] } });
}

describe("LibraryScreen", () => {
  it("defaults to the Recent view, most recently opened first, under Continue Reading", async () => {
    await renderLibrary();
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByText("Continue Reading")).toBeInTheDocument();
    const lessons = screen.getByText("21 Lessons for the 21st Century");
    const whiteOrder = screen.getByText("The White Order");
    expect(lessons.compareDocumentPosition(whiteOrder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Never Opened Yet")).not.toBeInTheDocument();
  });

  it("shows every book, alphabetically, under All books", async () => {
    await renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    expect(screen.getByText("21 Lessons for the 21st Century")).toBeInTheDocument();
    expect(screen.getByText("Never Opened Yet")).toBeInTheDocument();
    expect(screen.getByText("The White Order")).toBeInTheDocument();
  });

  it("shows Part N (no total, no progress bar) for an in-progress book under All books", async () => {
    await renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    expect(screen.getByText("Part 14")).toBeInTheDocument();
    expect(screen.queryByText(/Part 14\/\d+/)).not.toBeInTheDocument();
  });

  it("does not show a part number under Continue Reading", async () => {
    await renderLibrary();
    expect(screen.getByText("The White Order")).toBeInTheDocument();
    expect(screen.queryByText("Part 14")).not.toBeInTheDocument();
    expect(screen.queryByText("Part 18")).not.toBeInTheDocument();
  });

  it("drills into Authors, then filters by the chosen author", async () => {
    await renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /Authors/ }));
    expect(screen.getByText("L. E. Modesitt, Jr.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /L\. E\. Modesitt/ }));
    expect(screen.getByText("The White Order")).toBeInTheDocument();
    expect(screen.queryByText("21 Lessons for the 21st Century")).not.toBeInTheDocument();
  });

  it("filters the current book list by the search query", async () => {
    await renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    expect(screen.getByText("3 books")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/search library/i), "fantasy");
    expect(screen.getByText("The White Order")).toBeInTheDocument();
    expect(screen.queryByText("21 Lessons for the 21st Century")).not.toBeInTheDocument();
    expect(screen.getByText("1 book")).toBeInTheDocument();
    expect(screen.queryByText("3 books")).not.toBeInTheDocument();
  });

  it("navigates to the reader when a book is clicked", async () => {
    await renderLibrary();
    await userEvent.click(screen.getByText("The White Order"));
    await waitFor(() => expect(screen.getByText(/Reader for \/read\/1/)).toBeInTheDocument());
  });

  it("deletes a Continue Reading entry via its delete button", async () => {
    await renderLibrary();
    const row = screen.getByText("The White Order").closest('[role="button"]') as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /remove.*from recent/i }));
    expect(removeAccessEntry).toHaveBeenCalledWith(1);
  });

  describe("small-screen nav drawer (merged into the wordmark)", () => {
    it("is closed by default -- only the lg+ sidebar's nav items exist", async () => {
      await renderLibrary();
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(1);
    });

    it("opens on clicking the wordmark toggle, showing a second copy of the nav", async () => {
      await renderLibrary();
      await userEvent.click(screen.getByRole("button", { name: /library menu/i }));
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(2);
    });

    it("closes again after selecting a view from the drawer", async () => {
      await renderLibrary();
      await userEvent.click(screen.getByRole("button", { name: /library menu/i }));
      const allBooksButtons = screen.getAllByRole("button", { name: /All books/ });
      await userEvent.click(allBooksButtons[0]);
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(1);
      expect(screen.getByText("Never Opened Yet")).toBeInTheDocument();
    });

    it("closes on an outside click", async () => {
      await renderLibrary();
      await userEvent.click(screen.getByRole("button", { name: /library menu/i }));
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(2);
      await userEvent.click(screen.getByText("Continue Reading"));
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(1);
    });

    it("closes on Escape", async () => {
      await renderLibrary();
      await userEvent.click(screen.getByRole("button", { name: /library menu/i }));
      await userEvent.keyboard("{Escape}");
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(1);
    });

    it("positions the dropdown to grow rightward (it's anchored at the left edge, not the right)", async () => {
      await renderLibrary();
      await userEvent.click(screen.getByRole("button", { name: /library menu/i }));
      const menu = screen.getAllByRole("button", { name: /All books/ })[0].closest(".dropdown-menu");
      expect(menu).toHaveClass("app-dropdown-menu-start");
    });

    it("the toggle button wraps only the book icon, not the 'Skypiea' text", async () => {
      await renderLibrary();
      const toggle = screen.getByRole("button", { name: /library menu/i });
      expect(toggle).not.toHaveTextContent("Skypiea");
      expect(screen.getAllByText("Skypiea").length).toBeGreaterThan(0);
    });
  });

  describe("account footer (bottom of the left pane)", () => {
    it("shows the signed-in display name (with a leading user icon) and an icon-only Lock button", async () => {
      await renderLibrary();
      const name = screen.getByText("Alice");
      expect(name).toBeInTheDocument();
      expect(name.parentElement?.querySelector(".bi-person-circle")).not.toBeNull();
      const lockButton = screen.getByRole("button", { name: /^lock$/i });
      expect(lockButton).not.toHaveTextContent("Lock");
    });

    it("calls lock() when clicked", async () => {
      await renderLibrary();
      await userEvent.click(screen.getByRole("button", { name: /^lock$/i }));
      expect(lock).toHaveBeenCalledTimes(1);
    });

    it("is no longer in the top bar -- only the nav's copy (or copies) exist", async () => {
      await renderLibrary();
      expect(screen.getAllByRole("button", { name: /^lock$/i })).toHaveLength(1);
      await userEvent.click(screen.getByRole("button", { name: /library menu/i }));
      expect(screen.getAllByRole("button", { name: /^lock$/i })).toHaveLength(2);
    });
  });

  describe("Recent Bookmarks", () => {
    const bookmarksMap: BookmarksMap = new Map([
      [1, [{ partNum: 14, line: 1, txtPreview: "Powerful white mages killed", createdAt: 1000 }]],
    ]);

    it("shows a bookmark row with the book title, part/line, and preview", async () => {
      await renderLibrary(bookmarksMap);
      expect(screen.getByText("Recent Bookmarks")).toBeInTheDocument();
      expect(screen.getByText("Part 14 · Line 1")).toBeInTheDocument();
      expect(screen.getByText(/Powerful white mages killed/)).toBeInTheDocument();
    });

    it("navigates to the reader at that exact part and line when clicked", async () => {
      await renderLibrary(bookmarksMap);
      await userEvent.click(screen.getByText(/Powerful white mages killed/));
      await waitFor(() => expect(screen.getByText(/Reader for \/read\/1\?part=14&line=1/)).toBeInTheDocument());
    });

    it("deletes a bookmark via its delete button", async () => {
      await renderLibrary(bookmarksMap);
      const row = screen.getByText(/Powerful white mages killed/).closest('[role="button"]') as HTMLElement;
      await userEvent.click(within(row).getByRole("button", { name: /remove this bookmark/i }));
      expect(removeBookmarkEntry).toHaveBeenCalledWith(1, 1000);
    });
  });
});
