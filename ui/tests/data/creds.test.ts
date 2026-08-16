import { describe, expect, it } from "vitest";
import { parseBrowserCreds } from "../../src/data/creds";

const VALID = {
  firebase_email: "a@b.com",
  firebase_password: "pw",
  firebase_api_key: "key",
  user_root_key: "dW1r",
};

describe("parseBrowserCreds", () => {
  it("accepts a fully populated creds.json", () => {
    expect(parseBrowserCreds(VALID)).toEqual(VALID);
  });

  it("rejects a missing top-level field", () => {
    const { user_root_key: _drop, ...rest } = VALID;
    expect(() => parseBrowserCreds(rest)).toThrow(/user_root_key/);
  });

  it("rejects a missing firebase_api_key", () => {
    const { firebase_api_key: _drop, ...rest } = VALID;
    expect(() => parseBrowserCreds(rest)).toThrow(/firebase_api_key/);
  });
});
