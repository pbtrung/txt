// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
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
      { partNum: 14, line: 1, txtPreview: "First paragraph of part 14.", createdAt: 3000 },
      { partNum: 8, line: 2, txtPreview: "Some earlier line preview", createdAt: 2000 },
    ],
    targetLine: null,
    clearTargetLine: vi.fn(),
    goToPart: vi.fn(),
    goToBookmark: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    bookmarkLine: vi.fn(),
    removeBookmark: vi.fn(),
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
  it("renders the current part's text, split into lines", () => {
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

  it("renders HTML formatting in the description (e.g. Calibre-style OPF markup)", () => {
    renderReader(baseResult({ info: { ...baseResult().info!, description: "<b>Bold</b> and <i>italic</i> text." } }));
    const bold = screen.getByText("Bold");
    expect(bold.tagName).toBe("B");
    const italic = screen.getByText("italic");
    expect(italic.tagName).toBe("I");
  });

  it("sanitizes a malicious description instead of executing it", () => {
    renderReader(
      baseResult({
        info: { ...baseResult().info!, description: '<img src=x onerror="window.__pwned__=true">Safe text<script>window.__pwned__=true</script>' },
      }),
    );
    expect(screen.getByText("Safe text")).toBeInTheDocument();
    expect((window as unknown as { __pwned__?: boolean }).__pwned__).toBeUndefined();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows bookmarks with part/line and a text preview", () => {
    renderReader(baseResult());
    expect(screen.getByText("Part 14 · Line 1")).toBeInTheDocument();
    expect(screen.getByText("“First paragraph of part 14.”")).toBeInTheDocument();
    expect(screen.getByText("Part 8 · Line 2")).toBeInTheDocument();
    expect(screen.getByText("“Some earlier line preview”")).toBeInTheDocument();
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

  it("bookmarks a specific line via that line's own gutter button", async () => {
    const bookmarkLine = vi.fn();
    renderReader(baseResult({ bookmarks: [], bookmarkLine }));
    await userEvent.click(screen.getByRole("button", { name: /bookmark line 2/i }));
    expect(bookmarkLine).toHaveBeenCalledWith(2, "Second paragraph.");
  });

  it("marks an already-bookmarked line's gutter icon as pressed", () => {
    renderReader(baseResult());
    expect(screen.getByRole("button", { name: /bookmark line 1/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /bookmark line 2/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("jumps to a bookmark's exact part and line when it's clicked", async () => {
    const goToBookmark = vi.fn();
    renderReader(baseResult({ goToBookmark }));
    await userEvent.click(screen.getByText("Part 8 · Line 2"));
    expect(goToBookmark).toHaveBeenCalledWith(8, 2);
  });

  it("removes a bookmark via its delete button, without jumping to it", async () => {
    const goToBookmark = vi.fn();
    const removeBookmark = vi.fn();
    renderReader(baseResult({ goToBookmark, removeBookmark }));
    const row = screen.getByText("Part 8 · Line 2").closest('[role="button"]') as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /remove this bookmark/i }));
    expect(removeBookmark).toHaveBeenCalledWith(2000);
    expect(goToBookmark).not.toHaveBeenCalled();
  });

  it("scrolls to and briefly highlights the target line once its text is ready", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderReader(baseResult({ targetLine: 1 }));
    expect(scrollIntoView).toHaveBeenCalled();
    const lineEl = screen.getByText("First paragraph of part 14.").closest(".reader-line");
    expect(lineEl).toHaveClass("is-highlighted");
  });

  it("navigates back to /library", async () => {
    renderReader(baseResult());
    await userEvent.click(screen.getByRole("button", { name: /library/i }));
    expect(await screen.findByText("Library screen")).toBeInTheDocument();
  });

  it("shows a spinner in the reading pane while loading, but keeps the rest of the chrome", () => {
    renderReader(baseResult({ loading: true }));
    expect(screen.getByRole("status")).toBeInTheDocument();
    // The top bar (back-to-library, book title fallback) renders right away
    // instead of being replaced by a full-page loading screen.
    expect(screen.getByRole("button", { name: /library/i })).toBeInTheDocument();
    expect(screen.queryByText("First paragraph of part 14.")).not.toBeInTheDocument();
  });

  it("shows a spinner in the reading pane while a part is (re)loading", () => {
    renderReader(baseResult({ partTextLoading: true, partText: null }));
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an error state", () => {
    renderReader(baseResult({ error: "boom" }));
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });
});
