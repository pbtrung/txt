import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveInstantAuthId,
  signInWithFirebaseIdToken,
  signInWithPasswordForIdToken,
} from "./instantAuth";

function jsonResponse(ok: boolean, body: unknown) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("instantAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs into Firebase with password credentials", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(true, { idToken: "id-token" }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      signInWithPasswordForIdToken("api-key", "u@example.com", "pw"),
    ).resolves.toBe("id-token");

    expect(fetch).toHaveBeenCalledWith(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=api-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "u@example.com",
          password: "pw",
          returnSecureToken: true,
        }),
      }),
    );
  });

  it("exchanges a Firebase ID token with InstantDB", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(true, {
        user: { id: "auth-1", email: "u@example.com" },
        created: true,
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      signInWithFirebaseIdToken("app-1", "firebase", "id-token"),
    ).resolves.toEqual({
      authId: "auth-1",
      email: "u@example.com",
      created: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.instantdb.com/runtime/oauth/id_token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          app_id: "app-1",
          id_token: "id-token",
          client_name: "firebase",
        }),
      }),
    );
  });

  it("composes Firebase and Instant sign-in", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(true, { idToken: "id-token" }))
      .mockResolvedValueOnce(
        jsonResponse(true, {
          user: { id: "auth-1", email: "u@example.com" },
          created: false,
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      resolveInstantAuthId({
        instantAppId: "app-1",
        instantClientName: "firebase",
        firebaseEmail: "u@example.com",
        firebasePassword: "pw",
        firebaseApiKey: "api-key",
      }),
    ).resolves.toEqual({
      authId: "auth-1",
      email: "u@example.com",
      created: false,
    });
  });
});
