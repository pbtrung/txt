import { describe, expect, it } from "vitest";

import { decodeJwtPayload, isAdminToken } from "./jwt";

const ADMIN_VERBS = [
  "data_read",
  "data_add",
  "data_update",
  "data_delete",
  "schema_add",
  "schema_update",
  "schema_delete",
];

function fakeJwt(payload: unknown): string {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base64url({ alg: "EdDSA" })}.${base64url(payload)}.fake-signature`;
}

describe("decodeJwtPayload", () => {
  it("decodes the middle segment as JSON", () => {
    const token = fakeJwt({ hello: "world" });
    expect(decodeJwtPayload(token)).toEqual({ hello: "world" });
  });

  it("throws for a string with no dot-separated segments", () => {
    expect(() => decodeJwtPayload("not-a-jwt")).toThrow();
  });
});

describe("isAdminToken", () => {
  it("is true for the exact admin shape (matches the real example payload)", () => {
    const token = fakeJwt({
      iat: 1700000000,
      id: "abc123",
      kid: "key1",
      perm: [{ t: null, a: ADMIN_VERBS }],
      rid: "db1",
    });
    expect(isAdminToken(token)).toBe(true);
  });

  it("is true regardless of verb order", () => {
    const token = fakeJwt({ perm: [{ t: null, a: [...ADMIN_VERBS].reverse() }] });
    expect(isAdminToken(token)).toBe(true);
  });

  it("is false for a regular user's multi-entry, per-table shape", () => {
    const token = fakeJwt({
      perm: [
        { t: "users", a: ["data_read"] },
        { t: "txt", a: ["data_read"] },
        { t: "txt_access", a: ["data_read", "data_add", "data_update"] },
        { t: "bookmarks", a: ["data_read", "data_add", "data_update"] },
      ],
    });
    expect(isAdminToken(token)).toBe(false);
  });

  it("is false when a verb is missing", () => {
    const token = fakeJwt({ perm: [{ t: null, a: ADMIN_VERBS.slice(0, -1) }] });
    expect(isAdminToken(token)).toBe(false);
  });

  it("is false when an extra verb is present", () => {
    const token = fakeJwt({ perm: [{ t: null, a: [...ADMIN_VERBS, "something_else"] }] });
    expect(isAdminToken(token)).toBe(false);
  });

  it("is false when t is a table name instead of null", () => {
    const token = fakeJwt({ perm: [{ t: "all", a: ADMIN_VERBS }] });
    expect(isAdminToken(token)).toBe(false);
  });

  it("is false for more than one perm entry, even if the first is admin-shaped", () => {
    const token = fakeJwt({
      perm: [
        { t: null, a: ADMIN_VERBS },
        { t: "txt", a: ["data_read"] },
      ],
    });
    expect(isAdminToken(token)).toBe(false);
  });

  it("is false, not throwing, for a malformed/non-JWT string", () => {
    expect(isAdminToken("garbage")).toBe(false);
  });

  it("is false, not throwing, for a JWT whose payload isn't JSON", () => {
    expect(isAdminToken("aGVhZGVy.bm90LWpzb24.sig")).toBe(false);
  });

  it("is false when perm is missing entirely", () => {
    const token = fakeJwt({ iat: 1700000000 });
    expect(isAdminToken(token)).toBe(false);
  });
});
