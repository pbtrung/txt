// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { LibraryScreen } from "./LibraryScreen";
import * as VaultContextModule from "../../state/VaultContext";
import * as useLibraryBooksModule from "./useLibraryBooks";
import type { LibraryBook } from "./libraryModel";

vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<typeof import("../../state/VaultContext")>("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});
vi.mock("./useLibraryBooks", () => ({ useLibraryBooks: vi.fn() }));

function book(overrides: Partial<LibraryBook> & { txtId: number }): LibraryBook {
  return {
    info: { txtId: overrides.txtId, name: `n${overrides.txtId}`, title: `Title ${overrides.txtId}`, subjects: [] },
    partCount: 10,
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
    },
    partCount: 41,
    lastPartNum: 14,
    lastAccessedMs: 2000,
  }),
  book({
    txtId: 2,
    info: { txtId: 2, name: "n2", title: "21 Lessons for the 21st Century", author: "Yuval Noah Harari", subjects: ["History"] },
    partCount: 29,
    lastPartNum: 18,
    lastAccessedMs: 3000,
  }),
  book({
    txtId: 3,
    info: { txtId: 3, name: "n3", title: "Never Opened Yet", subjects: [] },
    partCount: 5,
  }),
];

function CurrentPath() {
  const location = useLocation();
  return <div>Reader for {location.pathname}</div>;
}

function renderLibrary() {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session: null,
    error: null,
    unlock: vi.fn(),
    lock: vi.fn(),
    getTxtKey: vi.fn(),
  });
  vi.mocked(useLibraryBooksModule.useLibraryBooks).mockReturnValue({ books, error: null, loading: false });

  return render(
    <MemoryRouter initialEntries={["/library"]}>
      <Routes>
        <Route path="/library" element={<LibraryScreen />} />
        <Route path="/read/:txtId" element={<CurrentPath />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LibraryScreen", () => {
  it("defaults to the Recent view, most recently opened first", () => {
    renderLibrary();
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    const rows = screen.getAllByRole("button", { name: /Title|21 Lessons|White Order/ });
    expect(rows[0]).toHaveTextContent("21 Lessons for the 21st Century");
    expect(rows[1]).toHaveTextContent("The White Order");
    // "Never Opened Yet" has no read position, so it shouldn't appear in Recent.
    expect(screen.queryByText("Never Opened Yet")).not.toBeInTheDocument();
  });

  it("shows every book, alphabetically, under All books", async () => {
    renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    expect(screen.getByText("21 Lessons for the 21st Century")).toBeInTheDocument();
    expect(screen.getByText("Never Opened Yet")).toBeInTheDocument();
    expect(screen.getByText("The White Order")).toBeInTheDocument();
  });

  it("shows an unstarted book's part count instead of a progress bar", async () => {
    renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    expect(screen.getByText("5 parts")).toBeInTheDocument();
  });

  it("drills into Authors, then filters by the chosen author", async () => {
    renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /Authors/ }));
    expect(screen.getByText("L. E. Modesitt, Jr.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /L\. E\. Modesitt/ }));
    expect(screen.getByText("The White Order")).toBeInTheDocument();
    expect(screen.queryByText("21 Lessons for the 21st Century")).not.toBeInTheDocument();
  });

  it("filters the current book list by the search query", async () => {
    renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: /All books/ }));
    await userEvent.type(screen.getByLabelText(/search your library/i), "fantasy");
    expect(screen.getByText("The White Order")).toBeInTheDocument();
    expect(screen.queryByText("21 Lessons for the 21st Century")).not.toBeInTheDocument();
  });

  it("navigates to the reader when a book is clicked", async () => {
    renderLibrary();
    await userEvent.click(screen.getByText("The White Order"));
    await waitFor(() => expect(screen.getByText(/Reader for \/read\/1/)).toBeInTheDocument());
  });
});
