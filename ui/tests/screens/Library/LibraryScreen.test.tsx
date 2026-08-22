// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/state/VaultContext", () => ({ useVault: vi.fn() }));
vi.mock("../../../src/screens/Library/useLibraryBooks", () => ({
  useLibraryBooks: vi.fn(),
}));
vi.mock("../../../src/data/shares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/data/shares")>()),
  createBookShare: vi.fn(),
  deleteBookShare: vi.fn(),
  shareUrl: vi.fn(),
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
import {
  createBookShare,
  deleteBookShare,
  shareUrl,
  type BookShare,
} from "../../../src/data/shares";
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
    bookmarks: [],
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
    bookmarks: [
      {
        cfi: "epubcfi(/6/8)",
        pageNumber: 8,
        createdAt: 200,
      },
    ],
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
  shares: BookShare[] = [],
) {
  const session = {
    database: { mutate, read: vi.fn().mockResolvedValue(shares) },
    displayName: "Trung",
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
      selectedShare={null}
      showBookActions={false}
      showShareActions={false}
      canShare={false}
      onRead={() => undefined}
      onShare={() => undefined}
      onCopyShare={() => undefined}
      onDeleteShare={() => undefined}
    />
  );
}

describe("LibraryScreen", () => {
  beforeEach(() => {
    vi.mocked(createBookShare).mockReset();
    vi.mocked(deleteBookShare).mockReset();
    vi.mocked(shareUrl).mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows a loading message before books resolve", () => {
    renderScreen(null);
    expect(screen.getByText(/Loading your library/)).toBeInTheDocument();
  });

  it("collapses the sidebar after a narrow Library finishes loading", () => {
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function () {
        const width = this.classList.contains("library-sidebar")
          ? 280
          : this.classList.contains("library-screen")
            ? 679
            : 0;
        return { width } as DOMRect;
      });
    const rendered = renderLibrary({ status: "loading" });
    expect(screen.getByText(/Loading your library/)).toBeInTheDocument();

    vi.mocked(useLibraryBooks).mockReturnValue({
      status: "ready",
      books: LIBRARY,
      reload: vi.fn(),
    });
    rendered.rerender(
      <MemoryRouter>
        <LibraryScreen />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(document.querySelector(".library-sidebar")).toBeNull();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
    bounds.mockRestore();
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
    expect(searchField).toHaveClass("input", "input-sm", "input-secondary");
    expect(clear).toHaveAccessibleName("Clear search");
    expect(clear).toHaveClass("btn", "btn-circle", "btn-ghost", "compact-x-button");
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

  it("attaches Read and Share to search and enables both for the owner", async () => {
    renderLibrary(
      { status: "ready", books: LIBRARY, reload: vi.fn() },
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
    );
    await userEvent.click(screen.getByRole("button", { name: /^All Books/ }));
    const search = screen.getByRole("searchbox");
    const actions = screen.getByLabelText("Book actions");
    const read = screen.getByRole("button", { name: "Read" });
    const share = screen.getByRole("button", { name: "Share" });

    expect(search.closest(".library-search-group")).toContainElement(actions);
    expect(search.closest(".search-box")).not.toHaveClass("join-item");
    expect(search).toHaveClass("library-search-control");
    expect(read).toBeDisabled();
    expect(share).toBeDisabled();
    expect(read).toHaveClass(
      "gap-1",
      "md:px-2",
      "library-book-action",
      "library-search-control",
    );
    expect(share).toHaveClass(
      "gap-1",
      "md:px-2",
      "library-book-action",
      "library-search-control",
    );
    expect(read.querySelector("span")).toHaveClass(
      "hidden",
      "leading-none",
      "md:inline",
    );
    expect(share.querySelector("span")).toHaveClass(
      "hidden",
      "leading-none",
      "md:inline",
    );

    const shareRow = screen.getByRole("row", { name: "Dune" });
    await userEvent.click(shareRow);
    expect(shareRow).toHaveAttribute("aria-selected", "true");

    expect(read).toBeEnabled();
    expect(share).toBeEnabled();
  });

  it("blocks the Library and reports share progress without overlapping work", async () => {
    let complete: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.mocked(createBookShare).mockImplementation(async (_session, _txtId, step) => {
      step?.("Encrypting shared copy");
      await pending;
    });
    renderLibrary(
      { status: "ready", books: LIBRARY, reload: vi.fn() },
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
    );
    await userEvent.click(screen.getByRole("button", { name: /^All Books/ }));
    await userEvent.click(screen.getByRole("row", { name: "Dune" }));
    const shareButton = screen.getByRole("button", { name: "Share" });

    fireEvent.click(shareButton);
    fireEvent.click(shareButton);

    expect(createBookShare).toHaveBeenCalledOnce();
    expect(screen.getByTestId("library-operation-surface")).toHaveAttribute("inert");
    expect(screen.getByTestId("library-operation-surface")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(libraryToast()).toHaveTextContent("Creating share: Dune");
    expect(libraryToast()).toHaveTextContent("Encrypting shared copy");
    const toastRegion = document.querySelector(".library-toast-region");
    const rightPane = document.querySelector(".library-right-pane");
    expect(rightPane).toContainElement(toastRegion as HTMLElement);
    expect(toastRegion).toHaveClass("toast", "toast-bottom");
    expect(libraryToast()).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
    );
    expect(libraryToast().querySelector(".library-toast-content")).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
    );
    expect(screen.getByText("Creating share: Dune")).toHaveClass("w-full", "truncate");
    expect(document.querySelector(".library-operation-blocker")).not.toBeNull();

    await act(async () => complete());
    await waitFor(() =>
      expect(libraryToast()).toHaveTextContent("Share created for “Dune”"),
    );
    expect(screen.getByTestId("library-operation-surface")).not.toHaveAttribute(
      "inert",
    );
  });

  it("reports deletion progress and removes the completed share", async () => {
    const existingShare = share(5, LIBRARY[0].txtId);
    let complete: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.mocked(deleteBookShare).mockImplementation(async (_session, _share, step) => {
      step?.("Deleting shared copy");
      await pending;
    });
    renderLibrary(
      { status: "ready", books: LIBRARY, reload: vi.fn() },
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
      [existingShare],
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Shares/ })).toHaveTextContent("1"),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Shares/ }));
    const actions = screen.getByLabelText("Share actions");
    const deleteButton = screen.getByRole("button", {
      name: "Delete this share",
    });
    expect(
      screen.getByRole("searchbox").closest(".library-search-group"),
    ).toContainElement(actions);
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    expect(deleteButton).toBeDisabled();

    await userEvent.click(screen.getByRole("row", { name: "Dune" }));
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);
    expect(libraryToast()).toHaveTextContent("Deleting share");
    expect(libraryToast()).toHaveTextContent("Deleting shared copy");

    await act(async () => complete());
    await waitFor(() => expect(deleteButton).toBeDisabled());
    expect(screen.getByText("No shared books yet.")).toBeInTheDocument();
    expect(libraryToast()).toHaveTextContent("Share deleted");
  });

  it("shows source-book metadata and selects the requested share", async () => {
    const source = book({
      txtId: 7,
      title: "A title long enough to need truncation",
      authors: ["A very long author name"],
      bookmarkCount: 3,
      lastAccessed: new Date(2026, 7, 19, 9, 8, 7).getTime(),
    });
    const shares = [share(1, source.txtId), share(2, source.txtId)];
    const onSelectShare = vi.fn();
    render(
      <MemoryRouter>
        <LibraryContent
          books={[source]}
          view={{ kind: "shares" }}
          query=""
          selectedTxtId={null}
          onSelectBook={() => undefined}
          selectedShareId={null}
          onSelectShare={onSelectShare}
          onNavigate={() => undefined}
          onClearAccess={() => undefined}
          onDeleteBookmark={() => undefined}
          shares={shares}
        />
      </MemoryRouter>,
    );

    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(screen.getAllByLabelText("3 bookmarks")).toHaveLength(2);
    expect(screen.getAllByLabelText(/Last accessed/)).toHaveLength(2);
    expect(screen.getAllByText("A very long author name")).toHaveLength(2);
    expect(screen.getByRole("grid", { name: "Shares" })).toHaveClass(
      "overflow-x-hidden",
      "min-w-0",
    );

    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete this share" }),
    ).not.toBeInTheDocument();
    await userEvent.click(rows[0]);
    expect(onSelectShare).toHaveBeenCalledWith(shares[0].id);
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
    expect(row.querySelector(".book-row-meta")).toHaveClass("pl-0");
    expect(screen.getByLabelText("2 bookmarks")).toHaveClass("gap-1", "font-semibold");
    expect(within(screen.getByLabelText("2 bookmarks")).getByText("2")).toHaveClass(
      "book-row-badge-text",
    );
    expect(screen.getByLabelText("Last accessed 14:05:09 17/08/26")).toHaveClass(
      "gap-1",
      "font-semibold",
    );
    expect(screen.getByText("A very long author name")).toHaveClass("truncate");
  });

  it("adds one space after the icon only for author-only metadata", async () => {
    renderScreen([
      book({
        title: "Author-only book",
        authors: ["Solo author"],
      }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: /^All Books/ }));

    const row = screen.getByRole("row", { name: /Author-only book/ });
    expect(row.querySelector(".book-row-meta")).toHaveClass("pl-1");
  });

  it("keeps desktop navigation in the left pane with browse counts", () => {
    renderScreen(LIBRARY);
    expect(document.querySelector(".library-brand-col")).toHaveClass(
      "library-pane-col",
    );
    expect(document.querySelector(".library-sidebar")).toHaveClass("library-pane-col");
    expect(document.querySelector(".library-search-col")).toHaveClass("min-w-0");
    const recent = screen.getByRole("button", { name: /^Recent/ });
    expect(recent).toHaveTextContent("2");
    expect(recent.querySelector(".badge")).toHaveClass("font-bold");
    expect(recent).toHaveClass("btn-active");
    expect(recent).toHaveClass("border-b", "border-base-300");
    expect(recent).toHaveClass("rounded-none");
    expect(screen.getByRole("button", { name: /^All Books/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Authors/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Subjects/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Publishers/ })).toHaveTextContent("1");
    expect(screen.getByText("Browse")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });

  it("switches to the dropdown before the right pane becomes narrower than 400px", () => {
    let resize!: ResizeObserverCallback;
    const observer = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
    class ResizeObserverMock {
      observe = observer.observe;
      unobserve = observer.unobserve;
      disconnect = observer.disconnect;

      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    renderScreen(LIBRARY);
    const root = document.querySelector(".library-screen");
    const sidebar = document.querySelector(".library-sidebar");
    expect(root).not.toBeNull();
    expect(sidebar).not.toBeNull();
    const rootRect = vi.spyOn(root!, "getBoundingClientRect");
    vi.spyOn(sidebar!, "getBoundingClientRect").mockReturnValue({
      width: 280,
    } as DOMRect);

    rootRect.mockReturnValue({ width: 679 } as DOMRect);
    act(() => {
      resize([], observer as unknown as ResizeObserver);
    });
    expect(document.querySelector(".library-sidebar")).toBeNull();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox").closest(".library-search-group")).toHaveClass(
      "library-search-group-single-pane",
    );

    rootRect.mockReturnValue({ width: 680 } as DOMRect);
    act(() => {
      resize([], observer as unknown as ResizeObserver);
    });
    expect(document.querySelector(".library-sidebar")).not.toBeNull();
    expect(document.querySelector(".library-sidebar-layout")).not.toBeNull();
    expect(
      screen.getByRole("searchbox").closest(".library-search-group"),
    ).not.toHaveClass("library-search-group-single-pane");
  });

  it("shows the sidebar below the desktop breakpoint when 400px remains", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function () {
        const width = this.classList.contains("library-sidebar")
          ? 280
          : this.classList.contains("library-screen")
            ? 700
            : 0;
        return { width } as DOMRect;
      });

    renderScreen(LIBRARY);

    expect(document.querySelector(".library-sidebar")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    bounds.mockRestore();
  });

  it("shows recent access and bookmarked books in the Recent view", () => {
    const accessed = new Date(2026, 7, 19, 10, 11, 12).getTime();
    const latestBookmark = new Date(2026, 7, 19, 9, 8, 7).getTime();
    const olderBookmark = new Date(2026, 7, 18, 8, 7, 6).getTime();
    renderScreen([
      book({
        txtId: 1,
        title: "Recent book",
        lastAccessed: accessed,
        bookmarkCount: 2,
        lastBookmarked: latestBookmark,
        bookmarks: [
          { cfi: "page-9", pageNumber: 9, createdAt: latestBookmark },
          { cfi: "page-4", pageNumber: 4, createdAt: olderBookmark },
        ],
      }),
    ]);

    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    const accessRegion = screen.getByRole("region", { name: "Recent access" });
    const bookmarkRegion = screen.getByRole("region", { name: "Bookmarks" });
    expect(accessRegion).toHaveTextContent("Recent book");
    expect(bookmarkRegion).toHaveTextContent("Recent book");
    expect(
      within(accessRegion).getByLabelText("Last accessed 10:11:12 19/08/26"),
    ).toBeVisible();
    expect(
      within(bookmarkRegion).getByLabelText("Bookmarked 09:08:07 19/08/26"),
    ).toBeVisible();
    expect(
      within(bookmarkRegion).getByLabelText("Bookmarked 08:07:06 18/08/26"),
    ).toBeVisible();
    expect(within(bookmarkRegion).queryByLabelText(/Last accessed/)).toBeNull();
    expect(screen.getByLabelText("Page 9")).toBeInTheDocument();
    expect(screen.getByLabelText("Page 4")).toBeInTheDocument();
    expect(
      within(bookmarkRegion)
        .getAllByRole("link")
        .map((link) =>
          new URL(link.getAttribute("href")!, "https://txt.test").searchParams.get(
            "cfi",
          ),
        ),
    ).toEqual(["page-9", "page-4"]);
    expect(within(bookmarkRegion).queryByLabelText("2 bookmarks")).toBeNull();
  });

  it("blocks and reports each Recent deletion without overlapping work", async () => {
    const completions: Array<() => void> = [];
    const mutate = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          completions.push(resolve);
        }),
    );
    const reload = vi.fn();
    renderLibrary(
      {
        status: "ready",
        books: [
          book({
            title: "Active book",
            lastAccessed: 100,
            bookmarkCount: 1,
            lastBookmarked: 200,
            bookmarks: [{ cfi: "saved-place", pageNumber: 12, createdAt: 200 }],
          }),
        ],
        reload,
      },
      vi.fn(),
      mutate,
    );
    const accessDelete = screen.getByRole("button", {
      name: "Delete recent access",
    });
    const bookmarkDelete = screen.getByRole("button", {
      name: "Delete bookmark",
    });

    await userEvent.click(accessDelete);
    fireEvent.click(bookmarkDelete);

    expect(mutate).toHaveBeenCalledOnce();
    expect(screen.getByTestId("library-operation-surface")).toHaveAttribute("inert");
    expect(document.querySelector(".library-operation-blocker")).not.toBeNull();
    expect(libraryToast()).toHaveTextContent("Deleting recent access: Active book");
    expect(libraryToast()).toHaveTextContent("Saving encrypted library");

    await act(async () => completions[0]());
    await waitFor(() =>
      expect(libraryToast()).toHaveTextContent("Recent access deleted"),
    );
    expect(screen.getByTestId("library-operation-surface")).not.toHaveAttribute(
      "inert",
    );

    await userEvent.click(bookmarkDelete);
    expect(libraryToast()).toHaveTextContent("Deleting bookmark: Active book");
    expect(libraryToast()).toHaveTextContent("Saving encrypted library");
    expect(screen.getByTestId("library-operation-surface")).toHaveAttribute("inert");

    await act(async () => completions[1]());
    await waitFor(() => expect(libraryToast()).toHaveTextContent("Bookmark deleted"));

    expect(mutate.mock.calls.map(([mutation]) => mutation.description)).toEqual([
      "clear last access",
      "delete bookmark",
    ]);
    expect(accessDelete.querySelector("svg")).not.toBeNull();
    expect(bookmarkDelete.querySelector("svg")).not.toBeNull();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it("shows the bookmark deletion action on hover", async () => {
    renderScreen([
      book({
        title: "Marked book",
        bookmarkCount: 1,
        lastBookmarked: 200,
        bookmarks: [{ cfi: "marked-place", pageNumber: 6, createdAt: 200 }],
      }),
    ]);
    const remove = screen.getByRole("button", {
      name: "Delete bookmark",
    });
    await userEvent.hover(remove);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Delete bookmark");
    expect(remove).toHaveClass(
      "btn-circle",
      "compact-x-button",
      "compact-delete-button",
      "book-row-remove",
    );
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
    expect(fantasyRow).toHaveClass("rounded-box");
    expect(fantasyRow.querySelector(".badge")).toHaveClass("bg-base-200", "font-bold");
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

    const lockButton = screen.getByRole("button", { name: "Lock" });
    expect(lockButton).toHaveClass("btn-square");
    await userEvent.click(lockButton);

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
    expect(trigger).toHaveClass("btn-square");
    expect(trigger).not.toHaveClass("dropdown-toggle");
    expect(trigger).toHaveTextContent("");
    expect(screen.queryByText("Skypiea")).not.toBeInTheDocument();

    await userEvent.click(trigger);

    const menu = screen.getByRole("dialog", { name: "Library menu" });
    expect(menu).toHaveClass("library-dropdown-dialog");
    expect(menu.parentElement).toHaveClass("library-dropdown", "py-1");
    expect(within(menu).getByRole("button", { name: /^Recent/ })).toHaveClass(
      "btn",
      "btn-active",
    );
    expect(within(menu).getByRole("button", { name: /^Recent/ })).not.toHaveClass(
      "rounded-box",
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

function libraryToast(): HTMLElement {
  const toast = document.querySelector<HTMLElement>(".library-toast");
  if (!toast) throw new Error("library toast is missing");
  return toast;
}
