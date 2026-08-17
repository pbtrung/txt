import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn } from "../../src/auth/firebaseSignIn";

afterEach(() => vi.unstubAllGlobals());

describe("signIn", () => {
  it("returns an in-memory session with the Firebase ID token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        idToken: "token",
        refreshToken: "refresh",
        expiresIn: "3600",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await signIn("api key", "reader@example.com", "pw");
    await expect(session.getIdToken()).resolves.toBe("token");
    expect(fetchMock.mock.calls[0][0]).toContain("key=api%20key");
  });

  it("rejects a successful response without an ID token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );

    await expect(signIn("key", "reader@example.com", "pw")).rejects.toThrow(
      /missing idToken/,
    );
  });

  it("refreshes an expiring token and rotates the refresh token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          idToken: "old-token",
          refreshToken: "old-refresh",
          expiresIn: "1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: "3600",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const session = await signIn("api key", "reader@example.com", "pw");
    await expect(session.getIdToken()).resolves.toBe("new-token");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toContain("securetoken.googleapis.com");
    expect(String(init.body)).toContain("refresh_token=old-refresh");
    await expect(session.getIdToken()).resolves.toBe("new-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an unsuccessful status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(signIn("key", "reader@example.com", "pw")).rejects.toThrow(/401/);
  });
});
