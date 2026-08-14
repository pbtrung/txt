// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isBrowser } from "./env";

describe("isBrowser under jsdom", () => {
  it("is false -- jsdom defines window/document but never runs injected <script> tags", () => {
    expect(isBrowser()).toBe(false);
  });
});
