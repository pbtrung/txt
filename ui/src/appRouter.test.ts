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
    // Confirms the detection call uses a path-absolute URL (no scheme/host
    // of its own), not location.href -- a regression back to passing an
    // *absolute* URL here would silently stop this from ever detecting the
    // opaque-origin-plus-overridden-<base> case local_index.html hits (an
    // absolute URL doesn't get resolved against document.baseURI at all,
    // so it can't reproduce the mismatch a real relative navigation would
    // hit -- confirmed empirically, not just in theory; see this file's own
    // top comment).
    expect(replaceState).toHaveBeenCalledWith(
      window.history.state,
      "",
      location.pathname + location.search + location.hash,
    );
  });
});
