import { afterEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../ctl";
import { issueR2Ticket, verifyR2Ticket } from "../r2Ticket";

const SECRET = toBase64(new Uint8Array(32).fill(3));
const OTHER_SECRET = toBase64(new Uint8Array(32).fill(4));
const ACCOUNT: Account = {
  type: "user",
  umk: "dW1r",
  signVersion: 1,
  signAlgorithm: "ECDSA-P521-SHA512",
  signPublicKey: toBase64(new Uint8Array(158).fill(5)),
  signPrivateKey: "cHJpdmF0ZQ==",
  userHandleHash: toBase64(new Uint8Array(32).fill(6)),
  dbBindingHash: toBase64(new Uint8Array(64).fill(7)),
  credStoreContent: "Y29udGVudA==",
};

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("R2 binding tickets", () => {
  it("round-trips claims and uses a 32-byte standard-base64 id", async () => {
    const encoded = await issueR2Ticket(ACCOUNT, "uid-123", SECRET, "admin-uid");
    const ticket = await verifyR2Ticket(encoded, SECRET);
    expect(ticket).toMatchObject({
      subject: "uid-123",
      accountType: "user",
      signVersion: 1,
      signAlgorithm: "ECDSA-P521-SHA512",
    });
    expect(ticket?.userHandleHash).toEqual(new Uint8Array(32).fill(6));
    expect(ticket?.dbBindingHash).toEqual(new Uint8Array(64).fill(7));
    expect(ticket?.ticketId).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("rejects another signing secret and a modified compact ticket", async () => {
    const encoded = await issueR2Ticket(ACCOUNT, "uid-123", SECRET, "admin-uid");
    expect(await verifyR2Ticket(encoded, OTHER_SECRET)).toBeNull();
    expect(await verifyR2Ticket(`${encoded.slice(0, -1)}x`, SECRET)).toBeNull();
  });

  it("expires after 24 hours without an active revocation lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00Z"));
    const encoded = await issueR2Ticket(ACCOUNT, "uid-123", SECRET, "admin-uid");
    vi.setSystemTime(new Date("2026-08-20T00:00:01Z"));
    expect(await verifyR2Ticket(encoded, SECRET)).toBeNull();
  });

  it("derives administrator role only from the trusted uid", async () => {
    const encoded = await issueR2Ticket(ACCOUNT, "admin-uid", SECRET, "admin-uid");
    expect((await verifyR2Ticket(encoded, SECRET))?.accountType).toBe("admin");
  });
});
