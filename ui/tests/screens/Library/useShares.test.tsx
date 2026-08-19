// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LibraryDatabaseStore } from "../../../src/data/databaseStore";
import type { BookShare } from "../../../src/data/shares";
import { useShares } from "../../../src/screens/Library/useShares";

const SHARES = [share(1), share(2)];

describe("useShares", () => {
  it("removes a successfully deleted share from the visible list immediately", async () => {
    const database = {
      read: vi.fn().mockResolvedValue(SHARES),
    } as unknown as LibraryDatabaseStore;
    const { result } = renderHook(() => useShares(database));
    await waitFor(() => expect(result.current.shares).toEqual(SHARES));

    act(() => result.current.remove(1));

    expect(result.current.shares).toEqual([SHARES[1]]);
  });
});

function share(id: number): BookShare {
  return {
    id,
    txtId: id,
    title: `Book ${id}`,
    shareId: new Uint8Array(32),
    contentKey: new Uint8Array(128),
    prefix: new Uint8Array(32),
    path: new Uint8Array(32),
    state: "active",
    createdAt: id,
  };
}
