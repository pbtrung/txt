import { describe, expect, it } from "vitest";

import {
  P521_SIGNATURE_BYTES,
  canonicalR2TicketProof,
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
  it("matches the storage path binding golden vector", async () => {
    expect(hex(await storagePathBinding(DB_PATH, DB_PREFIX))).toBe(
      "bcecf24300dff23804e13645f9eb6b1231262d717559966430b124c82ed0cbc8118055ee29d7f08bf49d0008142148d0eaf4e7267b0d01d195d233dfe90513ec",
    );
  });

  it("binds version 2 proofs to the exact ticket and decrypted handle", async () => {
    const input = {
      version: 2,
      ticket: "header.payload.signature",
      userHandle: new Uint8Array(32).fill(7),
      expiresAt: 1_800_000_000,
      requestId: new Uint8Array(32).fill(8),
      dbPath: DB_PATH,
      dbPrefix: DB_PREFIX,
    };
    const canonical = await canonicalR2TicketProof(input);
    const changedTicket = await canonicalR2TicketProof({ ...input, ticket: "other" });
    const changedHandle = await canonicalR2TicketProof({
      ...input,
      userHandle: new Uint8Array(32).fill(9),
    });
    expect(canonical).not.toEqual(changedTicket);
    expect(canonical).not.toEqual(changedHandle);
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
