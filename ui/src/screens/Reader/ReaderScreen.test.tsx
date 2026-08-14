// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../state/VaultContext", () => ({ useVault: vi.fn() }));
vi.mock("./useReaderDocument", () => ({ useReaderDocument: vi.fn() }));

import type { TxtDocument } from "../../data/document";
import { useVault } from "../../state/VaultContext";
import { ReaderScreen } from "./ReaderScreen";
import { useReaderDocument, type ReaderState } from "./useReaderDocument";

function renderAt(txtId: string, state: ReaderState) {
  vi.mocked(useVault).mockReturnValue({
    status: "unlocked",
    session: {} as never,
    error: null,
    progress: null,
    unlock: vi.fn(),
    lock: vi.fn(),
  });
  vi.mocked(useReaderDocument).mockReturnValue(state);
  return render(
    <MemoryRouter initialEntries={[`/read/${txtId}`]}>
      <Routes>
        <Route path="/read/:txtId" element={<ReaderScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ReaderScreen", () => {
  it("shows a loading message", () => {
    renderAt("1", { status: "loading", document: null, error: null });
    expect(screen.getByText(/Opening your book/)).toBeInTheDocument();
  });

  it("shows a not-found message", () => {
    renderAt("1", { status: "not-found", document: null, error: null });
    expect(screen.getByText(/could not be found/)).toBeInTheDocument();
  });

  it("shows an error message", () => {
    renderAt("1", { status: "error", document: null, error: "boom" });
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });

  it("shows the document's name and part count once ready", () => {
    const document: TxtDocument = {
      id: 1,
      txtKey: new Uint8Array(),
      prefix: "abc",
      name: "book.epub",
      nParts: 3,
      metadata: null,
      parts: [],
    };
    renderAt("1", { status: "ready", document, error: null });

    expect(screen.getByRole("heading", { name: "book.epub" })).toBeInTheDocument();
    expect(screen.getByText("3 part(s)")).toBeInTheDocument();
  });
});
