// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/data/readerDocument", () => ({
  loadReaderDocument: vi.fn(),
  READER_LOAD_TOTAL_STEPS: 5,
}));

import { loadReaderDocument } from "../../../src/data/readerDocument";
import type { VaultSession } from "../../../src/state/VaultContext";
import { useReaderDocument } from "../../../src/screens/Reader/useReaderDocument";

const SESSION = {
  database: { read: async (reader: (db: object) => unknown) => reader({}) },
  storage: {},
  dbPrefix: "the-db-prefix",
} as unknown as VaultSession;

beforeEach(() => vi.clearAllMocks());

describe("useReaderDocument", () => {
  it("stays in loading with no session", () => {
    const { result } = renderHook(() => useReaderDocument(null, 1));
    expect(result.current.status).toBe("loading");
    expect(result.current.status === "loading" && result.current.progress).toEqual({
      label: "Reading book details",
      step: 1,
      total: 5,
    });
  });

  it("resolves to ready with the loaded document", async () => {
    const document = {
      txtId: 1,
      lastCfi: null,
      title: "Dune",
      authors: ["Frank Herbert"],
      subjects: ["Science Fiction"],
      publisher: "Ace",
      extraMetadata: [],
      epubBytes: new Uint8Array([1]),
    };
    vi.mocked(loadReaderDocument).mockResolvedValue(document);

    const { result } = renderHook(() => useReaderDocument(SESSION, 1));
    expect(result.current.status).toBe("loading");

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document).toEqual(document);
  });

  it("shares the first download across Strict Mode effect replays", async () => {
    const document = {
      txtId: 1,
      lastCfi: null,
      title: "Dune",
      authors: ["Frank Herbert"],
      subjects: [],
      publisher: null,
      extraMetadata: [],
      epubBytes: new Uint8Array([1]),
    };
    vi.mocked(loadReaderDocument).mockResolvedValue(document);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );

    const { result } = renderHook(() => useReaderDocument(SESSION, 1), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(loadReaderDocument).toHaveBeenCalledOnce();
  });

  it("reports download progress while the first document load is pending", async () => {
    let finish!: (value: null) => void;
    vi.mocked(loadReaderDocument).mockImplementation(
      async (_db, _storage, _prefix, _txtId, onProgress) => {
        onProgress?.({ label: "Downloading text", step: 2, total: 5 });
        return new Promise<null>((resolve) => {
          finish = resolve;
        });
      },
    );

    const { result } = renderHook(() => useReaderDocument(SESSION, 1));

    await waitFor(() =>
      expect(result.current.status === "loading" && result.current.progress).toEqual({
        label: "Downloading text",
        step: 2,
        total: 5,
      }),
    );
    finish(null);
    await waitFor(() => expect(result.current.status).toBe("not-found"));
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

  it("rejects an invalid route id without querying storage", () => {
    vi.mocked(loadReaderDocument).mockClear();
    const { result } = renderHook(() => useReaderDocument(SESSION, Number.NaN));

    expect(result.current.status).toBe("not-found");
    expect(loadReaderDocument).not.toHaveBeenCalled();
  });
});
