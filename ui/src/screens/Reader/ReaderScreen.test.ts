// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/vue";
import userEvent from "@testing-library/user-event";
import { defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter, RouterView, type Router } from "vue-router";
import { describe, expect, it, vi } from "vitest";

import type { UseReaderBookResult } from "./composables/useReaderBook";

vi.mock("./composables/useReaderBook", () => ({ useReaderBook: vi.fn() }));

import ReaderScreen from "./ReaderScreen.vue";
import * as useReaderBookModule from "./composables/useReaderBook";

// Loosely typed on purpose -- overrides swap in plain ref()s in place of
// fields the real composable exposes as ComputedRef (info, bookmarks, ...),
// which is fine for a mock but not structurally assignable to
// Partial<UseReaderBookResult> itself.
function refResult(overrides: Record<string, unknown> = {}): UseReaderBookResult {
  return {
    loading: ref(false),
    error: ref(null),
    info: ref({
      txtId: 1,
      name: "white-order.epub.txt",
      title: "The White Order",
      author: "L. E. Modesitt, Jr.",
      subjects: ["Fantasy", "Military"],
      publisher: "Tor Publishing Group",
      series: "Saga of Recluce",
      seriesIndex: "8",
      description: "...continues his bestselling fantasy series",
      rawMetadata: [
        { key: "title", values: ["The White Order"] },
        { key: "creator", values: ["L. E. Modesitt, Jr."] },
        { key: "date", values: ["1998-01-01"] },
        { key: "language", values: ["en"] },
      ],
    }),
    partCount: ref(41),
    currentPartNum: ref(14),
    partText: ref("First paragraph of part 14.\n\nSecond paragraph."),
    partTextLoading: ref(false),
    bookmarks: ref([
      { partNum: 14, line: 1, txtPreview: "First paragraph of part 14.", createdAt: 3000 },
      { partNum: 8, line: 2, txtPreview: "Some earlier line preview", createdAt: 2000 },
    ]),
    targetLine: ref(null),
    clearTargetLine: vi.fn(),
    goToPart: vi.fn(),
    goToBookmark: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    bookmarkLine: vi.fn(),
    removeBookmark: vi.fn(),
    ...overrides,
  } as unknown as UseReaderBookResult;
}

const LibraryStub = defineComponent({ setup: () => () => h("div", "Library screen") });

function createTestRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/read/:txtId", component: ReaderScreen },
      { path: "/library", component: LibraryStub },
    ],
  });
}

async function renderReader(result: UseReaderBookResult) {
  vi.mocked(useReaderBookModule.useReaderBook).mockReturnValue(result);
  const router = createTestRouter();
  await router.push("/read/1");
  const AppStub = defineComponent({ setup: () => () => h(RouterView) });
  return render(AppStub, { global: { plugins: [router] } });
}

async function openInfo() {
  await userEvent.click(screen.getByRole("button", { name: /about this book/i }));
}

async function openBookmarks() {
  await userEvent.click(screen.getByRole("button", { name: /^bookmarks$/i }));
}

describe("ReaderScreen", () => {
  it("shows an icon-only back button, no 'Library' text", async () => {
    await renderReader(refResult());
    const back = screen.getByRole("button", { name: /library/i });
    expect(back).toHaveAccessibleName("Back to library");
    expect(back).not.toHaveTextContent("Library");
  });

  it("renders the author as a dedicated line for small screens, alongside the inline version for larger ones", async () => {
    await renderReader(refResult());
    const mobileAuthor = document.querySelector(".d-sm-none");
    expect(mobileAuthor).toHaveTextContent("L. E. Modesitt, Jr.");
  });

  it("uses small (btn-sm) Previous/Next buttons, matching the top bar's buttons", async () => {
    await renderReader(refResult());
    expect(screen.getByRole("button", { name: /previous/i })).toHaveClass("btn-sm");
    expect(screen.getByRole("button", { name: /next/i })).toHaveClass("btn-sm");
  });

  describe("font size", () => {
    function fontSizeSelect() {
      return screen.getByRole("combobox", { name: /font size/i });
    }

    it("offers 14/16/18/20/22/24px, defaulting to 16px", async () => {
      await renderReader(refResult());
      const select = fontSizeSelect();
      expect(select).toHaveValue("16");
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "14px",
        "16px",
        "18px",
        "20px",
        "22px",
        "24px",
      ]);
    });

    it("adapts the reading column's max-width in ch, not a fixed pixel value, so line length stays ~70 characters at any font size", async () => {
      await renderReader(refResult());
      const line = screen.getByText("First paragraph of part 14.").closest(".reader-font") as HTMLElement;
      expect(line.style.maxWidth).toBe("70ch");
    });

    it("sits to the left of the Previous button in the bottom bar", async () => {
      await renderReader(refResult());
      const select = fontSizeSelect();
      const previous = screen.getByRole("button", { name: /previous/i });
      expect(select.compareDocumentPosition(previous) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("resizes the reading pane's text when changed", async () => {
      await renderReader(refResult());
      const line = screen.getByText("First paragraph of part 14.").closest(".reader-font") as HTMLElement;
      expect(line.style.fontSize).toBe("16px");

      await userEvent.selectOptions(fontSizeSelect(), "24");
      expect(line.style.fontSize).toBe("24px");
    });
  });

  describe("editable part number", () => {
    it("shows the current part number and total", async () => {
      await renderReader(refResult());
      expect(screen.getByRole("textbox", { name: /go to part/i })).toHaveValue("14");
      expect(screen.getByText("/ 41")).toBeInTheDocument();
    });

    it("jumps to a typed part number on Enter", async () => {
      const goToPart = vi.fn();
      await renderReader(refResult({ goToPart }));
      const input = screen.getByRole("textbox", { name: /go to part/i });
      await userEvent.clear(input);
      await userEvent.type(input, "7{Enter}");
      expect(goToPart).toHaveBeenCalledWith(7);
    });

    it("jumps on blur too", async () => {
      const goToPart = vi.fn();
      await renderReader(refResult({ goToPart }));
      const input = screen.getByRole("textbox", { name: /go to part/i });
      await userEvent.clear(input);
      await userEvent.type(input, "3");
      await userEvent.click(document.body);
      expect(goToPart).toHaveBeenCalledWith(3);
    });

    it("resets to the current part instead of jumping when cleared to nothing", async () => {
      const goToPart = vi.fn();
      await renderReader(refResult({ goToPart }));
      const input = screen.getByRole("textbox", { name: /go to part/i });
      await userEvent.clear(input);
      await userEvent.click(document.body);
      expect(goToPart).not.toHaveBeenCalled();
      expect(input).toHaveValue("14");
    });

    it("strips non-digits and caps at partCount's own digit count while typing", async () => {
      await renderReader(refResult()); // partCount: 41 -> 2 digits
      const input = screen.getByRole("textbox", { name: /go to part/i });
      await userEvent.clear(input);
      await userEvent.type(input, "12a34b5");
      expect(input).toHaveValue("12");
    });

    it("widens the cap to match a 3-digit partCount", async () => {
      await renderReader(refResult({ partCount: ref(641) }));
      const input = screen.getByRole("textbox", { name: /go to part/i });
      await userEvent.clear(input);
      await userEvent.type(input, "12a34b5");
      expect(input).toHaveValue("123");
    });
  });

  it("renders the current part's text, split into lines", async () => {
    await renderReader(refResult());
    expect(screen.getByText("First paragraph of part 14.")).toBeInTheDocument();
    expect(screen.getByText("Second paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Part 14 of 41")).toBeInTheDocument();
  });

  describe("About this book dropdown", () => {
    it("is closed by default", async () => {
      await renderReader(refResult());
      expect(screen.queryByText("Saga of Recluce, #8")).not.toBeInTheDocument();
    });

    it("opens on click, showing series and subjects, and closes on a second click", async () => {
      await renderReader(refResult());
      await openInfo();
      expect(screen.getByText("Saga of Recluce, #8")).toBeInTheDocument();
      expect(screen.getByText("Fantasy")).toBeInTheDocument();
      expect(screen.getByText("Military")).toBeInTheDocument();

      await openInfo();
      expect(screen.queryByText("Saga of Recluce, #8")).not.toBeInTheDocument();
    });

    it("closes when clicking outside it", async () => {
      await renderReader(refResult());
      await openInfo();
      expect(screen.getByText("Saga of Recluce, #8")).toBeInTheDocument();

      await userEvent.click(screen.getByText("First paragraph of part 14."));
      expect(screen.queryByText("Saga of Recluce, #8")).not.toBeInTheDocument();
    });

    it("closes on Escape", async () => {
      await renderReader(refResult());
      await openInfo();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByText("Saga of Recluce, #8")).not.toBeInTheDocument();
    });

    it("renders HTML formatting in a short description (e.g. Calibre-style OPF markup)", async () => {
      const base = refResult();
      await renderReader(
        refResult({ info: ref({ ...base.info.value!, description: "<b>Bold</b> and <i>italic</i> text." }) }),
      );
      await openInfo();
      const bold = screen.getByText("Bold");
      expect(bold.tagName).toBe("B");
      const italic = screen.getByText("italic");
      expect(italic.tagName).toBe("I");
    });

    it("sanitizes a malicious description instead of executing it", async () => {
      const base = refResult();
      await renderReader(
        refResult({
          info: ref({
            ...base.info.value!,
            description: '<img src=x onerror="window.__pwned__=true">Safe text<script>window.__pwned__=true</script>',
          }),
        }),
      );
      await openInfo();
      expect(screen.getByText("Safe text")).toBeInTheDocument();
      expect((window as unknown as { __pwned__?: boolean }).__pwned__).toBeUndefined();
      expect(document.querySelector("script")).toBeNull();
      expect(document.querySelector("img")).toBeNull();
    });

    it("truncates a long description to 200 characters with a Show more button", async () => {
      const longDescription = "A".repeat(250);
      const base = refResult();
      await renderReader(refResult({ info: ref({ ...base.info.value!, description: longDescription }) }));
      await openInfo();

      expect(screen.getByText(`${"A".repeat(200)}…`)).toBeInTheDocument();
      expect(screen.queryByText(longDescription)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /show more/i }));
      expect(screen.getByText(longDescription)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /show less/i }));
      expect(screen.queryByText(longDescription)).not.toBeInTheDocument();
    });

    it("doesn't show a Show more button for a short description", async () => {
      await renderReader(refResult());
      await openInfo();
      expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
    });

    it("shows every raw metadata field from the catalog entry, not just the curated summary", async () => {
      await renderReader(refResult());
      await openInfo();
      expect(screen.getByText("All metadata")).toBeInTheDocument();
      expect(screen.getByText("date")).toBeInTheDocument();
      expect(screen.getByText("1998-01-01")).toBeInTheDocument();
      expect(screen.getByText("language")).toBeInTheDocument();
      expect(screen.getByText("en")).toBeInTheDocument();
    });

    it("hides the 'All metadata' section entirely when there's none to show", async () => {
      const base = refResult();
      await renderReader(refResult({ info: ref({ ...base.info.value!, rawMetadata: [] }) }));
      await openInfo();
      expect(screen.queryByText("All metadata")).not.toBeInTheDocument();
    });
  });

  describe("Bookmarks dropdown", () => {
    it("is closed by default", async () => {
      await renderReader(refResult());
      expect(screen.queryByText("Part 14 · Line 1")).not.toBeInTheDocument();
    });

    it("opens upward (it's anchored in the bottom bar, not the top bar)", async () => {
      await renderReader(refResult());
      await openBookmarks();
      const menu = screen.getByText("Part 14 · Line 1").closest(".dropdown-menu");
      expect(menu).toHaveClass("app-dropdown-menu-up");
    });

    it("shows the filled icon when the book has bookmarks", async () => {
      await renderReader(refResult());
      expect(document.querySelector(".bi-bookmark-fill")).toBeInTheDocument();
    });

    it("shows the outline icon when the book has no bookmarks", async () => {
      await renderReader(refResult({ bookmarks: ref([]) }));
      expect(document.querySelector(".bi-bookmark-fill")).not.toBeInTheDocument();
    });

    it("opens on click, showing part/line and a text preview", async () => {
      await renderReader(refResult());
      await openBookmarks();
      expect(screen.getByText("Part 14 · Line 1")).toBeInTheDocument();
      expect(screen.getByText("“First paragraph of part 14.”")).toBeInTheDocument();
      expect(screen.getByText("Part 8 · Line 2")).toBeInTheDocument();
      expect(screen.getByText("“Some earlier line preview”")).toBeInTheDocument();
    });

    it("opening it closes an already-open info dropdown, and vice versa", async () => {
      await renderReader(refResult());
      await openInfo();
      expect(screen.getByText("Saga of Recluce, #8")).toBeInTheDocument();

      await openBookmarks();
      expect(screen.queryByText("Saga of Recluce, #8")).not.toBeInTheDocument();
      expect(screen.getByText("Part 14 · Line 1")).toBeInTheDocument();
    });

    it("jumps to a bookmark's exact part and line when it's clicked", async () => {
      const goToBookmark = vi.fn();
      await renderReader(refResult({ goToBookmark }));
      await openBookmarks();
      await userEvent.click(screen.getByText("Part 8 · Line 2"));
      expect(goToBookmark).toHaveBeenCalledWith(8, 2);
    });

    it("removes a bookmark via its delete button, without jumping to it", async () => {
      const goToBookmark = vi.fn();
      const removeBookmark = vi.fn();
      await renderReader(refResult({ goToBookmark, removeBookmark }));
      await openBookmarks();
      const row = screen.getByText("Part 8 · Line 2").closest('[role="button"]') as HTMLElement;
      await userEvent.click(within(row).getByRole("button", { name: /remove this bookmark/i }));
      expect(removeBookmark).toHaveBeenCalledWith(2000);
      expect(goToBookmark).not.toHaveBeenCalled();
    });
  });

  it("disables Previous on the first part and Next on the last", async () => {
    await renderReader(refResult({ currentPartNum: ref(1), partCount: ref(1) }));
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("calls next()/previous() when their buttons are clicked", async () => {
    const next = vi.fn();
    const previous = vi.fn();
    await renderReader(refResult({ next, previous }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /previous/i }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it("bookmarks a specific line via that line's own gutter button", async () => {
    const bookmarkLine = vi.fn();
    await renderReader(refResult({ bookmarks: ref([]), bookmarkLine }));
    await userEvent.click(screen.getByRole("button", { name: /bookmark line 2/i }));
    expect(bookmarkLine).toHaveBeenCalledWith(2, "Second paragraph.");
  });

  it("marks an already-bookmarked line's gutter icon as pressed", async () => {
    await renderReader(refResult());
    expect(screen.getByRole("button", { name: /bookmark line 1/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /bookmark line 2/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("scrolls to the target line once its text is ready", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderReader(refResult({ targetLine: ref(1) }));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("clears the target line once it's been scrolled to", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const clearTargetLine = vi.fn();
    await renderReader(refResult({ targetLine: ref(1), clearTargetLine }));
    expect(clearTargetLine).toHaveBeenCalled();
  });

  it("navigates back to /library", async () => {
    await renderReader(refResult());
    await userEvent.click(screen.getByRole("button", { name: /library/i }));
    expect(await screen.findByText("Library screen")).toBeInTheDocument();
  });

  it('shows "-" instead of 0 for the part box/total on first load, before partCount is known', async () => {
    await renderReader(refResult({ loading: ref(true), partCount: ref(0), currentPartNum: ref(1) }));
    const input = screen.getByRole("textbox", { name: /go to part/i });
    expect(input).toHaveValue("-");
    expect(input).toBeDisabled();
    expect(screen.getByText("/ -")).toBeInTheDocument();
  });

  it("shows a spinner in the reading pane while loading, but keeps the rest of the chrome", async () => {
    await renderReader(refResult({ loading: ref(true) }));
    expect(screen.getByRole("status")).toBeInTheDocument();
    // The top bar (back-to-library, book title fallback) renders right away
    // instead of being replaced by a full-page loading screen.
    expect(screen.getByRole("button", { name: /library/i })).toBeInTheDocument();
    expect(screen.queryByText("First paragraph of part 14.")).not.toBeInTheDocument();
  });

  it("shows a spinner in the reading pane while a part is (re)loading", async () => {
    await renderReader(refResult({ partTextLoading: ref(true), partText: ref(null) }));
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an error state with a way back to the library", async () => {
    await renderReader(refResult({ error: ref("boom") }));
    expect(screen.getByRole("alert")).toHaveTextContent("boom");

    await userEvent.click(screen.getByRole("button", { name: /back to library/i }));
    expect(screen.getByText("Library screen")).toBeInTheDocument();
  });
});
