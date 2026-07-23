// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./state/vault", () => ({ useVault: vi.fn() }));

import { guardRedirect, pickRouterHistory, requiresUnlockedSession } from "./router";
import { useVault } from "./state/vault";

describe("pickRouterHistory", () => {
  afterEach(() => {
    history.replaceState(null, "", "/");
  });

  it("returns a memory history for file:// -- never touches window.history", () => {
    const before = location.pathname;
    const routerHistory = pickRouterHistory("file:");
    routerHistory.push("/library");
    expect(location.pathname).toBe(before);
  });

  it("returns a web history for a normal http(s) deployment -- pushes through window.history", () => {
    const routerHistory = pickRouterHistory("https:");
    routerHistory.push("/library");
    expect(location.pathname).toBe("/library");
  });
});

describe("requiresUnlockedSession", () => {
  it("is true for /library and any /read/... path", () => {
    expect(requiresUnlockedSession("/library")).toBe(true);
    expect(requiresUnlockedSession("/read/1")).toBe(true);
    expect(requiresUnlockedSession("/read/1?part=2")).toBe(true);
  });

  it("is false for / and anything else", () => {
    expect(requiresUnlockedSession("/")).toBe(false);
    expect(requiresUnlockedSession("/something-else")).toBe(false);
  });
});

describe("guardRedirect", () => {
  function mockStatus(status: "locked" | "unlocking" | "unlocked") {
    vi.mocked(useVault).mockReturnValue({ status: { value: status } } as unknown as ReturnType<typeof useVault>);
  }

  it("redirects to / when a protected path is visited without an unlocked session", () => {
    mockStatus("locked");
    expect(guardRedirect("/library")).toBe("/");
    expect(guardRedirect("/read/1")).toBe("/");
  });

  it("lets a protected path through once unlocked", () => {
    mockStatus("unlocked");
    expect(guardRedirect("/library")).toBeUndefined();
  });

  it("lets an unprotected path through regardless of status", () => {
    mockStatus("locked");
    expect(guardRedirect("/")).toBeUndefined();
  });
});
