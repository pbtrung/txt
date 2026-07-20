// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ReaderScreen } from "./ReaderScreen";
import * as useReaderBookModule from "./useReaderBook";
import type { UseReaderBookResult } from "./useReaderBook";

vi.mock("./useReaderBook", () => ({ useReaderBook: vi.fn() }));

function baseResult(overrides: Partial<UseReaderBookResult> = {}): UseReaderBookResult {
  return {
    loading: false,
    error: null,
    info: {
      txtId: 1,
      name: "white-order.epub.txt",
      title: "The White Order",
      author: "L. E. Modesitt, Jr.",
      subjects: ["Fantasy", "Military"],
      publisher: "Tor Publishing Group",
      series: "Saga of Recluce",
      seriesIndex: "8",
      description: "...continues his bestselling fantasy series",
    },
    partCount: 41,
    currentPartNum: 14,
    partText: "First paragraph of part 14.\n\nSecond paragraph.",
    partTextLoading: false,
    bookmarks: [
      { id: 3, partNum: 14, createdAtMs: Date.now() - 1000 },
      { id: 2, partNum: 8, createdAtMs: Date.now() - 2 * 24 * 60 * 60 * 1000 },
    ],
    goToPart: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    bookmarkCurrentPart: vi.fn(),
    ...overrides,
  };
}

function renderReader(result: UseReaderBookResult) {
  vi.mocked(useReaderBookModule.useReaderBook).mockReturnValue(result);
  return render(
    <MemoryRouter initialEntries={["/read/1"]}>
      <Routes>
        <Route path="/read/:txtId" element={<ReaderScreen />} />
        <Route path="/library" element={<div>Library screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ReaderScreen", () => {
  it("renders the current part's text, split into paragraphs", () => {
    renderReader(baseResult());
    expect(screen.getByText("First paragraph of part 14.")).toBeInTheDocument();
    expect(screen.getByText("Second paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Part 14 of 41")).toBeInTheDocument();
  });

  it("shows the About-this-book panel with series and subjects", () => {
    renderReader(baseResult());
    expect(screen.getByText("Saga of Recluce, #8")).toBeInTheDocument();
    expect(screen.getByText("Fantasy")).toBeInTheDocument();
    expect(screen.getByText("Military")).toBeInTheDocument();
  });

  it("shows bookmarks most-recent-first with relative times", () => {
    renderReader(baseResult());
    expect(screen.getByText("Part 14")).toBeInTheDocument();
    expect(screen.getByText("Just now")).toBeInTheDocument();
    expect(screen.getByText("Part 8")).toBeInTheDocument();
    expect(screen.getByText("2 days ago")).toBeInTheDocument();
  });

  it("hides the side panel when the info button is toggled off", async () => {
    renderReader(baseResult());
    await userEvent.click(screen.getByRole("button", { name: /about this book/i }));
    expect(screen.queryByText("Saga of Recluce, #8")).not.toBeInTheDocument();
  });

  it("disables Previous on the first part and Next on the last", () => {
    renderReader(baseResult({ currentPartNum: 1, partCount: 1 }));
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("calls next()/previous() when their buttons are clicked", async () => {
    const next = vi.fn();
    const previous = vi.fn();
    renderReader(baseResult({ next, previous }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /previous/i }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it("calls bookmarkCurrentPart() when the bookmark button is clicked", async () => {
    const bookmarkCurrentPart = vi.fn();
    renderReader(baseResult({ bookmarks: [], bookmarkCurrentPart }));
    await userEvent.click(screen.getByRole("button", { name: /bookmark this part/i }));
    expect(bookmarkCurrentPart).toHaveBeenCalledTimes(1);
  });

  it("navigates back to /library", async () => {
    renderReader(baseResult());
    await userEvent.click(screen.getByRole("button", { name: /library/i }));
    expect(await screen.findByText("Library screen")).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    renderReader(baseResult({ loading: true }));
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an error state", () => {
    renderReader(baseResult({ error: "boom" }));
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });
});
