import { describe, expect, it } from "vitest";
import { parseBrowserCreds } from "../../src/data/creds";
import { toBase64 } from "../../src/util/base64";

const USER_ROOT_KEY = toBase64(new Uint8Array(256).fill(9));
const VALID = { user_root_key: USER_ROOT_KEY };

describe("parseBrowserCreds", () => {
  it("accepts a valid unlock file", () => {
    expect(parseBrowserCreds(VALID)).toEqual(VALID);
  });

  it("rejects a missing user_root_key", () => {
    expect(() => parseBrowserCreds({})).toThrow(/user_root_key/);
  });

  it("rejects non-object input", () => {
    expect(() => parseBrowserCreds(null)).toThrow(/must be an object/);
    expect(() => parseBrowserCreds([])).toThrow(/must be an object/);
  });

  it("rejects a non-string or blank user_root_key", () => {
    expect(() => parseBrowserCreds({ user_root_key: 42 })).toThrow(/user_root_key/);
    expect(() => parseBrowserCreds({ user_root_key: " " })).toThrow(/user_root_key/);
  });

  it("rejects a user_root_key of the wrong length", () => {
    expect(() =>
      parseBrowserCreds({ user_root_key: toBase64(new Uint8Array(255)) }),
    ).toThrow(/256 bytes/);
  });

  it("drops unrelated top-level fields", () => {
    expect(parseBrowserCreds({ ...VALID, retired_field: "unused" })).toEqual(VALID);
  });
});
