import type { AwsClient } from "aws4fetch";
import { describe, expect, it, vi } from "vitest";

import { getObject } from "./r2";
import type { R2Config } from "./r2Config";

const config: R2Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-bucket",
  readOnlyAccessKeyId: "ro-id",
  readOnlySecretAccessKey: "ro-secret",
};

function fakeAwsClient(fetchImpl: (url: string) => Promise<Response>): AwsClient {
  return { fetch: vi.fn(fetchImpl) } as unknown as AwsClient;
}

describe("getObject", () => {
  it("signs and fetches the object, decoding the response body", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const client = fakeAwsClient(async (url) => {
      expect(url).toBe("https://acct.r2.cloudflarestorage.com/my-bucket/some-key");
      return new Response(body);
    });
    const result = await getObject(client, config, "some-key");
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
  });

  it("retries on failure and succeeds once the object is reachable", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const client = fakeAwsClient(async () => {
      attempts++;
      if (attempts < 3) throw new Error("network blip");
      return new Response(new Uint8Array([9]));
    });

    const promise = getObject(client, config, "flaky-key");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(attempts).toBe(3);
    expect(Array.from(result)).toEqual([9]);
    vi.useRealTimers();
  });

  it("throws after exhausting all retries", async () => {
    vi.useFakeTimers();
    const client = fakeAwsClient(async () => new Response("nope", { status: 404 }));

    const promise = getObject(client, config, "missing-key");
    const expectation = expect(promise).rejects.toThrow("failed after 4 attempt(s)");
    await vi.runAllTimersAsync();
    await expectation;
    vi.useRealTimers();
  });

  it("hints at a CORS misconfiguration for a browser-side fetch TypeError", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const client = fakeAwsClient(async () => {
      throw new TypeError("Failed to fetch");
    });

    const promise = getObject(client, config, "missing-key");
    const expectation = expect(promise).rejects.toThrow(/CORS policy/);
    await vi.runAllTimersAsync();
    await expectation;

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not add the CORS hint for a plain HTTP-status failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const client = fakeAwsClient(async () => new Response("nope", { status: 500 }));

    const promise = getObject(client, config, "missing-key");
    const expectation = expect(promise).rejects.not.toThrow(/CORS policy/);
    await vi.runAllTimersAsync();
    await expectation;

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
