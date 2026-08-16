import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn } from "../../src/auth/firebaseSignIn";

afterEach(() => vi.unstubAllGlobals());

describe("signIn", () => {
  it("returns the Firebase ID token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ idToken: "token" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(signIn("api key", "reader@example.com", "pw")).resolves.toEqual({
      idToken: "token",
    });
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

  it("reports an unsuccessful status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(signIn("key", "reader@example.com", "pw")).rejects.toThrow(/401/);
  });
});
