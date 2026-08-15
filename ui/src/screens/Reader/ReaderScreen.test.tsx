// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state/VaultContext", () => ({ useVault: vi.fn() }));
vi.mock("./useReaderDocument", () => ({ useReaderDocument: vi.fn() }));
vi.mock("../../data/epubRenderer", () => ({
  EpubRenderer: vi.fn().mockImplementation(function () {
    return { renderTo: vi.fn(), destroy: vi.fn() };
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
    const epubBytes = new Uint8Array([1, 2, 3]);
    vi.mocked(useReaderDocument).mockReturnValue({
      status: "ready",
      document: { title: "Dune", epubBytes },
      error: null,
    });
    renderScreen();

    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(vi.mocked(EpubRenderer)).toHaveBeenCalledWith(epubBytes);
  });

  it("destroys the renderer on unmount", () => {
    mockVault();
    const epubBytes = new Uint8Array([1]);
    vi.mocked(useReaderDocument).mockReturnValue({
      status: "ready",
      document: { title: "Dune", epubBytes },
      error: null,
    });
    const { unmount } = renderScreen();
    const instance = vi.mocked(EpubRenderer).mock.results[0].value as {
      destroy: () => void;
    };

    unmount();

    expect(instance.destroy).toHaveBeenCalled();
  });
});
