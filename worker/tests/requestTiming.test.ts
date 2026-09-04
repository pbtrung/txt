import { describe, expect, it } from "vitest";
import { createRequestTiming, timeNetwork } from "../requestTiming";

describe("requestTiming", () => {
  it("starts at zero", () => {
    expect(createRequestTiming()).toEqual({ networkWaitMs: 0 });
  });

  it("accumulates elapsed time across multiple calls", async () => {
    const timing = createRequestTiming();
    await timeNetwork(timing, () => new Promise((resolve) => setTimeout(resolve, 5)));
    const afterFirst = timing.networkWaitMs;
    expect(afterFirst).toBeGreaterThan(0);

    await timeNetwork(timing, () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(timing.networkWaitMs).toBeGreaterThan(afterFirst);
  });

  it("still accumulates elapsed time when the operation throws", async () => {
    const timing = createRequestTiming();
    await expect(
      timeNetwork(timing, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(timing.networkWaitMs).toBeGreaterThanOrEqual(0);
  });

  it("returns the operation's own result", async () => {
    const timing = createRequestTiming();
    const result = await timeNetwork(timing, async () => 42);
    expect(result).toBe(42);
  });
});
