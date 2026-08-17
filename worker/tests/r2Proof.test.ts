import { describe, expect, it } from "vitest";

import {
  P521_SIGNATURE_BYTES,
  canonicalR2Proof,
  isStoragePath,
  requireP521Signature,
  storagePathBinding,
} from "../../shared/r2Proof";

const DB_PATH = "0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk";
const DB_PREFIX = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("R2 proof encoding", () => {
  it("matches the version 1 golden vector", async () => {
    const proof = await canonicalR2Proof({
      version: 1,
      uid: "firebase-user-123",
      firebaseIdToken: "header.payload.signature",
      expiresAt: 1_800_000_000,
      requestId: Uint8Array.from({ length: 32 }, (_, index) => index),
      dbPath: DB_PATH,
      dbPrefix: DB_PREFIX,
    });

    expect(hex(proof)).toBe(
      "7478743a72322d746f6b656e2d70726f6f6600000000010000001166697265626173652d757365722d313233256d04db4e5e4ac308751ed0885b722b758630567c53a7125ed9fbd068e5c3f6000000006b49d200000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fbcecf24300dff23804e13645f9eb6b1231262d717559966430b124c82ed0cbc8118055ee29d7f08bf49d0008142148d0eaf4e7267b0d01d195d233dfe90513ec",
    );
  });

  it("matches the storage path binding golden vector", async () => {
    expect(hex(await storagePathBinding(DB_PATH, DB_PREFIX))).toBe(
      "bcecf24300dff23804e13645f9eb6b1231262d717559966430b124c82ed0cbc8118055ee29d7f08bf49d0008142148d0eaf4e7267b0d01d195d233dfe90513ec",
    );
  });

  it("accepts only exact lowercase Crockford storage paths", () => {
    expect(isStoragePath(DB_PATH)).toBe(true);
    expect(isStoragePath(DB_PATH.slice(1))).toBe(false);
    expect(isStoragePath(`${DB_PATH.slice(0, -1)}i`)).toBe(false);
    expect(isStoragePath(DB_PATH.toUpperCase())).toBe(false);
  });

  it("requires raw 66-byte r plus 66-byte s signatures", () => {
    expect(() =>
      requireP521Signature(new Uint8Array(P521_SIGNATURE_BYTES)),
    ).not.toThrow();
    expect(() =>
      requireP521Signature(new Uint8Array(P521_SIGNATURE_BYTES - 1)),
    ).toThrow("P-521 signature must be exactly 132 bytes");
  });
});
