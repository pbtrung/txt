// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state/VaultContext", () => ({ useVault: vi.fn() }));
vi.mock("./useReaderDocument", () => ({ useReaderDocument: vi.fn() }));
vi.mock("../../data/epubRenderer", () => ({
  EpubRenderer: vi.fn().mockImplementation(function () {
    return {
      renderTo: vi.fn(),
      destroy: vi.fn(),
      prev: vi.fn().mockResolvedValue(undefined),
      next: vi.fn().mockResolvedValue(undefined),
      onKeyup: vi.fn(),
      setFontSize: vi.fn(),
      getToc: vi.fn().mockResolvedValue([]),
    };
  }),
}));

import { EpubRenderer } from "../../data/epubRenderer";
import { useVault, type VaultSession } from "../../state/VaultContext";
import { ReaderScreen } from "./ReaderScreen";
import { useReaderDocument } from "./useReaderDocument";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

    expect(screen.getByRole("heading", { name: "Dune" })).toBeInTheDocument();
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

  it("font size buttons call setFontSize with a clamped percentage", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      setFontSize: (size: string) => void;
    };

    await userEvent.click(screen.getByRole("button", { name: "Increase font size" }));

    expect(instance.setFontSize).toHaveBeenCalledWith("110%");
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

  it("opens the Contents panel", async () => {
    mockVault();
    mockReadyDocument();
    renderScreen();

    await userEvent.click(screen.getByRole("button", { name: "Contents" }));

    expect(screen.getByRole("dialog", { name: "Contents" })).toHaveClass("show");
  });
});
