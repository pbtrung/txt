import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@instantdb/react", () => ({ init: vi.fn(() => ({})) }));

import { init } from "@instantdb/react";
import { createInstantClient } from "./instantClient";

describe("createInstantClient", () => {
  afterEach(() => {
    // vi.unstubAllGlobals() only reverts values *set via vi.stubGlobal* --
    // shimWindowForWorker() itself directly mutates globalThis.window (that
    // mutation is the whole point of the function under test), which is not
    // something unstubAllGlobals can undo, so it has to be cleaned up here
    // explicitly or it leaks into the next test.
    delete (globalThis as { window?: unknown }).window;
    vi.unstubAllGlobals();
    vi.mocked(init).mockClear();
  });

  it("passes devtool: false through to init()", () => {
    createInstantClient("app-1");
    expect(init).toHaveBeenCalledWith({ appId: "app-1", devtool: false });
  });

  it("does not touch globalThis.window when a real window already exists", () => {
    vi.stubGlobal("window", { real: true });
    createInstantClient("app-1");
    expect((globalThis as { window?: unknown }).window).toEqual({
      real: true,
    });
  });

  it("shims globalThis.window to self when running inside a dedicated Worker (no window, WorkerGlobalScope defined)", () => {
    const fakeSelf = { fake: "worker-global-scope" };
    vi.stubGlobal("WorkerGlobalScope", class {});
    vi.stubGlobal("self", fakeSelf);
    expect((globalThis as { window?: unknown }).window).toBeUndefined();

    createInstantClient("app-1");

    // @instantdb/core's Reactor gates all real initialization behind
    // isClient() (typeof window !== 'undefined' || typeof chrome !==
    // 'undefined') -- without this shim, calling init() from inside a
    // dedicated Worker (global scope is `self`, no `window`) hits the exact
    // same "Cannot read properties of undefined (reading 'updateInPlace')"
    // crash this project already hit once running the Reactor under Node.
    expect((globalThis as { window?: unknown }).window).toBe(fakeSelf);
  });

  it("does not shim window when neither a real window nor a Worker global scope is present", () => {
    createInstantClient("app-1");
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
  });
});
