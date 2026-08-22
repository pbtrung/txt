// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/state/VaultContext", () => ({ useVault: vi.fn() }));
vi.mock("../../../src/screens/Reader/useReaderDocument", () => ({
  useReaderDocument: vi.fn(),
}));
vi.mock("../../../src/screens/Reader/useReadingState", () => ({
  useReadingState: vi.fn(() => ({
    bookmarks: [],
    bookmarkBusy: false,
    currentSaved: false,
    toggleCurrent: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
    databaseStatus: { pending: false, unsaved: false, error: null },
    error: null,
  })),
}));
vi.mock("../../../src/data/epubRenderer", () => ({
  EpubRenderer: vi.fn().mockImplementation(function () {
    return {
      renderTo: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      prev: vi.fn().mockResolvedValue(undefined),
      next: vi.fn().mockResolvedValue(undefined),
      displayPage: vi.fn().mockResolvedValue(undefined),
      onKeyup: vi.fn(),
      onPageChange: vi.fn(),
      onLocationChange: vi.fn(),
      currentBookmark: vi.fn().mockReturnValue({
        cfi: "epubcfi(/6/2)",
        preview: "Fear is the mind-killer.",
      }),
      setFontSize: vi.fn(),
      setColumns: vi.fn(),
      getToc: vi.fn().mockResolvedValue([]),
    };
  }),
}));

import { EpubRenderer } from "../../../src/data/epubRenderer";
import { useVault, type VaultSession } from "../../../src/state/VaultContext";
import { ReaderScreen } from "../../../src/screens/Reader/ReaderScreen";
import { useReaderDocument } from "../../../src/screens/Reader/useReaderDocument";
import { useReadingState } from "../../../src/screens/Reader/useReadingState";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mockVault() {
  vi.mocked(useVault).mockReturnValue({
    status: "unlocked",
    session: {} as VaultSession,
    error: null,
    progress: null,
    unlock: vi.fn(),
    lock: vi.fn(),
  });
}

function mockReadyDocument(overrides: Record<string, unknown> = {}) {
  vi.mocked(useReaderDocument).mockReturnValue({
    status: "ready",
    document: {
      txtId: 1,
      lastCfi: null,
      title: "Dune",
      authors: ["Frank Herbert"],
      subjects: ["Science Fiction"],
      publisher: "Ace",
      extraMetadata: [],
      epubBytes: new Uint8Array([1, 2, 3]),
      ...overrides,
    },
    error: null,
  });
}

function renderScreen(initialEntry = "/read/1") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/read/:txtId" element={<ReaderScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ReaderScreen", () => {
  it("shows a loading message", () => {
    mockVault();
    vi.mocked(useReaderDocument).mockReturnValue({
      status: "loading",
      document: null,
      error: null,
      progress: { label: "Downloading text", step: 2, total: 5 },
    });
    renderScreen();
    expect(screen.getByText(/Opening your book/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Downloading text (step 2 of 5)",
    );
  });

  it("shows a not-found message", () => {
    mockVault();
    vi.mocked(useReaderDocument).mockReturnValue({
      status: "not-found",
      document: null,
      error: null,
    });
    renderScreen();
    expect(screen.getByText(/could not be found/)).toBeInTheDocument();
  });

  it("shows an error message", () => {
    mockVault();
    vi.mocked(useReaderDocument).mockReturnValue({
      status: "error",
      document: null,
      error: "boom",
    });
    renderScreen();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("boom");
    expect(alert).toHaveClass("text-sm", "my-2", "py-2", "px-3");
    expect(alert.parentElement).toHaveClass(
      "reader-width",
      "reader-column",
      "p-2",
      "md:p-0",
    );
  });

  it("renders the document's title and mounts EpubRenderer", () => {
    mockVault();
    mockReadyDocument();
    renderScreen();

    expect(
      screen.getByRole("heading", {
        name: "Dune — Frank Herbert",
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(vi.mocked(EpubRenderer)).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "Dune",
      ["Frank Herbert"],
    );
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      renderTo: (host: HTMLElement, cfi: string | null) => Promise<void>;
    };
    expect(instance.renderTo).toHaveBeenCalledWith(expect.any(HTMLElement), null);
  });

  it("keeps EPUB text hidden until font layout is ready", async () => {
    mockVault();
    mockReadyDocument();
    const { container } = renderScreen();
    const host = container.querySelector(".reader-epub-host");

    expect(host).toHaveClass("invisible");
    expect(screen.getByText("Preparing your book…")).toBeInTheDocument();

    await waitFor(() => expect(host).not.toHaveClass("invisible"));
    expect(screen.queryByText("Preparing your book…")).not.toBeInTheDocument();
  });

  it("passes the saved CFI to the renderer when reopening a book", () => {
    mockVault();
    mockReadyDocument({ lastCfi: "epubcfi(/6/4!/4/2)" });
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      renderTo: (host: HTMLElement, cfi: string | null) => Promise<void>;
    };

    expect(instance.renderTo).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      "epubcfi(/6/4!/4/2)",
    );
  });

  it("prefers a bookmark CFI from the library route", () => {
    mockVault();
    mockReadyDocument({ lastCfi: "epubcfi(/6/4!/4/2)" });
    renderScreen("/read/1?cfi=epubcfi%28%2F6%2F8%29");
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      renderTo: (host: HTMLElement, cfi: string | null) => Promise<void>;
    };

    expect(instance.renderTo).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      "epubcfi(/6/8)",
    );
  });

  it("destroys the renderer on unmount", () => {
    mockVault();
    mockReadyDocument();
    const { unmount } = renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      destroy: () => void;
    };

    unmount();

    expect(instance.destroy).toHaveBeenCalled();
  });

  it("Prev/Next buttons call the renderer", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      prev: () => void;
      next: () => void;
    };

    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(instance.prev).toHaveBeenCalledTimes(1);
    expect(instance.next).toHaveBeenCalledTimes(1);
  });

  it("applies the default (desktop) font size on mount", () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      setFontSize: (size: string) => void;
    };

    expect(instance.setFontSize).toHaveBeenCalledWith("18px");
  });

  it("keeps the 18px default font size on mobile", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({ matches: true, media: query })),
    );
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      setFontSize: (size: string) => void;
    };

    expect(instance.setFontSize).toHaveBeenCalledWith("18px");
  });

  it("keeps the previous responsive two-column preference", () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      setColumns: (count: 1 | 2) => void;
    };

    expect(instance.setColumns).toHaveBeenCalledWith(2);
  });

  it("offers only the supported font sizes beside page navigation", async () => {
    mockVault();
    mockReadyDocument();
    const { container } = renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      setFontSize: (size: string) => void;
    };
    const fontSize = screen.getByRole("button", { name: "Font size" });
    const readerColumn = container.querySelector<HTMLElement>(".reader-column")!;
    const viewport = container.querySelector<HTMLElement>(".reader-viewport")!;
    const epubHost = container.querySelector<HTMLElement>(".reader-epub-host")!;

    expect(viewport).toHaveStyle({ fontSize: "18px" });
    expect(readerColumn).toHaveClass("p-2", "md:p-0");
    expect(fontSize).toHaveClass("px-2", "text-sm", "reader-font-trigger");
    expect(viewport).not.toHaveClass("px-2", "md:px-0");
    expect(epubHost).toHaveClass("h-full");

    expect(
      fontSize.compareDocumentPosition(
        screen.getByRole("button", { name: "Previous page" }),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(container.querySelector(".reader-nav-divider")).not.toBeInTheDocument();
    const pageNavigation = container.querySelector(".reader-page-navigation");
    expect(pageNavigation).toHaveClass("justify-center");
    expect(pageNavigation?.parentElement).toHaveClass(
      "grid",
      "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
    );

    await userEvent.click(fontSize);
    const menu = screen.getByRole("menu", { name: "Font size" });
    expect(menu.parentElement).toHaveClass("reader-font-menu");
    expect(menu.parentElement).toHaveClass("text-sm");
    expect(
      screen.getAllByRole("menuitemradio").map((option) => option.textContent),
    ).toEqual(["16px", "18px", "20px", "22px"]);
    expect(screen.getByRole("menuitemradio", { name: "18px" })).toHaveClass(
      "reader-font-option",
      "pr-2",
      "pl-2",
      "py-1",
      "text-sm",
      "bg-primary",
      "text-primary-content",
    );
    expect(screen.getByRole("menuitemradio", { name: "18px" })).toHaveAttribute(
      "data-selected",
      "true",
    );

    await userEvent.click(screen.getByRole("menuitemradio", { name: "20px" }));

    expect(instance.setFontSize).toHaveBeenLastCalledWith("20px");
    expect(instance.setFontSize).toHaveBeenCalledTimes(2);
    expect(fontSize).toHaveTextContent("20px");
    expect(viewport).toHaveStyle({ fontSize: "20px" });
    expect(menu).not.toHaveClass("show");
  });

  it("dismisses the font menu with Escape or an outside click", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const fontSize = screen.getByRole("button", { name: "Font size" });
    const user = userEvent.setup();

    await user.click(fontSize);
    await user.keyboard("{Escape}");
    expect(fontSize).toHaveAttribute("aria-expanded", "false");

    await user.click(fontSize);
    await user.click(document.body);
    expect(fontSize).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the header to back, menu, and info controls", () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const toolbar = screen.getByRole("toolbar", { name: "Reader actions" });

    expect(toolbar).toHaveClass("reader-toolbar");
    expect(toolbar.querySelectorAll("a, button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Display settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Two-column layout" })).toBeNull();
  });

  it("moves focus between reader actions with arrow keys", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const back = screen.getByRole("link", { name: "Back to library" });

    back.focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(screen.getByRole("button", { name: "Menu" })).toHaveFocus();
  });

  it("updates the current and total page from renderer relocation", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      onPageChange: (cb: (page: { current: number; total: number }) => void) => void;
    };
    const callback = vi.mocked(instance.onPageChange).mock.calls[0][0];

    act(() => callback({ current: 4, total: 12 }));

    expect(screen.getByRole("textbox", { name: "Current page" })).toHaveValue("4");
    expect(screen.getByRole("textbox", { name: "Current page" })).toHaveClass(
      "text-sm",
    );
    expect(screen.getByLabelText("Total pages 12")).toHaveClass("text-sm");
    expect(screen.getByLabelText("Total pages 12")).toHaveTextContent("/ 12");
  });

  it("jumps to an edited page and sizes the input from the total", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      onPageChange: (cb: (page: { current: number; total: number }) => void) => void;
      displayPage: (page: number) => Promise<void>;
    };
    const callback = vi.mocked(instance.onPageChange).mock.calls[0][0];
    act(() => callback({ current: 4, total: 120 }));
    const input = screen.getByRole("textbox", { name: "Current page" });
    expect(input).toHaveClass("reader-page-input");

    await userEvent.clear(input);
    await userEvent.type(input, "42{Enter}");

    expect(instance.displayPage).toHaveBeenCalledWith(42);
    expect(input.parentElement?.getAttribute("style")).toContain("calc(3ch + 1.5rem)");
  });

  it("uses one bookmark button for creation and the saved bookmark list", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const bookmark = screen.getByRole("button", { name: "Bookmarks" });

    await userEvent.click(bookmark);

    expect(bookmark).toHaveClass("ml-auto");
    expect(screen.queryByRole("button", { name: "View bookmarks" })).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Bookmark options" }).parentElement,
    ).toHaveClass("reader-bookmark-menu");
    expect(screen.getByText("No bookmarks yet.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add current bookmark" }));
    const reading = vi.mocked(useReadingState).mock.results.at(-1)!.value;
    expect(reading.toggleCurrent).toHaveBeenCalledWith(1);
  });

  it("has a back-to-library link", () => {
    mockVault();
    mockReadyDocument();
    renderScreen();

    expect(screen.getByRole("link", { name: "Back to library" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("ArrowLeft/ArrowRight keyup on the window page/turn", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      prev: () => void;
      next: () => void;
    };

    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{ArrowLeft}");

    expect(instance.next).toHaveBeenCalledTimes(1);
    expect(instance.prev).toHaveBeenCalledTimes(1);
  });

  it("opens the Info panel with the document's metadata", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();

    await userEvent.click(screen.getByRole("button", { name: "Book info" }));

    expect(screen.getByRole("dialog", { name: "Info" })).toHaveClass(
      "reader-side-panel",
    );
    expect(document.querySelector(".reader-drawer-overlay")?.parentElement).toHaveClass(
      "reader-width",
    );
    expect(screen.getByText("Frank Herbert")).toBeInTheDocument();
    expect(screen.getByText("Ace")).toBeInTheDocument();
    expect(screen.getByText("Science Fiction")).toBeInTheDocument();
  });

  it("shows every other OPF metadata field in the Info panel", async () => {
    mockVault();
    mockReadyDocument({
      extraMetadata: [
        { label: "Description", values: ["A desert planet."] },
        { label: "Series", values: ["Dune Saga"] },
      ],
    });
    renderScreen();

    await userEvent.click(screen.getByRole("button", { name: "Book info" }));

    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByText("A desert planet.")).toBeInTheDocument();
    expect(screen.getByText("Series")).toBeInTheDocument();
    expect(screen.getByText("Dune Saga")).toBeInTheDocument();
  });

  it("truncates a long Description at 300 characters behind a Show more toggle", async () => {
    mockVault();
    const long = "A".repeat(320);
    mockReadyDocument({
      extraMetadata: [{ label: "Description", values: [long] }],
    });
    renderScreen();

    await userEvent.click(screen.getByRole("button", { name: "Book info" }));

    expect(screen.getByText(`${"A".repeat(300)}…`)).toBeInTheDocument();
    expect(screen.queryByText(long)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getByText(long)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("renders a short Description's HTML markup, sanitized", async () => {
    mockVault();
    mockReadyDocument({
      extraMetadata: [
        {
          label: "Description",
          values: ["<p>A <b>desert</b> planet.</p><script>alert(1)</script>"],
        },
      ],
    });
    renderScreen();

    await userEvent.click(screen.getByRole("button", { name: "Book info" }));

    expect(screen.getByText("desert").tagName).toBe("B");
    expect(document.querySelector("script")).not.toBeInTheDocument();
  });

  it("opens the menu from the left without exceeding the viewport", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();

    await userEvent.click(screen.getByRole("button", { name: "Menu" }));

    const menu = screen.getByRole("dialog", { name: "Content" });
    expect(menu).toHaveClass("aria-drawer-start", "reader-side-panel");
  });
});
