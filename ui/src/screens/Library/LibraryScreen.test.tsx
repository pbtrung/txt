// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { BookmarksMap } from "../../data/bookmarks";
import { LibraryScreen } from "./LibraryScreen";
import * as VaultContextModule from "../../state/VaultContext";
import * as useLibraryBooksModule from "./useLibraryBooks";
import type { LibraryBook } from "./libraryModel";

vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<
    typeof import("../../state/VaultContext")
  >("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});
vi.mock("./useLibraryBooks", () => ({ useLibraryBooks: vi.fn() }));

function book(
  overrides: Partial<LibraryBook> & { txtId: string },
): LibraryBook {
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
    txtId: "txt-1",
    info: {
      txtId: "txt-1",
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
    txtId: "txt-2",
    info: {
      txtId: "txt-2",
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
    txtId: "txt-3",
    info: {
      txtId: "txt-3",
      name: "n3",
      title: "Never Opened Yet",
      subjects: [],
      rawMetadata: [],
    },
  }),
];

// Both are real async functions on VaultContextValue (Promise<void>) --
// mockResolvedValue, not a bare vi.fn(), so LibraryScreen.tsx's own .catch()
// on their return value has a real Promise to call it on, matching the real
// implementation's contract.
const removeAccessEntry = vi.fn().mockResolvedValue(undefined);
const removeBookmarkEntry = vi.fn().mockResolvedValue(undefined);
const lock = vi.fn();
const refresh = vi.fn();

function CurrentPath() {
  const location = useLocation();
  return (
    <div>
      Reader for {location.pathname}
      {location.search}
    </div>
  );
}

function setVaultMock(
  bookmarksMap: BookmarksMap,
  refreshing: boolean,
  progress: VaultContextModule.VaultProgress | null = null,
  displayName?: string,
  isAdmin = false,
) {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session: { displayName, isAdmin } as VaultContextModule.VaultSession,
    error: null,
    accessMap: {},
    bookmarksMap,
    refreshing,
    progress,
    unlock: vi.fn(),
    lock,
    refresh,
    recordReadPosition: vi.fn(),
    removeAccessEntry,
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry,
    updateBookMetadata: vi.fn(),
    syncBookInfo: vi.fn(),
  });
}

function libraryTree() {
  return (
    <MemoryRouter initialEntries={["/library"]}>
      <Routes>
        <Route path="/library" element={<LibraryScreen />} />
        <Route path="/read/:txtId" element={<CurrentPath />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderLibrary(
  bookmarksMap: BookmarksMap = {},
  refreshing = false,
  progress: VaultContextModule.VaultProgress | null = null,
  displayName?: string,
  isAdmin = false,
) {
  setVaultMock(bookmarksMap, refreshing, progress, displayName, isAdmin);
  vi.mocked(useLibraryBooksModule.useLibraryBooks).mockReturnValue({
    books,
    loading: false,
  });
  return render(libraryTree());
}

describe("LibraryScreen", () => {
  it("defaults to the Recent view, most recently opened first, under Continue Reading", () => {
    renderLibrary();
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByText("Continue Reading")).toBeInTheDocument();
    const lessons = screen.getByText("21 Lessons for the 21st Century");
    const whiteOrder = screen.getByText("The White Order");
    // lastAccessedMs: 3000 for "21 Lessons" vs 2000 for "The White Order" -- more recent first.
    expect(
      lessons.compareDocumentPosition(whiteOrder) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // "Never Opened Yet" has no read position, so it shouldn't appear in Recent.
    expect(screen.queryByText("Never Opened Yet")).not.toBeInTheDocument();
  });

  it("shows every book, alphabetically, under All books", async () => {
    renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    expect(
      screen.getByText("21 Lessons for the 21st Century"),
    ).toBeInTheDocument();
    expect(screen.getByText("Never Opened Yet")).toBeInTheDocument();
    expect(screen.getByText("The White Order")).toBeInTheDocument();
  });

  it("shows Part N (no total, no progress bar) for an in-progress book under All books", async () => {
    renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    expect(screen.getByText("Part 14")).toBeInTheDocument();
    expect(screen.queryByText(/Part 14\/\d+/)).not.toBeInTheDocument();
  });

  it("does not show a part number under Continue Reading", () => {
    renderLibrary();
    expect(screen.getByText("The White Order")).toBeInTheDocument();
    expect(screen.queryByText("Part 14")).not.toBeInTheDocument();
    expect(screen.queryByText("Part 18")).not.toBeInTheDocument();
  });

  it("drills into Authors, then filters by the chosen author", async () => {
    renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /Authors/ }));
    expect(screen.getByText("L. E. Modesitt, Jr.")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /L\. E\. Modesitt/ }),
    );
    expect(screen.getByText("The White Order")).toBeInTheDocument();
    expect(
      screen.queryByText("21 Lessons for the 21st Century"),
    ).not.toBeInTheDocument();
  });

  it("filters the current book list by the search query", async () => {
    renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    expect(screen.getByText("3 books")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/search library/i), "fantasy");
    expect(screen.getByText("The White Order")).toBeInTheDocument();
    expect(
      screen.queryByText("21 Lessons for the 21st Century"),
    ).not.toBeInTheDocument();
    // The header count should track the filtered list, not the pre-search total.
    expect(screen.getByText("1 book")).toBeInTheDocument();
    expect(screen.queryByText("3 books")).not.toBeInTheDocument();
  });

  it("navigates to the reader when a book is clicked", async () => {
    renderLibrary();
    await userEvent.click(screen.getByText("The White Order"));
    await waitFor(() =>
      expect(screen.getByText(/Reader for \/read\/txt-1/)).toBeInTheDocument(),
    );
  });

  it("deletes a Continue Reading entry via its delete button", async () => {
    renderLibrary();
    const row = screen
      .getByText("The White Order")
      .closest('[role="button"]') as HTMLElement;
    await userEvent.click(
      within(row).getByRole("button", { name: /remove.*from recent/i }),
    );
    expect(removeAccessEntry).toHaveBeenCalledWith("txt-1");
  });

  describe("virtualization", () => {
    function renderLibraryWithBooks(manyBooks: LibraryBook[]) {
      setVaultMock({}, false);
      vi.mocked(useLibraryBooksModule.useLibraryBooks).mockReturnValue({
        books: manyBooks,
        loading: false,
      });
      return render(libraryTree());
    }

    it("renders only a bounded window of rows for a large 'All books' list, not all of them", async () => {
      const manyBooks = Array.from({ length: 500 }, (_, i) =>
        book({ txtId: `txt-${i + 1}` }),
      );
      renderLibraryWithBooks(manyBooks);

      await userEvent.click(screen.getByRole("button", { name: /All books/ }));
      expect(screen.getByText("500 books")).toBeInTheDocument();

      const rows = screen.getAllByRole("button", { name: /^Title txt-\d+$/ });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(100); // well under the full 500 -- proves the window is bounded
    });

    it("renders only a bounded window of rows for a large Continue Reading list, not all of them", () => {
      const manyBooks = Array.from({ length: 500 }, (_, i) =>
        book({ txtId: `txt-${i + 1}`, lastPartNum: 1, lastAccessedMs: i }),
      );
      renderLibraryWithBooks(manyBooks);

      const rows = screen.getAllByRole("button", { name: /^Title txt-\d+$/ });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(100);
    });

    it("renders only a bounded window of rows for a large Authors browse-entry list, not all of them", async () => {
      const manyBooks = Array.from({ length: 500 }, (_, i) =>
        book({
          txtId: `txt-${i + 1}`,
          info: {
            txtId: `txt-${i + 1}`,
            name: `n${i + 1}`,
            title: `Title ${i + 1}`,
            author: `Author ${i + 1}`,
            subjects: [],
            rawMetadata: [],
          },
        }),
      );
      renderLibraryWithBooks(manyBooks);

      await userEvent.click(screen.getByRole("button", { name: /Authors/ }));

      const rows = screen.getAllByRole("button", { name: /^Author \d+/ });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(100);
    });

    it("renders only a bounded window of rows for a large Recent Bookmarks list, not all of them", () => {
      const manyBookmarks: BookmarksMap = {
        "txt-1": Array.from({ length: 500 }, (_, i) => ({
          id: `bookmark-${i}`,
          partNum: 1,
          line: i + 1,
          preview: `Preview line ${i}`,
          createdAt: i,
        })),
      };
      setVaultMock(manyBookmarks, false);
      vi.mocked(useLibraryBooksModule.useLibraryBooks).mockReturnValue({
        books: [books[0]!],
        loading: false,
      });
      render(libraryTree());

      const rows = screen.getAllByText(/Preview line \d+/);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(100);
    });
  });

  describe("small-screen nav drawer (merged into the wordmark)", () => {
    it("is closed by default -- only the lg+ sidebar's nav items exist", () => {
      renderLibrary();
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(
        1,
      );
    });

    it("opens on clicking the wordmark toggle, showing a second copy of the nav", async () => {
      renderLibrary();
      await userEvent.click(
        screen.getByRole("button", { name: /library menu/i }),
      );
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(
        2,
      );
    });

    it("closes again after selecting a view from the drawer", async () => {
      renderLibrary();
      await userEvent.click(
        screen.getByRole("button", { name: /library menu/i }),
      );
      const allBooksButtons = screen.getAllByRole("button", {
        name: /All books/,
      });
      await userEvent.click(allBooksButtons[0]!); // the drawer's copy -- renders before the sidebar's in DOM order
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(
        1,
      );
      expect(screen.getByText("Never Opened Yet")).toBeInTheDocument();
    });

    it("closes on an outside click", async () => {
      renderLibrary();
      await userEvent.click(
        screen.getByRole("button", { name: /library menu/i }),
      );
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(
        2,
      );
      // Plain text, not the book row itself -- clicking that would navigate
      // away (openBook), which isn't what "click elsewhere" is testing here.
      await userEvent.click(screen.getByText("Continue Reading"));
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(
        1,
      );
    });

    it("closes on Escape", async () => {
      renderLibrary();
      await userEvent.click(
        screen.getByRole("button", { name: /library menu/i }),
      );
      await userEvent.keyboard("{Escape}");
      expect(screen.getAllByRole("button", { name: /All books/ })).toHaveLength(
        1,
      );
    });

    it("positions the dropdown to grow rightward (it's anchored at the left edge, not the right)", async () => {
      renderLibrary();
      await userEvent.click(
        screen.getByRole("button", { name: /library menu/i }),
      );
      const menu = screen
        .getAllByRole("button", { name: /All books/ })[0]
        ?.closest(".dropdown-menu");
      expect(menu).toHaveClass("app-dropdown-menu-start");
    });

    it("the toggle button wraps only the book icon, not the 'Skypiea' text", () => {
      renderLibrary();
      const toggle = screen.getByRole("button", { name: /library menu/i });
      expect(toggle).not.toHaveTextContent("Skypiea");
      // Both the small-screen and lg+ copies of the wordmark text coexist in
      // jsdom (no real CSS media queries), so at least one must be present.
      expect(screen.getAllByText("Skypiea").length).toBeGreaterThan(0);
    });
  });

  describe("account footer (bottom of the left pane)", () => {
    it("shows a user icon and an icon-only Lock button", () => {
      renderLibrary();
      expect(document.querySelector(".bi-person-circle")).not.toBeNull();
      const lockButton = screen.getByRole("button", { name: /^lock$/i });
      expect(lockButton).not.toHaveTextContent("Lock");
    });

    it("shows the creds file's display_name next to the person icon, when present", () => {
      renderLibrary({}, false, null, "Trung");
      expect(screen.getAllByText("Trung").length).toBeGreaterThan(0);
    });

    it("links the display name to Manage for admin sessions", () => {
      renderLibrary({}, false, null, "Trung", true);
      expect(screen.getAllByRole("link", { name: "Trung" })[0]).toHaveAttribute(
        "href",
        "/manage",
      );
    });

    it("shows nothing next to the person icon when display_name is absent", () => {
      renderLibrary();
      expect(screen.queryByText("Trung")).toBeNull();
    });

    it("calls lock() when clicked", async () => {
      renderLibrary();
      await userEvent.click(screen.getByRole("button", { name: /^lock$/i }));
      expect(lock).toHaveBeenCalledTimes(1);
    });

    it("is no longer in the top bar -- only the nav's copy (or copies) exist", async () => {
      renderLibrary();
      expect(screen.getAllByRole("button", { name: /^lock$/i })).toHaveLength(
        1,
      );
      await userEvent.click(
        screen.getByRole("button", { name: /library menu/i }),
      );
      expect(screen.getAllByRole("button", { name: /^lock$/i })).toHaveLength(
        2,
      );
    });

    it("shows an icon-only Refresh button to the left of Lock", () => {
      renderLibrary();
      const refreshButton = screen.getByRole("button", {
        name: /refresh library/i,
      });
      expect(refreshButton).not.toHaveTextContent("Refresh");
      const lockButton = screen.getByRole("button", { name: /^lock$/i });
      expect(
        refreshButton.compareDocumentPosition(lockButton) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("calls refresh() when clicked", async () => {
      renderLibrary();
      await userEvent.click(
        screen.getByRole("button", { name: /refresh library/i }),
      );
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("closes the small-screen drawer when Refresh is clicked from inside it", async () => {
      renderLibrary();
      await userEvent.click(
        screen.getByRole("button", { name: /library menu/i }),
      );
      const refreshButtons = screen.getAllByRole("button", {
        name: /refresh library/i,
      });
      await userEvent.click(refreshButtons[0]!); // the drawer's copy -- renders before the sidebar's in DOM order
      expect(
        screen.getAllByRole("button", { name: /refresh library/i }),
      ).toHaveLength(1);
    });

    it("shows a spinner and disables itself while refreshing, and disables the drawer toggle too (dropdown copy -- the lg+ sidebar's copy is gone entirely, see below)", async () => {
      // Opened *before* refreshing starts -- the toggle disables once
      // refreshing does, so a real user couldn't open it mid-refresh; this
      // covers the dropdown staying open (and usable) if it already was.
      const { rerender } = renderLibrary({}, false);
      await userEvent.click(
        screen.getByRole("button", { name: /library menu/i }),
      );
      // Two copies coexist in jsdom (no real CSS media queries to actually
      // hide the lg+ sidebar's) -- the drawer's own renders first in DOM
      // order, same as the "All books" duplicate-copy tests above.
      expect(
        screen.getAllByRole("button", { name: /refresh library/i })[0],
      ).toBeInTheDocument();

      setVaultMock({}, true);
      rerender(libraryTree());

      expect(
        screen.getByRole("button", { name: /library menu/i }),
      ).toBeDisabled();
      const refreshButton = screen.getByRole("button", {
        name: /refresh library/i,
      });
      expect(refreshButton).toBeDisabled();
      expect(refreshButton.querySelector(".spinner-border")).not.toBeNull();
      expect(refreshButton.querySelector(".bi-arrow-clockwise")).toBeNull();
    });

    it("disables the small-screen drawer toggle while refreshing, so it can't be opened mid-refresh", () => {
      renderLibrary({}, true);
      expect(
        screen.getByRole("button", { name: /library menu/i }),
      ).toBeDisabled();
    });

    it("disables the search box while refreshing", () => {
      renderLibrary({}, true);
      expect(screen.getByLabelText(/search library/i)).toBeDisabled();
    });

    it("replaces the whole left pane and content pane with one spinner while refreshing, keeping just the top bar", () => {
      renderLibrary({}, true);
      // The heading/book-list content pane is gone...
      expect(
        screen.queryByRole("heading", { name: "Recent" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("The White Order")).not.toBeInTheDocument();
      // ...and so is the lg+ sidebar below "Skypiea" -- nav items, account
      // footer, and its Lock/Refresh buttons included.
      expect(
        screen.queryByRole("button", { name: /All books/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^lock$/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/refreshing your library/i)).toBeInTheDocument();
      // ...but the top bar (drawer toggle, search box) is still there.
      expect(
        screen.getByRole("button", { name: /library menu/i }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/search library/i)).toBeInTheDocument();
    });

    it("shows the current phase and a step counter under that spinner once progress is set", () => {
      renderLibrary({}, true, {
        label: "Loading your bookmarks",
        step: 3,
        total: 3,
      });
      const step = screen.getByText("Step 3 of 3");
      const label = screen.getByText(/loading your bookmarks/i);
      // Step counter on top, phase label underneath it.
      expect(
        step.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // The generic fallback line is gone once a real phase label takes over.
      expect(
        screen.queryByText(/^refreshing your library/i),
      ).not.toBeInTheDocument();
    });
  });

  describe("Recent Bookmarks", () => {
    const bookmarksMap: BookmarksMap = {
      "txt-1": [
        {
          id: "bookmark-42",
          partNum: 14,
          line: 1,
          preview: "Powerful white mages killed",
          createdAt: 1000,
        },
      ],
    };

    it("shows a bookmark row with the book title, part/line, and preview", () => {
      renderLibrary(bookmarksMap);
      expect(screen.getByText("Recent Bookmarks")).toBeInTheDocument();
      expect(screen.getByText("Part 14 · Line 1")).toBeInTheDocument();
      expect(
        screen.getByText(/Powerful white mages killed/),
      ).toBeInTheDocument();
    });

    it("navigates to the reader at that exact part and line when clicked", async () => {
      renderLibrary(bookmarksMap);
      await userEvent.click(screen.getByText(/Powerful white mages killed/));
      await waitFor(() =>
        expect(
          screen.getByText(/Reader for \/read\/txt-1\?part=14&line=1/),
        ).toBeInTheDocument(),
      );
    });

    it("deletes a bookmark via its delete button", async () => {
      renderLibrary(bookmarksMap);
      const row = screen
        .getByText(/Powerful white mages killed/)
        .closest('[role="button"]') as HTMLElement;
      await userEvent.click(
        within(row).getByRole("button", { name: /remove this bookmark/i }),
      );
      expect(removeBookmarkEntry).toHaveBeenCalledWith("txt-1", "bookmark-42");
    });
  });
});
