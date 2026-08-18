import { describe, expect, it, vi } from "vitest";

import { NetworkTimeoutError, withNetworkRetries } from "../../src/data/networkRequest";

describe("withNetworkRetries", () => {
  it("times out each attempt and stops after three retries", async () => {
    vi.useFakeTimers();
    try {
      const operation = vi.fn(() => new Promise<never>(() => undefined));

      const request = withNetworkRetries(operation);
      const rejection = expect(request).rejects.toBeInstanceOf(NetworkTimeoutError);
      await vi.runAllTimersAsync();

      await rejection;
      expect(operation).toHaveBeenCalledTimes(4);
      for (const [signal] of operation.mock.calls) expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
