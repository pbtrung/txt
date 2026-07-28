import type { AwsClient } from "aws4fetch";
import type { Client } from "@libsql/core/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { bytesToBase64 } from "../crypto/bytes";
import * as kem from "../crypto/kem";
import * as adminShares from "./adminShares";
import * as r2 from "./r2";
import type { R2Config } from "./r2Config";

vi.mock("./r2", () => ({ getObject: vi.fn(), putObject: vi.fn() }));

const r2Client = {} as AwsClient;
const r2Config: R2Config = {
  endpoint: "https://example",
  region: "auto",
  bucket: "bucket",
  readOnlyAccessKeyId: "id",
  readOnlySecretAccessKey: "secret",
};

function emptyResult() {
  return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

function rowsResult(rows: Record<string, unknown>[]) {
  return { ...emptyResult(), rows };
}

// Routes execute() by matching a distinctive substring in the SQL text --
// same convention owner.test.ts/metadata.test.ts already use -- and records
// every call (sql + args) so tests can assert both what was read and what
// was written, and in what order.
function fakeClient(rowsBySubstring: Record<string, Record<string, unknown>[]>) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    async execute({ sql, args }: { sql: string; args?: unknown[] }) {
      calls.push({ sql, args: args ?? [] });
      for (const [needle, rows] of Object.entries(rowsBySubstring)) {
        if (sql.includes(needle)) return rowsResult(rows);
      }
      return emptyResult();
    },
  } as unknown as Client;
  return { db, calls };
}

/** A regular user's escrowed creds (users.creds, wrapped under the admin's
 * own umk) plus the umk_store row that creds' user_root_key unwraps --
 * everything resolveUserUmk (adminUsers.ts) needs to recover recipientUmk,
 * built the same way adminUsers.ts's generateNewUser actually produces it. */
async function recipientEscrowFixture(adminUmk: Uint8Array, recipientUmk: Uint8Array) {
  const userRootKey = new Uint8Array(256).fill(9);
  const downloadable = {
    turso_database_url: "libsql://example",
    turso_auth_token: "token",
    username: "bob",
    username_lookup_key: bytesToBase64(new Uint8Array(32).fill(7)),
    password: "hunter2",
    display_name: "Bob",
    user_root_key: bytesToBase64(userRootKey),
  };
  const credsBlob = await blob.encrypt(adminUmk, new TextEncoder().encode(JSON.stringify(downloadable)), {
    compressed: true,
  });
  const umkBlob = await blob.encrypt(userRootKey, recipientUmk);
  return { credsBlob, umkBlob };
}

describe("listShares", () => {
  it("lists every share, unfiltered -- only the admin ever owns/shares txt", async () => {
    const execute = vi.fn(async ({ sql, args }: { sql: string; args?: unknown[] }) => {
      expect(sql).toBe("SELECT id, txt_id, to_user_id FROM txt_shares");
      expect(args).toEqual([]);
      return rowsResult([
        { id: 1, txt_id: 7, to_user_id: 3 },
        { id: 2, txt_id: 9, to_user_id: 4 },
      ]);
    });
    const db = { execute } as unknown as Client;

    const shares = await adminShares.listShares(db);

    expect(shares).toEqual([
      { id: 1, txtId: 7, toUserId: 3 },
      { id: 2, txtId: 9, toUserId: 4 },
    ]);
  });
});

describe("grantShare", () => {
  afterEach(() => {
    vi.mocked(r2.getObject).mockReset();
    vi.mocked(r2.putObject).mockReset();
  });

  it("copies the entry into the recipient's own txt_metadata (before the share insert), then wraps+inserts the share", async () => {
    const { pk, sk } = await kem.keypair();
    const txtKey = new Uint8Array(64).fill(3);
    const entry = { name: "book.txt" };
    const adminUmk = new Uint8Array(64).fill(1);
    const recipientUmk = new Uint8Array(64).fill(2);
    const txtMetadataKey = new Uint8Array(64).fill(4);

    const { credsBlob, umkBlob } = await recipientEscrowFixture(adminUmk, recipientUmk);
    const txtMetadataKeyBlob = await blob.encrypt(recipientUmk, txtMetadataKey);

    let putBody: Uint8Array | null = null;
    vi.mocked(r2.putObject).mockImplementation(async (_client, _config, _key, body) => {
      putBody = body;
    });

    const { db, calls } = fakeClient({
      "SELECT pub_key FROM key_store": [{ pub_key: pk.buffer }],
      "SELECT creds FROM users": [{ creds: credsBlob.buffer }],
      "SELECT umk FROM umk_store": [{ umk: umkBlob.buffer }],
      "SELECT txt_metadata_key, content FROM txt_metadata": [{ txt_metadata_key: txtMetadataKeyBlob.buffer, content: null }],
    });

    await adminShares.grantShare(db, 7, txtKey, 42, entry, adminUmk, r2Client, r2Config);

    // Recipient's own txt_metadata got a fresh R2 path holding this entry.
    expect(r2.putObject).toHaveBeenCalledTimes(1);
    const decryptedContent = await blob.decrypt(txtMetadataKey, putBody!, true);
    expect(JSON.parse(new TextDecoder().decode(decryptedContent))).toEqual({ "7": entry });
    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE txt_metadata"));
    expect(updateCall?.args[1]).toBe(42);

    // The share itself: wrapped for the recipient's real pub_key, same as before.
    const insertCall = calls.find((c) => c.sql.startsWith("INSERT INTO txt_shares"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.args[0]).toBe(7);
    expect(insertCall!.args[1]).toBe(42);
    const recovered = await kem.unwrap(sk, insertCall!.args[2] as Uint8Array, insertCall!.args[3] as Uint8Array);
    expect(Array.from(recovered)).toEqual(Array.from(txtKey));

    // Metadata write lands before the share insert -- a failure partway
    // through never leaves a dangling txt_shares row.
    const updateIdx = calls.findIndex((c) => c.sql.startsWith("UPDATE txt_metadata"));
    const insertIdx = calls.findIndex((c) => c.sql.startsWith("INSERT INTO txt_shares"));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeLessThan(insertIdx);
  });

  it("throws when the recipient has no key_store row", async () => {
    const { db } = fakeClient({});
    await expect(
      adminShares.grantShare(db, 7, new Uint8Array(64), 42, { name: "x" }, new Uint8Array(64), r2Client, r2Config),
    ).rejects.toThrow(adminShares.AdminSharesError);
  });

  it("throws when the recipient's umk can't be recovered via their escrowed creds", async () => {
    const { pk } = await kem.keypair();
    const { db } = fakeClient({
      "SELECT pub_key FROM key_store": [{ pub_key: pk.buffer }],
      // No users.creds row at all -- resolveUserUmk comes back null.
    });
    await expect(
      adminShares.grantShare(db, 7, new Uint8Array(64), 42, { name: "x" }, new Uint8Array(64), r2Client, r2Config),
    ).rejects.toThrow(adminShares.AdminSharesError);
    expect(r2.putObject).not.toHaveBeenCalled();
  });
});

describe("revokeShare", () => {
  afterEach(() => {
    vi.mocked(r2.getObject).mockReset();
    vi.mocked(r2.putObject).mockReset();
  });

  it("removes the recipient's copied metadata entry, then deletes the share row", async () => {
    const adminUmk = new Uint8Array(64).fill(1);
    const recipientUmk = new Uint8Array(64).fill(2);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const { credsBlob, umkBlob } = await recipientEscrowFixture(adminUmk, recipientUmk);
    const txtMetadataKeyBlob = await blob.encrypt(recipientUmk, txtMetadataKey);
    const content = { "7": { name: "book.txt" }, "8": { name: "other.txt" } };
    const existingBody = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });
    const pathBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode("existing-path"));
    vi.mocked(r2.getObject).mockResolvedValue(existingBody);
    let putBody: Uint8Array | null = null;
    vi.mocked(r2.putObject).mockImplementation(async (_client, _config, _key, body) => {
      putBody = body;
    });

    const { db, calls } = fakeClient({
      "SELECT creds FROM users": [{ creds: credsBlob.buffer }],
      "SELECT umk FROM umk_store": [{ umk: umkBlob.buffer }],
      "SELECT txt_metadata_key, content FROM txt_metadata": [{ txt_metadata_key: txtMetadataKeyBlob.buffer, content: pathBlob.buffer }],
    });

    await adminShares.revokeShare(db, 5, 7, 42, adminUmk, r2Client, r2Config);

    const decrypted = await blob.decrypt(txtMetadataKey, putBody!, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({ "8": { name: "other.txt" } });

    const deleteCall = calls.find((c) => c.sql.startsWith("DELETE FROM txt_shares"));
    expect(deleteCall?.args).toEqual([5]);
  });

  it("still deletes the share row even when the recipient's umk can't be recovered (best-effort cleanup)", async () => {
    const { db, calls } = fakeClient({});
    await adminShares.revokeShare(db, 5, 7, 42, new Uint8Array(64), r2Client, r2Config);
    expect(r2.putObject).not.toHaveBeenCalled();
    const deleteCall = calls.find((c) => c.sql.startsWith("DELETE FROM txt_shares"));
    expect(deleteCall?.args).toEqual([5]);
  });
});
