import { afterEach, describe, expect, it } from "vitest";
import { isWeb } from "./env";

describe("isWeb", () => {
  afterEach(() => {
    delete (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
  });

  it("is false under plain Node (no window, no WorkerGlobalScope)", () => {
    expect(isWeb()).toBe(false);
  });

  it("is true when WorkerGlobalScope is defined (inside a Worker)", () => {
    (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope = class {};
    expect(isWeb()).toBe(true);
  });
});
