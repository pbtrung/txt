import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTempR2Credential } from "./tempR2Creds";
import type { R2Config } from "./r2Config";

const r2Config: R2Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-bucket",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTempR2Credential", () => {
  it("POSTs idToken/prefix and builds an AwsClient from the response", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/r2-creds");
      expect(JSON.parse(init.body as string)).toEqual({
        idToken: "id-token-1",
        prefix: "doc-prefix-1",
      });
      return new Response(
        JSON.stringify({
          accessKeyId: "temp-id",
          secretAccessKey: "temp-secret",
          sessionToken: "temp-session",
          expiresAtMs: 12345,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = await fetchTempR2Credential(
      "id-token-1",
      "doc-prefix-1",
      r2Config,
    );

    expect(cred.expiresAtMs).toBe(12345);
    expect(cred.client.accessKeyId).toBe("temp-id");
    expect(cred.client.secretAccessKey).toBe("temp-secret");
    expect(cred.client.sessionToken).toBe("temp-session");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws with the response's own error detail on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "prefix mismatch" }), {
            status: 403,
          }),
      ),
    );

    await expect(
      fetchTempR2Credential("id-token-1", "doc-prefix-1", r2Config),
    ).rejects.toThrow("HTTP 403: prefix mismatch");
  });

  it("still throws a useful error when the failure response isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 500 })),
    );

    await expect(
      fetchTempR2Credential("id-token-1", "doc-prefix-1", r2Config),
    ).rejects.toThrow("HTTP 500");
  });
});
