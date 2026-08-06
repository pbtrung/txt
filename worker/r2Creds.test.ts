import { afterEach, describe, expect, it, vi } from "vitest";

import { handleR2Creds } from "./r2Creds";

const env: Env = {
  READ_WRITE_ACCESS_KEY_ID: "parent-access-key",
  READ_WRITE_SECRET_ACCESS_KEY: "parent-secret-key",
  R2_BUCKET: "txt-parts",
  R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
  INSTANT_APP_ID: "instant-app-id",
};

function request(body: unknown): Request {
  return new Request("https://example.com/api/r2-creds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("base64");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleR2Creds", () => {
  it("queries InstantDB as the caller and mints a prefix credential on a match", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(_url).toBe(
        "https://api.instantdb.com/admin/query?app_id=instant-app-id",
      );
      expect(init.headers).toEqual({
        "content-type": "application/json",
        "app-id": "instant-app-id",
        "as-token": "instant-token",
      });
      expect(JSON.parse(init.body as string)).toEqual({
        query: {
          txt: {
            $: {
              where: { id: "txt-1" },
              fields: ["prefixHash"],
            },
          },
        },
      });
      return Response.json({
        txt: [{ prefixHash: await sha256Base64("prefix-1") }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleR2Creds(
      request({
        instantToken: "instant-token",
        txtId: "txt-1",
        prefix: "prefix-1",
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      accessKeyId: "parent-access-key",
      secretAccessKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      sessionToken: expect.any(String),
      expiresAtMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("denies an authorized row when the supplied prefix does not match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          txt: [{ prefixHash: await sha256Base64("real-prefix") }],
        }),
      ),
    );

    const response = await handleR2Creds(
      request({
        instantToken: "instant-token",
        txtId: "txt-1",
        prefix: "wrong-prefix",
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "document access denied" });
  });

  it("denies an absent or permission-filtered txt row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ txt: [] })),
    );

    const response = await handleR2Creds(
      request({
        instantToken: "instant-token",
        txtId: "txt-1",
        prefix: "prefix-1",
      }),
      env,
    );

    expect(response.status).toBe(403);
  });

  it("maps a rejected Instant token to access denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    const response = await handleR2Creds(
      request({
        instantToken: "expired-token",
        txtId: "txt-1",
        prefix: "prefix-1",
      }),
      env,
    );

    expect(response.status).toBe(403);
  });

  it("does not mint when InstantDB is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    const response = await handleR2Creds(
      request({
        instantToken: "instant-token",
        txtId: "txt-1",
        prefix: "prefix-1",
      }),
      env,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "authorization service unavailable",
    });
  });

  it("rejects incomplete request bodies before querying InstantDB", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleR2Creds(
      request({ instantToken: "instant-token", prefix: "prefix-1" }),
      env,
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
