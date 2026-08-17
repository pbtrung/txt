// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/state/VaultContext", () => ({ useVault: vi.fn() }));
vi.mock("../../../src/screens/Library/useLibraryBooks", () => ({
  useLibraryBooks: vi.fn(),
}));
// jsdom reports a zero-size scroll container, so the real virtualizer would
// see nothing as "in view" and render no rows at all -- these tests care
// about search/filter/link behavior, not which rows a real viewport would
// show, so every row is rendered unconditionally instead.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 64,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * 64,
        key: index,
      })),
  }),
}));

import type { LibraryBook } from "../../../src/data/libraryDb";
import { LibraryScreen } from "../../../src/screens/Library/LibraryScreen";
import {
  useLibraryBooks,
  type LibraryState,
} from "../../../src/screens/Library/useLibraryBooks";
import { useVault, type VaultSession } from "../../../src/state/VaultContext";

function book(overrides: Partial<LibraryBook>): LibraryBook {
  return {
    txtId: 1,
    title: "Untitled",
    authors: [],
    subjects: [],
    publisher: null,
    lastAccessed: 0,
    bookmarkCount: 0,
    lastBookmarked: null,
    ...overrides,
  };
}

const LIBRARY: LibraryBook[] = [
  book({
    txtId: 1,
    title: "Dune",
    authors: ["Frank Herbert"],
    subjects: ["Science Fiction"],
    publisher: "Ace",
  }),
  book({
    txtId: 2,
    title: "A Wizard of Earthsea",
    authors: ["Ursula K. Le Guin"],
    subjects: ["Fantasy"],
  }),
];

function renderScreen(books: LibraryBook[] | null, lock = vi.fn()) {
  return renderLibrary(
    books === null ? { status: "loading" } : { status: "ready", books },
    lock,
  );
}

function renderLibrary(library: LibraryState, lock = vi.fn()) {
  const session = { db: {}, displayName: "Trung" } as VaultSession;
  vi.mocked(useVault).mockReturnValue({
    status: "unlocked",
    session,
    error: null,
    progress: null,
    unlock: vi.fn(),
    lock,
  });
  vi.mocked(useLibraryBooks).mockReturnValue(library);
  return render(
    <MemoryRouter>
      <LibraryScreen />
    </MemoryRouter>,
  );
}

describe("LibraryScreen", () => {
  it("shows a loading message before books resolve", () => {
    renderScreen(null);
    expect(screen.getByText(/Loading your library/)).toBeInTheDocument();
  });

  it("shows a library loading error", () => {
    renderLibrary({
      status: "error",
      error: "database failed",
    });

    expect(screen.getByRole("alert")).toHaveTextContent("database failed");
  });

  it("lists every book once loaded, under All Books", () => {
    renderScreen(LIBRARY);
    expect(screen.getByRole("heading", { name: "All Books" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Dune/ })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /A Wizard of Earthsea/ }),
    ).toBeInTheDocument();
  });

  it("filters by search query", async () => {
    renderScreen(LIBRARY);
    await userEvent.type(screen.getByRole("searchbox"), "wizard");

    expect(screen.getByRole("link", { name: /Wizard/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Dune/ })).not.toBeInTheDocument();
  });

  it("supports access and bookmark search expressions", async () => {
    renderScreen([
      book({ txtId: 1, title: "Read Dune", lastAccessed: 100 }),
      book({ txtId: 2, title: "Marked Earthsea", bookmarkCount: 1 }),
      book({ txtId: 3, title: "Inactive book" }),
    ]);
    const searchbox = screen.getByRole("searchbox");

    await userEvent.click(screen.getByRole("button", { name: /^Recent/ }));
    await userEvent.type(searchbox, "a:*");
    expect(screen.getByRole("heading", { name: "All Books" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Read Dune/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Marked Earthsea/ })).toBeNull();

    await userEvent.clear(searchbox);
    await userEvent.type(searchbox, "b:'earth'");
    expect(screen.getByRole("link", { name: /Marked Earthsea/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Inactive book/ })).toBeNull();
  });

  it("shows an empty-library message when there are no books at all", () => {
    renderScreen([]);
    expect(screen.getByText("Your library is empty.")).toBeInTheDocument();
  });

  it("shows a no-matches message when a search matches nothing", async () => {
    renderScreen(LIBRARY);
    await userEvent.type(screen.getByRole("searchbox"), "nonexistent");
    expect(screen.getByText("No books match.")).toBeInTheDocument();
  });

  it("links each book to /read/:txtId", () => {
    renderScreen(LIBRARY);
    expect(screen.getByRole("link", { name: /Dune/ })).toHaveAttribute(
      "href",
      "/read/1",
    );
  });

  it("marks active books and shows bookmark/access badges before authors", () => {
    const accessed = new Date(2026, 7, 17, 14, 5, 9).getTime();
    renderScreen([
      book({
        title: "Active book",
        authors: ["A very long author name"],
        bookmarkCount: 2,
        lastAccessed: accessed,
      }),
    ]);

    const row = screen.getByRole("link", { name: /Active book/ });
    expect(row.querySelector(".book-row-icon")).toHaveClass("book-row-icon-active");
    expect(screen.getByLabelText("2 bookmarks")).toHaveTextContent("2");
    expect(screen.getByLabelText("Last accessed 14:05:09 17/08/26")).toBeVisible();
    expect(screen.getByText("A very long author name")).toHaveClass("text-truncate");
  });

  it("shows nav rows with counts for All Books/Authors/Subjects/Publishers", () => {
    renderScreen(LIBRARY);
    expect(screen.getByRole("button", { name: /^Recent/ })).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: /^All Books/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Authors/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Subjects/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Publishers/ })).toHaveTextContent("1");
  });

  it("shows recent access and bookmarked books in the Recent view", async () => {
    renderScreen([
      book({ txtId: 1, title: "Recently read", lastAccessed: 2000 }),
      book({
        txtId: 2,
        title: "Recently marked",
        bookmarkCount: 2,
        lastBookmarked: 3000,
      }),
    ]);

    await userEvent.click(screen.getByRole("button", { name: /^Recent/ }));

    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Recent access" })).toHaveTextContent(
      "Recently read",
    );
    expect(screen.getByRole("region", { name: "Bookmarks" })).toHaveTextContent(
      "Recently marked",
    );
  });

  it("drills from a dimension into its entries, then into that entry's books", async () => {
    renderScreen(LIBRARY);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /^Subjects/ }));
    expect(screen.getByRole("heading", { name: "Subjects" })).toBeInTheDocument();
    const fantasyRow = screen.getByRole("button", { name: /^Fantasy/ });
    expect(fantasyRow).toHaveTextContent("1");
    expect(fantasyRow.querySelector(".badge")).toHaveClass("text-bg-dark");
    expect(screen.getByRole("button", { name: /^Science Fiction/ })).toHaveTextContent(
      "1",
    );

    await user.click(fantasyRow);

    expect(
      screen.getByRole("heading", { name: "Subject: Fantasy" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Wizard/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Dune/ })).not.toBeInTheDocument();
  });

  it("the back button returns from filtered books to the dimension's entries", async () => {
    renderScreen(LIBRARY);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Subjects/ }));
    await user.click(screen.getByRole("button", { name: /^Fantasy/ }));

    await user.click(screen.getByRole("button", { name: /Back to Subjects/ }));

    expect(screen.getByRole("heading", { name: "Subjects" })).toBeInTheDocument();
  });

  it("shows the account's display name and locks on click", async () => {
    const lock = vi.fn();
    renderScreen(LIBRARY, lock);
    expect(screen.getByText("Trung")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Lock" }));

    expect(lock).toHaveBeenCalledTimes(1);
  });

  it("the menu button opens the drawer", async () => {
    renderScreen(LIBRARY);
    expect(screen.getByRole("dialog", { name: "Menu" })).not.toHaveClass("show");

    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("dialog", { name: "Menu" })).toHaveClass("show");
  });
});
