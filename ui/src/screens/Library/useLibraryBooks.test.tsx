// @vitest-environment jsdom
import type { Client } from "@libsql/core/api";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as libraryModel from "./libraryModel";
import * as VaultContextModule from "../../state/VaultContext";
import { useLibraryBooks } from "./useLibraryBooks";

vi.mock("./libraryModel", async () => {
  const actual = await vi.importActual<typeof import("./libraryModel")>("./libraryModel");
  return { ...actual, loadLibraryBooks: vi.fn(), loadPartCount: vi.fn() };
});
vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<typeof import("../../state/VaultContext")>("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});

const session = {
  creds: {} as never,
  db: {} as Client,
  userId: 42,
  umk: new Uint8Array(64),
  r2Config: {} as never,
  r2Client: {} as never,
};

function mockVault() {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session,
    error: null,
    unlock: vi.fn(),
    lock: vi.fn(),
    getTxtKey: vi.fn(),
  });
}

function book(txtId: number): libraryModel.LibraryBook {
  return {
    txtId,
    info: { txtId, name: `n${txtId}`, title: `Title ${txtId}`, subjects: [] },
    partCount: null,
    lastPartNum: null,
    lastAccessedMs: null,
  };
}

describe("useLibraryBooks", () => {
  it("shows the initial list immediately, with partCount null, then fills it in per book", async () => {
    mockVault();
    vi.mocked(libraryModel.loadLibraryBooks).mockResolvedValue([book(1), book(2)]);

    // Deferred, so the initial (null-partCount) render is observable before
    // these resolve -- an instantly-resolving mock leaves no gap to catch.
    const deferred = new Map<number, (count: number) => void>();
    vi.mocked(libraryModel.loadPartCount).mockImplementation(
      (_db, txtId) => new Promise((resolve) => deferred.set(txtId, resolve)),
    );

    const { result } = renderHook(() => useLibraryBooks());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.books?.map((b) => b.partCount)).toEqual([null, null]);
    await waitFor(() => expect(deferred.size).toBe(2));

    deferred.get(1)?.(10);
    deferred.get(2)?.(20);

    await waitFor(() => expect(result.current.books?.every((b) => b.partCount !== null)).toBe(true));
    expect(result.current.books?.find((b) => b.txtId === 1)?.partCount).toBe(10);
    expect(result.current.books?.find((b) => b.txtId === 2)?.partCount).toBe(20);
  });

  it("logs and keeps the list when a single book's part count fails to load", async () => {
    mockVault();
    vi.mocked(libraryModel.loadLibraryBooks).mockResolvedValue([book(1)]);
    vi.mocked(libraryModel.loadPartCount).mockRejectedValue(new Error("boom"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useLibraryBooks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());

    expect(result.current.books?.[0].partCount).toBeNull();
    expect(result.current.error).toBeNull();
    warnSpy.mockRestore();
  });

  it("surfaces an error if the initial list itself fails to load", async () => {
    mockVault();
    vi.mocked(libraryModel.loadLibraryBooks).mockRejectedValue(new Error("no connection"));

    const { result } = renderHook(() => useLibraryBooks());
    await waitFor(() => expect(result.current.error).toBe("no connection"));
    expect(result.current.books).toBeNull();
  });
});
