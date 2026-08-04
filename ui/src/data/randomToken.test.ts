import { describe, expect, it } from "vitest";

import { generateRandomToken, unwrapToken, wrapToken } from "./randomToken";
import { randomBytes } from "../crypto/bytes";

describe("randomToken", () => {
  it("generateRandomToken produces a 52-char crockford-base32 string (32 random bytes)", () => {
    const token = generateRandomToken();
    expect(token).toHaveLength(52);
    expect(token).not.toMatch(/[ilou]/);
  });

  it("wrapToken/unwrapToken round-trip", async () => {
    const ikm = randomBytes(128);
    const token = generateRandomToken();
    const wrapped = await wrapToken(ikm, token);
    const unwrapped = await unwrapToken(ikm, wrapped);
    expect(unwrapped).toBe(token);
  });

  it("unwrapToken fails under the wrong key", async () => {
    const token = generateRandomToken();
    const wrapped = await wrapToken(randomBytes(128), token);
    await expect(unwrapToken(randomBytes(128), wrapped)).rejects.toThrow();
  });
});
