// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/state/VaultContext", () => ({ useVault: vi.fn() }));
vi.mock("../../../src/screens/Reader/useReaderDocument", () => ({
  useReaderDocument: vi.fn(),
}));
vi.mock("../../../src/data/epubRenderer", () => ({
  EpubRenderer: vi.fn().mockImplementation(function () {
    return {
      renderTo: vi.fn(),
      destroy: vi.fn(),
      prev: vi.fn().mockResolvedValue(undefined),
      next: vi.fn().mockResolvedValue(undefined),
      onKeyup: vi.fn(),
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

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/read/1"]}>
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
    });
    renderScreen();
    expect(screen.getByText(/Opening your book/)).toBeInTheDocument();
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
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });

  it("renders the document's title and mounts EpubRenderer", () => {
    mockVault();
    mockReadyDocument();
    renderScreen();

    expect(screen.getByRole("heading", { name: "Dune", level: 1 })).toBeInTheDocument();
    expect(vi.mocked(EpubRenderer)).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
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

  it("applies the mobile default font size when matchMedia matches", () => {
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

    expect(instance.setFontSize).toHaveBeenCalledWith("16px");
  });

  it("font size buttons adjust the size in 1px steps", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      setFontSize: (size: string) => void;
    };

    await userEvent.click(screen.getByRole("button", { name: "Display settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Increase font size" }));

    expect(instance.setFontSize).toHaveBeenLastCalledWith("19px");
  });

  it("the columns button toggles between 1 and 2 columns", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      setColumns: (count: 1 | 2) => void;
    };
    await userEvent.click(screen.getByRole("button", { name: "Display settings" }));
    const button = screen.getByRole("button", { name: "Two-column layout" });
    expect(instance.setColumns).toHaveBeenCalledWith(1);
    expect(button).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(button);

    expect(instance.setColumns).toHaveBeenLastCalledWith(2);
    expect(button).toHaveAttribute("aria-pressed", "true");
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

  it("opens the Contents panel", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();

    await userEvent.click(screen.getByRole("button", { name: "Contents" }));

    expect(screen.getByRole("dialog", { name: "Contents" })).toHaveClass("show");
  });
});
