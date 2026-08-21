import { describe, expect, it } from "vitest";
import { parseBrowserCreds } from "../../src/data/creds";

const VALID = {
  rqlite_admin_username: "admin",
  rqlite_admin_password: "rqlite-secret",
  rqlite_db_url: "https://api.example.com/operator/rqlite",
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

  it("rejects non-object credentials", () => {
    expect(() => parseBrowserCreds(null)).toThrow(/must be an object/);
    expect(() => parseBrowserCreds([])).toThrow(/must be an object/);
  });

  it("rejects non-string and blank fields", () => {
    expect(() => parseBrowserCreds({ ...VALID, firebase_email: 42 })).toThrow(
      /firebase_email/,
    );
    expect(() => parseBrowserCreds({ ...VALID, firebase_password: " " })).toThrow(
      /firebase_password/,
    );
  });

  it("drops unrelated top-level fields", () => {
    expect(parseBrowserCreds({ ...VALID, turso_org_token: "secret" })).toEqual(VALID);
  });

  it("accepts a localhost HTTP operator URL for development", () => {
    const creds = {
      ...VALID,
      rqlite_db_url: "http://localhost:8080/operator/rqlite/",
    };
    expect(parseBrowserCreds(creds)).toEqual(creds);
  });

  it("rejects an unsafe or incorrectly scoped rqlite URL", () => {
    for (const rqlite_db_url of [
      "http://api.example.com/operator/rqlite",
      "ftp://localhost/operator/rqlite",
      "https://api.example.com/v1",
      "https://api.example.com/operator/rqlite?node=1",
    ]) {
      expect(() => parseBrowserCreds({ ...VALID, rqlite_db_url })).toThrow(
        /rqlite_db_url/,
      );
    }
  });
});
