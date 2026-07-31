import type { Client } from "@libsql/core/api";
import { beforeAll, describe, expect, it } from "vitest";

import * as blob from "../crypto/blob";
import * as kem from "../crypto/kem";
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
};

let umk: Uint8Array;
let umkBlob: Uint8Array;
let pwSalt: Uint8Array;
let pwHash: Uint8Array;

beforeAll(async () => {
  umk = new Uint8Array(64).fill(3);
  umkBlob = await blob.encrypt(creds.userRootKey, umk);
  pwSalt = new Uint8Array(32).fill(5);
  pwHash = await pbkdf2Sha3_256(
    new TextEncoder().encode(creds.password),
    pwSalt,
    PBKDF2_ITERATIONS,
    PW_HASH_LEN,
  );
});

describe("resolveUserAndCheckPassword", () => {
  it("resolves the user id and reports passwordOk: true for the correct password -- one query, not two", async () => {
    const db = fakeClient({
      "FROM users WHERE username_hash": [
        { id: 42, pw_salt: pwSalt.buffer, pw_hash: pwHash.buffer },
      ],
    });
    expect(await owner.resolveUserAndCheckPassword(db, creds)).toEqual({
      userId: 42,
      passwordOk: true,
    });
  });

  it("reports passwordOk: false for the wrong password", async () => {
    const db = fakeClient({
      "FROM users WHERE username_hash": [
        { id: 42, pw_salt: pwSalt.buffer, pw_hash: pwHash.buffer },
      ],
    });
    expect(
      await owner.resolveUserAndCheckPassword(db, { ...creds, password: "wrong-password" }),
    ).toEqual({
      userId: 42,
      passwordOk: false,
    });
  });

  it("throws when no user matches", async () => {
    const db = fakeClient({ "FROM users WHERE username_hash": [] });
    await expect(owner.resolveUserAndCheckPassword(db, creds)).rejects.toThrow(owner.OwnerError);
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
    const configBlob = await blob.encrypt(umk, new TextEncoder().encode(JSON.stringify(r2Json)), {
      compressed: true,
    });
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

describe("unwrapPrivKey", () => {
  it("decrypts key_store.priv_key with the umk", async () => {
    const privKey = new Uint8Array(2000).fill(13);
    const privKeyBlob = await blob.encrypt(umk, privKey);
    const db = fakeClient({ "FROM key_store": [{ priv_key: privKeyBlob.buffer }] });
    const result = await owner.unwrapPrivKey(db, 42, umk);
    expect(Array.from(result)).toEqual(Array.from(privKey));
  });

  it("throws when no key_store row exists", async () => {
    const db = fakeClient({ "FROM key_store": [] });
    await expect(owner.unwrapPrivKey(db, 42, umk)).rejects.toThrow(owner.OwnerError);
  });
});

describe("unwrapTxtKey / partRawPaths / partRawPath / partCount", () => {
  const privKey = new Uint8Array(64).fill(0); // unused on the owned-txt path below

  it("unwraps a txt_key, decrypts every part's path, and counts parts", async () => {
    const txtKey = new Uint8Array(64).fill(11);
    const txtKeyBlob = await blob.encrypt(umk, txtKey);
    const path1 = await blob.encrypt(
      txtKey,
      new TextEncoder().encode("0000000000000000000000000000001"),
    );
    const path2 = await blob.encrypt(
      txtKey,
      new TextEncoder().encode("0000000000000000000000000000002"),
    );

    const db = fakeClient({
      "FROM txt WHERE id": [{ txt_key: txtKeyBlob.buffer }],
      "FROM txt_parts": [{ path: path1.buffer }, { path: path2.buffer }],
      "FROM part_count": [{ count: 2 }],
    });

    const unwrapped = await owner.unwrapTxtKey(db, 7, 42, umk, privKey);
    expect(Array.from(unwrapped)).toEqual(Array.from(txtKey));

    expect(await owner.partRawPaths(db, 7, txtKey)).toEqual([
      "0000000000000000000000000000001",
      "0000000000000000000000000000002",
    ]);

    expect(await owner.partCount(db, 7)).toBe(2);
  });

  it("partRawPath decrypts a single part's path -- one row-read, not every part in the document", async () => {
    const txtKey = new Uint8Array(64).fill(11);
    const path1 = await blob.encrypt(
      txtKey,
      new TextEncoder().encode("0000000000000000000000000000001"),
    );
    const db = fakeClient({ "FROM txt_parts": [{ path: path1.buffer }] });
    expect(await owner.partRawPath(db, 7, 1, txtKey)).toBe("0000000000000000000000000000001");
  });

  it("partRawPath returns null when that part doesn't exist", async () => {
    const txtKey = new Uint8Array(64).fill(11);
    const db = fakeClient({ "FROM txt_parts": [] });
    expect(await owner.partRawPath(db, 7, 99, txtKey)).toBeNull();
  });

  it("unwrapTxtKey scopes both the owned-txt query and its txt_shares fallback by this account's own id", async () => {
    // Reader's /read/:txtId comes straight from a client-supplied route
    // param, with no prior ownership check -- unlike every other lookup in
    // this file, txtId here isn't already known to belong to this session.
    // An unscoped "WHERE id = ?" would let a signed-in user distinguish "this
    // txt_id exists (for someone else)" from "it doesn't" via a decrypt
    // failure vs. a not-found error, an existence oracle across accounts --
    // and the txt_shares fallback below reopens that same oracle unless
    // *it's* scoped too ("exists but isn't mine, and isn't shared to me
    // either" must land on the identical not-found branch as "doesn't exist
    // at all"). Asserting the executed SQL/args here (rather than just the
    // return value) is what actually catches a regression that silently
    // drops either predicate.
    const calls: { sql: string; args: unknown[] }[] = [];
    const db = {
      async execute({ sql, args }: { sql: string; args?: unknown[] }) {
        calls.push({ sql, args: args ?? [] });
        return {
          rows: [],
          columns: [],
          columnTypes: [],
          rowsAffected: 0,
          lastInsertRowid: undefined,
          toJSON: () => ({}),
        };
      },
    } as unknown as Client;

    await expect(owner.unwrapTxtKey(db, 7, 42, umk, privKey)).rejects.toThrow(owner.OwnerError);
    expect(calls[0].sql).toMatch(/FROM txt WHERE id = \? AND user_id = \?/);
    expect(calls[0].args).toEqual([7, 42]);
    expect(calls[1].sql).toMatch(/FROM txt_shares WHERE txt_id = \? AND to_user_id = \?/);
    expect(calls[1].args).toEqual([7, 42]);
  });

  it("falls back to txt_shares (Decapsulated via this account's own key_store.priv_key) when the txt isn't owned", async () => {
    const { pk, sk } = await kem.keypair();
    const txtKey = new Uint8Array(64).fill(11);
    const { saltKemCt, blob: wrappedTxtKey } = await kem.wrap(pk, txtKey);

    const db = fakeClient({
      "FROM txt WHERE id": [], // not owned
      "FROM txt_shares": [{ salt_kem_ct: saltKemCt.buffer, txt_key: wrappedTxtKey.buffer }],
    });

    const unwrapped = await owner.unwrapTxtKey(db, 7, 42, umk, sk);
    expect(Array.from(unwrapped)).toEqual(Array.from(txtKey));
  });

  it("throws when the txt is neither owned nor shared to this account", async () => {
    const db = fakeClient({ "FROM txt WHERE id": [], "FROM txt_shares": [] });
    await expect(owner.unwrapTxtKey(db, 7, 42, umk, privKey)).rejects.toThrow(owner.OwnerError);
  });
});
