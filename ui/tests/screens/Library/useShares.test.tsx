// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/data/shares", () => ({ loadShares: vi.fn() }));

import { loadShares, type BookShare } from "../../../src/data/shares";
import { useShares } from "../../../src/screens/Library/useShares";
import type { VaultSession } from "../../../src/state/VaultContext";

const SHARES = [share("a"), share("b")];

function fakeSession(): VaultSession {
  return {
    library: { snapshot: () => [] },
    umk: new Uint8Array(0),
    api: {},
  } as unknown as VaultSession;
}

describe("useShares", () => {
  it("removes a successfully deleted share from the visible list immediately", async () => {
    vi.mocked(loadShares).mockResolvedValue(SHARES);
    const { result } = renderHook(() => useShares(fakeSession()));
    await waitFor(() => expect(result.current.shares).toEqual(SHARES));

    act(() => result.current.remove("a"));

    expect(result.current.shares).toEqual([SHARES[1]]);
  });

  it("returns no shares when there's no session", () => {
    const { result } = renderHook(() => useShares(null));
    expect(result.current.shares).toEqual([]);
  });
});

function share(shareIdHash: string): BookShare {
  return {
    shareIdHash,
    txtId: 1,
    title: `Book ${shareIdHash}`,
    shareId: new Uint8Array(32),
    contentKey: new Uint8Array(128),
    sharePath: "s".repeat(52),
    state: "active",
    createdAt: 0,
  };
}
