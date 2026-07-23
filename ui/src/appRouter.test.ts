// @vitest-environment jsdom
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pickRouterComponent } from "./appRouter";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickRouterComponent", () => {
  it("picks MemoryRouter when replaceState() throws (opaque origin -- file://, content://, etc., see local_index.html)", () => {
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("cannot be created in a document with origin 'null'", "SecurityError");
    });
    expect(pickRouterComponent()).toBe(MemoryRouter);
  });

  it("picks BrowserRouter when replaceState() succeeds (a normal http(s) deployment)", () => {
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    expect(pickRouterComponent()).toBe(BrowserRouter);
    // Confirms the detection call itself is a same-URL/same-state no-op --
    // not just that it happened.
    expect(replaceState).toHaveBeenCalledWith(window.history.state, "", location.href);
  });
});
