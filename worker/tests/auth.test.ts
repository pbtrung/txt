import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerToken, verifiedUid } from "../auth";
import { verifyFirebaseIdToken } from "../firebaseAuth";

vi.mock("../firebaseAuth");

afterEach(() => {
  vi.resetAllMocks();
});

describe("bearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    const request = new Request("https://x", {
      headers: { Authorization: "Bearer abc.def.ghi" },
    });
    expect(bearerToken(request)).toBe("abc.def.ghi");
  });

  it("returns null when there is no Authorization header", () => {
    expect(bearerToken(new Request("https://x"))).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    const request = new Request("https://x", {
      headers: { Authorization: "Basic abc" },
    });
    expect(bearerToken(request)).toBeNull();
  });
});

describe("verifiedUid", () => {
  it("returns null when there is no bearer token", async () => {
    expect(await verifiedUid(new Request("https://x"), "proj")).toBeNull();
  });

  it("returns null when verification throws", async () => {
    vi.mocked(verifyFirebaseIdToken).mockRejectedValue(new Error("bad"));
    const request = new Request("https://x", {
      headers: { Authorization: "Bearer bad" },
    });
    expect(await verifiedUid(request, "proj")).toBeNull();
  });

  it("returns the uid when verification succeeds", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    const request = new Request("https://x", {
      headers: { Authorization: "Bearer good" },
    });
    expect(await verifiedUid(request, "proj")).toBe("uid-123");
  });
});
