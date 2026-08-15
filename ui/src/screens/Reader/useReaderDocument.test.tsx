// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../data/readerDocument", () => ({ loadReaderDocument: vi.fn() }));

import { loadReaderDocument } from "../../data/readerDocument";
import type { VaultSession } from "../../state/VaultContext";
import { useReaderDocument } from "./useReaderDocument";

const SESSION = {
  db: {},
  r2: {},
  dbPrefix: "the-db-prefix",
} as unknown as VaultSession;

describe("useReaderDocument", () => {
  it("stays in loading with no session", () => {
    const { result } = renderHook(() => useReaderDocument(null, 1));
    expect(result.current.status).toBe("loading");
  });

  it("resolves to ready with the loaded document", async () => {
    const document = {
      title: "Dune",
      authors: ["Frank Herbert"],
      subjects: ["Science Fiction"],
      publisher: "Ace",
      epubBytes: new Uint8Array([1]),
    };
    vi.mocked(loadReaderDocument).mockResolvedValue(document);

    const { result } = renderHook(() => useReaderDocument(SESSION, 1));
    expect(result.current.status).toBe("loading");

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document).toEqual(document);
  });

  it("resolves to not-found when the document doesn't exist", async () => {
    vi.mocked(loadReaderDocument).mockResolvedValue(null);

    const { result } = renderHook(() => useReaderDocument(SESSION, 999));

    await waitFor(() => expect(result.current.status).toBe("not-found"));
  });

  it("resolves to error on failure", async () => {
    vi.mocked(loadReaderDocument).mockRejectedValue(new Error("R2 GET failed: 500"));

    const { result } = renderHook(() => useReaderDocument(SESSION, 1));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("R2 GET failed: 500");
  });
});
