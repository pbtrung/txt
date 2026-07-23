import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { pickRouterComponent } from "./appRouter";

describe("pickRouterComponent", () => {
  it("picks MemoryRouter for a file:// document (opaque/null origin -- see local_index.html)", () => {
    expect(pickRouterComponent("file:")).toBe(MemoryRouter);
  });

  it("picks BrowserRouter for a normal http(s) deployment", () => {
    expect(pickRouterComponent("https:")).toBe(BrowserRouter);
    expect(pickRouterComponent("http:")).toBe(BrowserRouter);
  });
});
