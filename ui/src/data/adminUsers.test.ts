import type { Client } from "@libsql/core/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { base64ToBytes, bytesToBase64 } from "../crypto/bytes";
import { hmacSha3_256, pbkdf2Sha3_256 } from "../crypto/leancryptoLoader";
import { PBKDF2_ITERATIONS, PW_HASH_LEN } from "../crypto/constants";
import * as adminUsers from "./adminUsers";
import type { R2Config } from "./r2Config";

vi.mock("./adminTxt", () => ({ deleteTxtRows: vi.fn() }));
import { deleteTxtRows } from "./adminTxt";

function emptyResult() {
  return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

function rowsResult(rows: Record<string, unknown>[]) {
  return { ...emptyResult(), rows };
}

const ADMIN_R2_CONFIG: R2Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-bucket",
  readOnlyAccessKeyId: "ro-id",
  readOnlySecretAccessKey: "ro-secret",
};

describe("createUser", () => {
  it("provisions every row, returning a downloadable credential JSON that round-trips", async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const execute = vi.fn(async ({ sql, args }: { sql: string; args?: unknown[] }) => {
      calls.push({ sql, args: args ?? [] });
      if (sql.startsWith("INSERT INTO users")) {
        return { ...emptyResult(), lastInsertRowid: 99n };
      }
      return emptyResult();
    });
    const db = { execute } as unknown as Client;

    const adminUmk = new Uint8Array(64).fill(9);
    const creds = await adminUsers.createUser(db, adminUmk, "libsql://example", ADMIN_R2_CONFIG, {
      username: "bob",
      password: "hunter2",
      displayName: "Bob",
      userTursoAuthToken: "user-token",
    });

    expect(creds.turso_database_url).toBe("libsql://example");
    expect(creds.turso_auth_token).toBe("user-token");
    expect(creds.username).toBe("bob");
    expect(creds.password).toBe("hunter2");
    expect(creds.display_name).toBe("Bob");

    const usernameLookupKey = base64ToBytes(creds.username_lookup_key);
    const userRootKey = base64ToBytes(creds.user_root_key);
    expect(usernameLookupKey.length).toBeGreaterThanOrEqual(32);
    expect(userRootKey.length).toBeGreaterThanOrEqual(256);

    // 7 INSERTs, then the users.creds UPDATE asserted separately below.
    const tableNames = calls.slice(0, 7).map((c) => c.sql.match(/INTO (\w+)/)?.[1]);
    expect(tableNames).toEqual([
      "users",
      "umk_store",
      "key_store",
      "r2_config",
      "txt_metadata",
      "txt_access",
      "bookmarks",
    ]);

    // users row: username_hash matches HMAC(usernameLookupKey, username).
    const usersCall = calls[0];
    const expectedHash = await hmacSha3_256(usernameLookupKey, new TextEncoder().encode("bob"));
    expect(Array.from(usersCall.args[0] as Uint8Array)).toEqual(Array.from(expectedHash));

    // umk_store: decrypts under the returned user_root_key.
    const umkCall = calls[1];
    const umk = await blob.decrypt(userRootKey, umkCall.args[1] as Uint8Array);
    expect(umk.length).toBe(64);

    // key_store: priv_key decrypts under umk.
    const keyStoreCall = calls[2];
    const priv = await blob.decrypt(umk, keyStoreCall.args[2] as Uint8Array);
    expect(priv.length).toBeGreaterThan(0);

    // r2_config: decrypts under umk to the admin's read-only key values, no read_write fields.
    const r2Call = calls[3];
    const r2Plain = await blob.decrypt(umk, r2Call.args[1] as Uint8Array, true);
    const r2Json = JSON.parse(new TextDecoder().decode(r2Plain));
    expect(r2Json).toEqual({
      endpoint: ADMIN_R2_CONFIG.endpoint,
      region: ADMIN_R2_CONFIG.region,
      bucket: ADMIN_R2_CONFIG.bucket,
      read_only_access_key_id: ADMIN_R2_CONFIG.readOnlyAccessKeyId,
      read_only_secret_access_key: ADMIN_R2_CONFIG.readOnlySecretAccessKey,
    });
    expect(r2Json.read_write_access_key_id).toBeUndefined();

    // txt_metadata: content column is NULL (inlined in the SQL, not a bound arg).
    const metadataCall = calls[4];
    expect(metadataCall.sql).toContain("NULL");
    expect(metadataCall.args).toHaveLength(2);

    // txt_access/bookmarks: both start as an encrypted empty object.
    for (const call of [calls[5], calls[6]]) {
      const key = await blob.decrypt(umk, call.args[1] as Uint8Array);
      const value = await blob.decrypt(key, call.args[2] as Uint8Array, true);
      expect(JSON.parse(new TextDecoder().decode(value))).toEqual({});
    }

    // users.creds: the returned credential JSON, wrapped under the admin's
    // own umk (not the new user's) -- an UPDATE, not one of the seven INSERTs above.
    const updateCall = calls[7];
    expect(updateCall.sql).toContain("UPDATE users SET creds");
    const credsPlain = await blob.decrypt(adminUmk, updateCall.args[0] as Uint8Array, true);
    expect(JSON.parse(new TextDecoder().decode(credsPlain))).toEqual(creds);
  });
});

describe("listUsersWithInfo", () => {
  it("returns each user's id, recovered display name, and txt count", async () => {
    const adminUmk = new Uint8Array(64).fill(9);
    const credsJson = { display_name: "Bob", username: "bob" };
    const credsBlob = await blob.encrypt(adminUmk, new TextEncoder().encode(JSON.stringify(credsJson)), {
      compressed: true,
    });
    const execute = vi.fn(async ({ sql }: { sql: string }) => {
      if (sql.startsWith("SELECT id, creds")) {
        return rowsResult([
          { id: 1, creds: null }, // the admin's own row -- always NULL
          { id: 2, creds: credsBlob.buffer },
          { id: 3, creds: null }, // never populated (e.g. predates this feature)
        ]);
      }
      if (sql.includes("GROUP BY user_id")) {
        return rowsResult([
          { user_id: 1, count: 5 },
          { user_id: 2, count: 0 },
        ]);
      }
      return emptyResult();
    });
    const db = { execute } as unknown as Client;

    const result = await adminUsers.listUsersWithInfo(db, adminUmk);

    expect(result).toEqual([
      { id: 1, displayName: undefined, bookCount: 5 },
      { id: 2, displayName: "Bob", bookCount: 0 },
      { id: 3, displayName: undefined, bookCount: 0 },
    ]);
  });

  it("leaves displayName undefined (not throwing) when creds can't be decrypted", async () => {
    const adminUmk = new Uint8Array(64).fill(9);
    const wrongKeyBlob = await blob.encrypt(new Uint8Array(64).fill(1), new TextEncoder().encode("{}"), {
      compressed: true,
    });
    const execute = vi.fn(async ({ sql }: { sql: string }) => {
      if (sql.startsWith("SELECT id, creds")) return rowsResult([{ id: 2, creds: wrongKeyBlob.buffer }]);
      return emptyResult();
    });
    const db = { execute } as unknown as Client;

    const result = await adminUsers.listUsersWithInfo(db, adminUmk);

    expect(result).toEqual([{ id: 2, displayName: undefined, bookCount: 0 }]);
  });
});

describe("updateUserPassword", () => {
  it("writes a pw_salt/pw_hash pair that verifies against the new password", async () => {
    let persistedSalt: Uint8Array | null = null;
    let persistedHash: Uint8Array | null = null;
    const execute = vi.fn(async ({ args }: { args?: unknown[] }) => {
      persistedSalt = args?.[0] as Uint8Array;
      persistedHash = args?.[1] as Uint8Array;
      return emptyResult();
    });
    const db = { execute } as unknown as Client;

    await adminUsers.updateUserPassword(db, 7, "new-password");

    const recomputed = await pbkdf2Sha3_256(
      new TextEncoder().encode("new-password"),
      persistedSalt!,
      PBKDF2_ITERATIONS,
      PW_HASH_LEN,
    );
    expect(Array.from(recomputed)).toEqual(Array.from(persistedHash!));
  });
});

describe("rotateUserRootKey", () => {
  it("re-wraps the existing umk under a fresh key, preserving its bytes", async () => {
    const oldRootKey = new Uint8Array(256).fill(1);
    const umk = new Uint8Array(64).fill(7);
    const umkBlob = await blob.encrypt(oldRootKey, umk);
    let persistedBlob: Uint8Array | null = null;
    const execute = vi.fn(async ({ sql, args }: { sql: string; args?: unknown[] }) => {
      if (sql.startsWith("SELECT")) return rowsResult([{ umk: umkBlob.buffer }]);
      persistedBlob = args?.[0] as Uint8Array;
      return emptyResult();
    });
    const db = { execute } as unknown as Client;

    const newRootKeyBase64 = await adminUsers.rotateUserRootKey(db, 7, bytesToBase64(oldRootKey));

    const newRootKey = base64ToBytes(newRootKeyBase64);
    const recoveredUmk = await blob.decrypt(newRootKey, persistedBlob!);
    expect(Array.from(recoveredUmk)).toEqual(Array.from(umk));
  });

  it("throws a clear error for the wrong current root key", async () => {
    const umkBlob = await blob.encrypt(new Uint8Array(256).fill(1), new Uint8Array(64).fill(7));
    const execute = vi.fn().mockResolvedValue(rowsResult([{ umk: umkBlob.buffer }]));
    const db = { execute } as unknown as Client;

    await expect(adminUsers.rotateUserRootKey(db, 7, bytesToBase64(new Uint8Array(256).fill(9)))).rejects.toThrow(
      adminUsers.AdminUsersError,
    );
  });

  it("throws when the user has no umk_store row", async () => {
    const execute = vi.fn().mockResolvedValue(rowsResult([]));
    const db = { execute } as unknown as Client;
    await expect(adminUsers.rotateUserRootKey(db, 7, bytesToBase64(new Uint8Array(256)))).rejects.toThrow(
      adminUsers.AdminUsersError,
    );
  });
});

describe("deleteUser", () => {
  beforeEach(() => {
    vi.mocked(deleteTxtRows).mockClear();
  });

  it("rejects deleting the caller's own account without touching the DB", async () => {
    const execute = vi.fn();
    const db = { execute } as unknown as Client;
    await expect(adminUsers.deleteUser(db, 42, 42)).rejects.toThrow(adminUsers.AdminUsersError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("deletes every owned txt, dangling shares, then every account-level row", async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const execute = vi.fn(async ({ sql, args }: { sql: string; args?: unknown[] }) => {
      calls.push({ sql, args: args ?? [] });
      if (sql.startsWith("SELECT id FROM txt")) return rowsResult([{ id: 10 }, { id: 11 }]);
      return emptyResult();
    });
    const db = { execute } as unknown as Client;

    await adminUsers.deleteUser(db, 42, 7);

    expect(deleteTxtRows).toHaveBeenCalledTimes(2);
    expect(deleteTxtRows).toHaveBeenNthCalledWith(1, db, 10);
    expect(deleteTxtRows).toHaveBeenNthCalledWith(2, db, 11);

    const tables = calls.slice(1).map((c) => c.sql.match(/FROM (\w+)/)?.[1]);
    expect(tables).toEqual([
      "txt_shares",
      "key_store",
      "r2_config",
      "txt_metadata",
      "txt_access",
      "bookmarks",
      "umk_store",
      "users",
    ]);
    for (const call of calls) {
      expect(call.args).toContain(7);
    }
  });
});
