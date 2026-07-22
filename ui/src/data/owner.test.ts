import type { Client } from "@libsql/core/api";
import { beforeAll, describe, expect, it } from "vitest";

import * as blob from "../crypto/blob";
import { pbkdf2Sha3_256 } from "../crypto/leancryptoLoader";
import { PBKDF2_ITERATIONS, PW_HASH_LEN } from "../crypto/constants";
import type { Creds } from "./creds";
import * as owner from "./owner";

// A minimal fake @libsql/client Client: routes execute() by matching
// distinctive substrings in the SQL text to canned rows built from a small
// in-memory "vault" encrypted with our own crypto layer (trusted from
// blob.test.ts/kem.test.ts) -- this exercises the real decrypt/unwrap
// pipeline end-to-end without a live Turso database.
function fakeClient(rows: Record<string, unknown[]>): Client {
  return {
    async execute({ sql }: { sql: string; args?: unknown[] }) {
      for (const [needle, resultRows] of Object.entries(rows)) {
        if (sql.includes(needle)) {
          return {
            rows: resultRows,
            columns: [],
            columnTypes: [],
            rowsAffected: 0,
            lastInsertRowid: undefined,
            toJSON: () => ({}),
          };
        }
      }
      throw new Error(`fakeClient: no handler for SQL: ${sql}`);
    },
  } as unknown as Client;
}

const creds: Creds = {
  tursoDatabaseUrl: "libsql://example",
  tursoAuthToken: "token",
  username: "alice",
  usernameLookupKey: new Uint8Array(32).fill(7),
  password: "hunter2",
  displayName: "Alice",
  userRootKey: new Uint8Array(256).fill(9),
  assetSignKey: new Uint8Array(64).fill(3),
  assetHashes: new Uint8Array(192).fill(4),
};

let umk: Uint8Array;
let umkBlob: Uint8Array;
let pwSalt: Uint8Array;
let pwHash: Uint8Array;

beforeAll(async () => {
  umk = new Uint8Array(64).fill(3);
  umkBlob = await blob.encrypt(creds.userRootKey, umk);
  pwSalt = new Uint8Array(32).fill(5);
  pwHash = await pbkdf2Sha3_256(new TextEncoder().encode(creds.password), pwSalt, PBKDF2_ITERATIONS, PW_HASH_LEN);
});

describe("resolveUserId", () => {
  it("returns the matching user's id", async () => {
    const db = fakeClient({ "FROM users WHERE username_hash": [{ id: 42 }] });
    expect(await owner.resolveUserId(db, creds)).toBe(42);
  });

  it("throws when no user matches", async () => {
    const db = fakeClient({ "FROM users WHERE username_hash": [] });
    await expect(owner.resolveUserId(db, creds)).rejects.toThrow(owner.OwnerError);
  });
});

describe("checkPassword", () => {
  it("returns true for the correct password", async () => {
    const db = fakeClient({
      "FROM users WHERE id": [{ pw_salt: pwSalt.buffer, pw_hash: pwHash.buffer }],
    });
    expect(await owner.checkPassword(db, 42, "hunter2")).toBe(true);
  });

  it("returns false for the wrong password", async () => {
    const db = fakeClient({
      "FROM users WHERE id": [{ pw_salt: pwSalt.buffer, pw_hash: pwHash.buffer }],
    });
    expect(await owner.checkPassword(db, 42, "wrong-password")).toBe(false);
  });

  it("returns false when no user row exists", async () => {
    const db = fakeClient({ "FROM users WHERE id": [] });
    expect(await owner.checkPassword(db, 42, "hunter2")).toBe(false);
  });
});

describe("unwrapUmk", () => {
  it("decrypts umk_store.umk with the user_root_key", async () => {
    const db = fakeClient({ "FROM umk_store": [{ umk: umkBlob.buffer }] });
    const result = await owner.unwrapUmk(db, creds, 42);
    expect(Array.from(result)).toEqual(Array.from(umk));
  });

  it("throws when no umk_store row exists", async () => {
    const db = fakeClient({ "FROM umk_store": [] });
    await expect(owner.unwrapUmk(db, creds, 42)).rejects.toThrow(owner.OwnerError);
  });
});

describe("fetchR2Config", () => {
  it("decrypts and parses r2_config.config", async () => {
    const r2Json = {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
      read_only_access_key_id: "ro-id",
      read_only_secret_access_key: "ro-secret",
    };
    const configBlob = await blob.encrypt(umk, new TextEncoder().encode(JSON.stringify(r2Json)), { compressed: true });
    const db = fakeClient({ "FROM r2_config": [{ config: configBlob.buffer }] });
    const result = await owner.fetchR2Config(db, 42, umk);
    expect(result).toEqual({
      endpoint: r2Json.endpoint,
      region: "auto",
      bucket: "my-bucket",
      readOnlyAccessKeyId: "ro-id",
      readOnlySecretAccessKey: "ro-secret",
    });
  });
});

describe("listTxtIds / unwrapTxtKey / partRawPaths / partCount", () => {
  it("lists txt ids, unwraps a txt_key, and decrypts part paths", async () => {
    const txtKey = new Uint8Array(64).fill(11);
    const txtKeyBlob = await blob.encrypt(umk, txtKey);
    const path1 = await blob.encrypt(txtKey, new TextEncoder().encode("0000000000000000000000000000001"));
    const path2 = await blob.encrypt(txtKey, new TextEncoder().encode("0000000000000000000000000000002"));

    const db = fakeClient({
      "FROM txt WHERE user_id": [{ id: 7 }, { id: 8 }],
      "FROM txt WHERE id": [{ txt_key: txtKeyBlob.buffer }],
      "FROM txt_parts": [{ path: path1.buffer }, { path: path2.buffer }],
      "FROM part_count": [{ count: 2 }],
    });

    expect(await owner.listTxtIds(db, 42)).toEqual([7, 8]);

    const unwrapped = await owner.unwrapTxtKey(db, 7, umk);
    expect(Array.from(unwrapped)).toEqual(Array.from(txtKey));

    expect(await owner.partRawPaths(db, 7, txtKey)).toEqual([
      "0000000000000000000000000000001",
      "0000000000000000000000000000002",
    ]);

    expect(await owner.partCount(db, 7)).toBe(2);
  });
});
