import { describe, expect, it, vi } from "vitest";

vi.mock("firebase/app", () => ({ initializeApp: vi.fn() }));
vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
}));

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { signIn } from "./firebaseAuth";

const config = {
  apiKey: "fake-api-key",
  authDomain: "example.firebaseapp.com",
  projectId: "example",
};

function mockAuthFlow(idToken: string) {
  const fakeApp = { name: "[DEFAULT]" };
  const fakeAuth = { currentUser: null };
  vi.mocked(initializeApp).mockReturnValue(fakeApp as never);
  vi.mocked(getAuth).mockReturnValue(fakeAuth as never);
  vi.mocked(signInWithEmailAndPassword).mockResolvedValue({
    user: { getIdToken: vi.fn().mockResolvedValue(idToken) },
  } as never);
  return { fakeApp, fakeAuth };
}

describe("signIn", () => {
  it("initializes the app, signs in, and returns a fresh ID token", async () => {
    const { fakeAuth } = mockAuthFlow("fresh-id-token");

    const result = await signIn(config, "admin@example.com", "hunter2");

    expect(initializeApp).toHaveBeenCalledWith(config);
    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(
      fakeAuth,
      "admin@example.com",
      "hunter2",
    );
    expect(result.idToken).toBe("fresh-id-token");
    expect(result.auth).toBe(fakeAuth);
  });

  it("only initializes the Firebase app once across repeated sign-ins", async () => {
    mockAuthFlow("token-1");
    await signIn(config, "a@example.com", "pw1");
    await signIn(config, "b@example.com", "pw2");

    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it("propagates a sign-in failure rather than swallowing it", async () => {
    mockAuthFlow("unused");
    vi.mocked(signInWithEmailAndPassword).mockRejectedValue(
      new Error("auth/wrong-password"),
    );

    await expect(signIn(config, "a@example.com", "bad")).rejects.toThrow(
      "auth/wrong-password",
    );
  });
});
