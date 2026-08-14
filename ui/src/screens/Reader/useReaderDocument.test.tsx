// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../data/openReaderBB", () => ({ openReaderBB: vi.fn() }));
vi.mock("../../data/document", () => ({ readDocument: vi.fn() }));

import { readDocument, type TxtDocument } from "../../data/document";
import { openReaderBB } from "../../data/openReaderBB";
import type { VaultSession } from "../../state/VaultContext";
import { useReaderDocument } from "./useReaderDocument";

const SESSION = { aa: {}, credStore: { db_master_key: "keybase64" }, bundleBytes: null } as unknown as VaultSession;

const DOC: TxtDocument = { id: 1, txtKey: new Uint8Array(), prefix: "p", name: "book.epub", nParts: 1, metadata: null, parts: [] };

beforeEach(() => vi.clearAllMocks());

describe("useReaderDocument", () => {
  it("stays in loading state until session exists", () => {
    const { result } = renderHook(() => useReaderDocument(null, 1));
    expect(result.current.status).toBe("loading");
    expect(openReaderBB).not.toHaveBeenCalled();
  });

  it("opens BB and reads the document", async () => {
    const close = vi.fn();
    vi.mocked(openReaderBB).mockResolvedValue({ query: vi.fn(), execute: vi.fn(), drainDirtyPages: vi.fn(), close });
    vi.mocked(readDocument).mockResolvedValue(DOC);

    const { result } = renderHook(() => useReaderDocument(SESSION, 1));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document).toEqual(DOC);
    expect(openReaderBB).toHaveBeenCalledWith({ aa: SESSION.aa, dbMasterKeyBase64: "keybase64", bundleBytes: null });
  });

  it("reports not-found when the document doesn't exist", async () => {
    vi.mocked(openReaderBB).mockResolvedValue({ query: vi.fn(), execute: vi.fn(), drainDirtyPages: vi.fn(), close: vi.fn() });
    vi.mocked(readDocument).mockResolvedValue(null);

    const { result } = renderHook(() => useReaderDocument(SESSION, 1));

    await waitFor(() => expect(result.current.status).toBe("not-found"));
  });

  it("reports an error when opening BB fails", async () => {
    vi.mocked(openReaderBB).mockRejectedValue(new Error("sqlite3_key failed"));

    const { result } = renderHook(() => useReaderDocument(SESSION, 1));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("sqlite3_key failed");
  });

  it("closes BB on unmount", async () => {
    const close = vi.fn();
    vi.mocked(openReaderBB).mockResolvedValue({ query: vi.fn(), execute: vi.fn(), drainDirtyPages: vi.fn(), close });
    vi.mocked(readDocument).mockResolvedValue(DOC);

    const { result, unmount } = renderHook(() => useReaderDocument(SESSION, 1));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    unmount();
    expect(close).toHaveBeenCalled();
  });
});
