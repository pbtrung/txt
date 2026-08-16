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
import { useVault, type VaultSession } from "../../../src/state/VaultContext";
import { LibraryScreen } from "../../../src/screens/Library/LibraryScreen";
import { useLibraryBooks } from "../../../src/screens/Library/useLibraryBooks";

function book(overrides: Partial<LibraryBook>): LibraryBook {
  return {
    txtId: 1,
    title: "Untitled",
    sortKey: null,
    authors: [],
    subjects: [],
    publisher: null,
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

function renderScreen(books: LibraryBook[] | null) {
  const session = { db: {} } as VaultSession;
  vi.mocked(useVault).mockReturnValue({
    status: "unlocked",
    session,
    error: null,
    progress: null,
    unlock: vi.fn(),
    lock: vi.fn(),
  });
  vi.mocked(useLibraryBooks).mockReturnValue(books);
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

  it("lists every book once loaded", () => {
    renderScreen(LIBRARY);
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

  it("filters by clicking a browse entry, and clears on a second click", async () => {
    renderScreen(LIBRARY);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Fantasy/ }));
    expect(screen.getByRole("link", { name: /Wizard/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Dune/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Fantasy/ }));
    expect(screen.getByRole("link", { name: /Dune/ })).toBeInTheDocument();
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

  it("shows a clearable chip while a browse filter is active", async () => {
    renderScreen(LIBRARY);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Fantasy/ }));

    expect(screen.getByText(/subject: Fantasy/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(screen.queryByText(/subject: Fantasy/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Dune/ })).toBeInTheDocument();
  });

  it("links each book to /read/:txtId", () => {
    renderScreen(LIBRARY);
    expect(screen.getByRole("link", { name: /Dune/ })).toHaveAttribute(
      "href",
      "/read/1",
    );
  });

  it("the Browse button opens the browse drawer", async () => {
    renderScreen(LIBRARY);
    expect(screen.getByRole("dialog", { name: "Browse" })).not.toHaveClass("show");

    await userEvent.click(screen.getByRole("button", { name: "Browse" }));

    expect(screen.getByRole("dialog", { name: "Browse" })).toHaveClass("show");
  });
});
