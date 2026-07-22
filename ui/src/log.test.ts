import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isVerbose, setVerbose, verbose } from "./log";

describe("verbose logging", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setVerbose(true);
  });

  it("is on by default", () => {
    expect(isVerbose()).toBe(true);
    verbose("hello", { a: 1 });
    expect(console.log).toHaveBeenCalledWith("[verbose]", "hello", { a: 1 });
  });

  it("stops logging once disabled via setVerbose(false)", () => {
    setVerbose(false);
    expect(isVerbose()).toBe(false);
    verbose("hello");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("resumes logging once re-enabled", () => {
    setVerbose(false);
    setVerbose(true);
    verbose("hello");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "hello");
  });
});

describe("verbose logging's initial state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("starts on when the page loads without ?verbose=0", async () => {
    vi.stubGlobal("location", { search: "" } as unknown as Location);
    vi.resetModules();
    const { isVerbose: isVerboseFresh } = await import("./log");
    expect(isVerboseFresh()).toBe(true);
  });

  it("starts off when the page loads with ?verbose=0", async () => {
    vi.stubGlobal("location", { search: "?verbose=0" } as unknown as Location);
    vi.resetModules();
    const { isVerbose: isVerboseFresh } = await import("./log");
    expect(isVerboseFresh()).toBe(false);
  });
});
