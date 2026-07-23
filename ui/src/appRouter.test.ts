import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { pickRouterComponent } from "./appRouter";

describe("pickRouterComponent", () => {
  it("picks MemoryRouter for an opaque/null origin (file://, content://, etc. -- see local_index.html)", () => {
    expect(pickRouterComponent("null")).toBe(MemoryRouter);
  });

  it("picks BrowserRouter for a normal http(s) deployment", () => {
    expect(pickRouterComponent("https://example.com")).toBe(BrowserRouter);
    expect(pickRouterComponent("http://example.com")).toBe(BrowserRouter);
  });
});
