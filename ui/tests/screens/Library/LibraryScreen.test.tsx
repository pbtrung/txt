// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/state/VaultContext", () => ({ useVault: vi.fn() }));
vi.mock("../../../src/screens/Library/useLibraryBooks", () => ({
  useLibraryBooks: vi.fn(),
}));
// jsdom reports a zero-size scroll container, so the real virtualizer would
// see nothing as "in view" and render no rows at all -- these tests care
// about search/filter/link behavior, not which rows a real viewport would
// show, so the collection is rendered without its virtualizer wrapper.
vi.mock("react-aria-components", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-aria-components")>();
  return {
    ...actual,
    Virtualizer: ({ children }: { children: ReactNode }) => children,
  };
});

import type { LibraryBook } from "../../../src/data/libraryDb";
import type { BookShare } from "../../../src/data/shares";
import { LibraryContent } from "../../../src/screens/Library/LibraryContent";
import * as libraryModel from "../../../src/screens/Library/libraryModel";
import { LibraryHeader } from "../../../src/screens/Library/LibraryHeader";
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
    latestBookmarkCfi: null,
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
    lastAccessed: 100,
  }),
  book({
    txtId: 2,
    title: "A Wizard of Earthsea",
    authors: ["Ursula K. Le Guin"],
    subjects: ["Fantasy"],
    bookmarkCount: 1,
    lastBookmarked: 200,
    latestBookmarkCfi: "epubcfi(/6/8)",
  }),
];

function renderScreen(books: LibraryBook[] | null, lock = vi.fn()) {
  return renderLibrary(
    books === null
      ? { status: "loading" }
      : { status: "ready", books, reload: vi.fn() },
    lock,
  );
}

function renderLibrary(
  library: LibraryState,
  lock = vi.fn(),
  mutate = vi.fn().mockResolvedValue(undefined),
  accountType: "admin" | "user" = "user",
) {
  const session = {
    database: { mutate, read: vi.fn().mockResolvedValue([]) },
    displayName: "Trung",
    accountType,
  } as unknown as VaultSession;
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
      <LocationProbe />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function ControlledSearchHeader({ onChange }: { onChange: (value: string) => void }) {
  const [query, setQuery] = useState("wizard");
  const update = (value: string) => {
    onChange(value);
    setQuery(value);
  };
  return (
    <LibraryHeader
      query={query}
      onQuery={update}
      menu={null}
      selectedBook={null}
      showBookActions={false}
      canShare={false}
      onRead={() => undefined}
      onShare={() => undefined}
    />
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

  it("opens on Recent and lists recent activity", () => {
    renderScreen(LIBRARY);
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Dune/ })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /A Wizard of Earthsea/ }),
    ).toBeInTheDocument();
  });

  it("filters by search query", async () => {
    renderScreen(LIBRARY);
    const searchbox = screen.getByRole("searchbox");
    const searchField = searchbox.closest(".search-box");
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toHaveTextContent("×");
    expect(clear.firstElementChild).toHaveClass("search-box-clear-icon");
    expect(searchField).toHaveAttribute("data-empty", "true");

    await userEvent.click(searchbox);
    expect(searchbox).toHaveFocus();
    await userEvent.type(searchbox, "wizard");
    expect(searchField).not.toHaveAttribute("data-empty");

    expect(screen.getByRole("row", { name: /Wizard/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Dune/ })).not.toBeInTheDocument();

    await userEvent.click(clear);
    expect(searchbox).toHaveValue("");
    expect(searchbox).toHaveFocus();
    await userEvent.tab();
    expect(searchField).toHaveAttribute("data-empty", "true");
    expect(screen.getByRole("row", { name: /Dune/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Wizard/ })).toBeInTheDocument();
  });

  it("clears the controlled search with one change event", async () => {
    const onChange = vi.fn();
    render(<ControlledSearchHeader onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("reuses the search index while the query changes", async () => {
    const createSearch = vi.spyOn(libraryModel, "createBookSearch");
    renderScreen(LIBRARY);

    await userEvent.type(screen.getByRole("searchbox"), "wizard");

    expect(createSearch).toHaveBeenCalledTimes(1);
  });

  it("supports access and bookmark search expressions", async () => {
    renderScreen([
      book({ txtId: 1, title: "Read Dune", lastAccessed: 100 }),
      book({ txtId: 2, title: "Marked Earthsea", bookmarkCount: 1 }),
      book({ txtId: 3, title: "Inactive book" }),
    ]);
    const searchbox = screen.getByRole("searchbox");

    await userEvent.type(searchbox, "a:*");
    expect(screen.getByRole("heading", { name: "All Books" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Read Dune/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Marked Earthsea/ })).toBeNull();

    await userEvent.clear(searchbox);
    await userEvent.type(searchbox, "b:'earth'");
    expect(screen.getByRole("row", { name: /Marked Earthsea/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Inactive book/ })).toBeNull();
  });

  it("shows an empty-library message when there are no books at all", () => {
    renderScreen([]);
    expect(screen.getByText("No recent activity yet.")).toBeInTheDocument();
  });

  it("shows a no-matches message when a search matches nothing", async () => {
    renderScreen(LIBRARY);
    await userEvent.type(screen.getByRole("searchbox"), "nonexistent");
    expect(screen.getByText("No books match.")).toBeInTheDocument();
  });

  it("selects a browse row before opening it in the Reader", async () => {
    renderScreen(LIBRARY);
    await userEvent.click(screen.getByRole("button", { name: /^All Books/ }));
    const read = screen.getByRole("button", { name: "Read" });
    const dune = screen.getByRole("row", { name: "Dune" });
    expect(read).toBeDisabled();

    await userEvent.click(dune);

    expect(dune).toHaveAttribute("aria-selected", "true");
    expect(read).toBeEnabled();
    await userEvent.click(read);
    expect(screen.getByTestId("location")).toHaveTextContent("/read/1");
  });

  it("attaches Read and Share to search and enables both for an admin selection", async () => {
    renderLibrary(
      { status: "ready", books: LIBRARY, reload: vi.fn() },
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
      "admin",
    );
    await userEvent.click(screen.getByRole("button", { name: /^All Books/ }));
    const search = screen.getByRole("searchbox");
    const actions = screen.getByLabelText("Book actions");
    const read = screen.getByRole("button", { name: "Read" });
    const share = screen.getByRole("button", { name: "Share" });

    expect(search.closest(".library-search-group")).toContainElement(actions);
    expect(read).toBeDisabled();
    expect(share).toBeDisabled();
    expect(read.querySelector("span")).toHaveClass("d-none", "d-md-inline");
    expect(share.querySelector("span")).toHaveClass("d-none", "d-md-inline");

    await userEvent.click(screen.getByRole("row", { name: "Dune" }));

    expect(read).toBeEnabled();
    expect(share).toBeEnabled();
  });

  it("shows source-book metadata and unique deletion actions for shares", async () => {
    const source = book({
      txtId: 7,
      title: "A title long enough to need truncation",
      authors: ["A very long author name"],
      bookmarkCount: 3,
      lastAccessed: new Date(2026, 7, 19, 9, 8, 7).getTime(),
    });
    const shares = [share(1, source.txtId), share(2, source.txtId)];
    const onDeleteShare = vi.fn();
    render(
      <MemoryRouter>
        <LibraryContent
          books={[source]}
          view={{ kind: "shares" }}
          query=""
          selectedTxtId={null}
          onSelectBook={() => undefined}
          onNavigate={() => undefined}
          onClearAccess={() => undefined}
          onClearBookmarks={() => undefined}
          shares={shares}
          onCopyShare={() => undefined}
          onDeleteShare={onDeleteShare}
        />
      </MemoryRouter>,
    );

    const rows = screen.getAllByRole("row");
    expect(rows.map((row) => row.getAttribute("data-key"))).toEqual([
      "share-1",
      "share-2",
    ]);
    expect(screen.getAllByLabelText("3 bookmarks")).toHaveLength(2);
    expect(screen.getAllByLabelText(/Last accessed/)).toHaveLength(2);
    expect(screen.getAllByText("A very long author name")).toHaveLength(2);
    expect(screen.getByRole("grid", { name: "Shares" })).toHaveClass(
      "overflow-x-hidden",
      "min-w-0",
    );

    const deletes = screen.getAllByRole("button", { name: "Delete this share" });
    await userEvent.hover(deletes[0]);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Delete this share");
    await userEvent.click(deletes[0]);
    expect(onDeleteShare).toHaveBeenCalledWith(shares[0]);
  });

  it("opens a bookmark row at the book's newest bookmark", () => {
    renderScreen(LIBRARY);
    const bookmarks = screen.getByRole("region", { name: "Bookmarks" });
    const link = bookmarks.querySelector("a");

    expect(link).not.toBeNull();
    const href = link?.getAttribute("href") ?? "";
    expect(new URL(href, "https://txt.test").searchParams.get("cfi")).toBe(
      "epubcfi(/6/8)",
    );
  });

  it("marks active books and shows bookmark/access badges before authors", async () => {
    const accessed = new Date(2026, 7, 17, 14, 5, 9).getTime();
    renderScreen([
      book({
        title: "Active book",
        authors: ["A very long author name"],
        bookmarkCount: 2,
        lastAccessed: accessed,
      }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: /^All Books/ }));

    const row = screen.getByRole("row", { name: /Active book/ });
    expect(screen.getByRole("grid", { name: "Books" })).toContainElement(row);
    expect(row.querySelector(".book-row-icon")).toHaveClass("book-row-icon-active");
    expect(screen.getByLabelText("2 bookmarks")).toHaveTextContent("2");
    expect(screen.getByLabelText("Last accessed 14:05:09 17/08/26")).toBeVisible();
    expect(screen.getByText("A very long author name")).toHaveClass("text-truncate");
  });

  it("keeps desktop navigation in the left pane with browse counts", () => {
    renderScreen(LIBRARY);
    expect(screen.getByRole("button", { name: /^Recent/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^All Books/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Authors/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Subjects/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Publishers/ })).toHaveTextContent("1");
    expect(screen.getByText("Browse")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
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

    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Recent access" })).toHaveTextContent(
      "Recently read",
    );
    expect(screen.getByRole("region", { name: "Bookmarks" })).toHaveTextContent(
      "Recently marked",
    );
  });

  it("removes access or all bookmarks from their Recent sections", async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    renderLibrary(
      {
        status: "ready",
        books: [
          book({
            title: "Active book",
            lastAccessed: 100,
            bookmarkCount: 2,
            lastBookmarked: 200,
          }),
        ],
        reload,
      },
      vi.fn(),
      mutate,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Clear recent access for Active book",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete bookmarks for Active book" }),
    );

    expect(mutate.mock.calls.map(([mutation]) => mutation.description)).toEqual([
      "clear last access",
      "clear bookmarks",
    ]);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it("shows the bookmark deletion action on hover", async () => {
    renderScreen([
      book({ title: "Marked book", bookmarkCount: 1, lastBookmarked: 200 }),
    ]);
    const remove = screen.getByRole("button", {
      name: "Delete bookmarks for Marked book",
    });
    await userEvent.hover(remove);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Delete bookmarks for Marked book",
    );
    expect(remove).toHaveClass("compact-delete-button", "book-row-remove");
    const row = remove.closest('[role="row"]');
    expect(row).toHaveClass("book-row-container");
    expect(screen.getByRole("grid", { name: "Bookmarks" })).toContainElement(row);
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
    expect(screen.getByRole("row", { name: /Wizard/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Dune/ })).not.toBeInTheDocument();
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

  it("uses the left-pane styling in an icon-only mobile dropdown", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    renderScreen(LIBRARY);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    expect(trigger).not.toHaveClass("dropdown-toggle");
    expect(trigger).toHaveTextContent("");

    await userEvent.click(trigger);

    const menu = screen.getByRole("dialog", { name: "Library menu" });
    expect(menu).toHaveClass("library-dropdown-dialog");
    expect(menu.parentElement).toHaveClass("library-dropdown");
    expect(within(menu).getByRole("button", { name: /^Recent/ })).toHaveClass(
      "list-group-item",
      "active",
    );
    const lock = within(menu).getByRole("button", { name: "Lock" });
    expect(lock.parentElement).toHaveTextContent("Trung");
  });
});

function share(id: number, txtId: number): BookShare {
  return {
    id,
    txtId,
    title: "Fallback title",
    shareId: new Uint8Array(32),
    contentKey: new Uint8Array(128),
    prefix: new Uint8Array(32),
    path: new Uint8Array(32),
    state: "active",
    createdAt: id,
  };
}
