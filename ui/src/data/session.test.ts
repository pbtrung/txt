import { describe, expect, it } from "vitest";

import * as blob from "../crypto/blob";
import { bytesToBase64 } from "../crypto/bytes";
import { resolveSession, SessionError } from "./session";

const userRootKey = new Uint8Array(300).fill(7);
const umk = new Uint8Array(128).fill(3);
const pathKey = new Uint8Array(128).fill(5);
const dbKey = new Uint8Array(256).fill(9);

async function buildAuthRow() {
  const umkBlob = await blob.encrypt(userRootKey, umk);
  return { umk: bytesToBase64(umkBlob) };
}

async function buildCredStoreRow(overrides: Record<string, unknown> = {}) {
  const contentPayload = {
    r2_config: {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
      read_only_access_key_id: "ro-id",
      read_only_secret_access_key: "ro-secret",
      read_write_access_key_id: "rw-id",
      read_write_secret_access_key: "rw-secret",
    },
    path_key: bytesToBase64(pathKey),
    db_key: bytesToBase64(dbKey),
    ...overrides,
  };
  // compressed:true -- matches txt/adminInit.ts's wrapCredStoreContent, the
  // real producer of this row's content (blobEncrypt(..., true)). Encrypting
  // uncompressed here would let session.ts's own decrypt call get away with
  // omitting compressed:true too -- exactly the real bug this fixture missed
  // once (session.ts silently decrypted to raw brotli bytes instead of JSON
  // text, failing JSON.parse with a confusing error, not a decrypt error).
  const contentBlob = await blob.encrypt(
    umk,
    new TextEncoder().encode(JSON.stringify(contentPayload)),
    { compressed: true },
  );
  return { content: bytesToBase64(contentBlob) };
}

function fakeDb(queryResult: unknown) {
  return { queryOnce: async () => ({ data: queryResult }) };
}

describe("resolveSession", () => {
  it("unwraps user_root_key -> umk -> credStore.content and resolves dbMeta coordinates", async () => {
    const authRow = await buildAuthRow();
    const credStoreRow = await buildCredStoreRow();
    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          dbMeta: [
            {
              id: "dbmeta-1",
              currentVersion: 3,
              pageCount: 7,
              pageSize: 32768,
            },
          ],
        },
      ],
      credStore: [{ id: "credstore-1", ...credStoreRow }],
    });

    const session = await resolveSession(db, "auth-1", userRootKey);

    expect(session.dbMetaId).toBe("dbmeta-1");
    expect(session.currentVersion).toBe(3);
    expect(session.pageCount).toBe(7);
    expect(session.pageSize).toBe(32768);
    expect(Array.from(session.pathKey)).toEqual(Array.from(pathKey));
    expect(Array.from(session.dbKey)).toEqual(Array.from(dbKey));
    expect(session.r2Config.bucket).toBe("my-bucket");
    // The stored r2_config still carries read_only/read_write keys (the
    // CLI's own use), but this account's browser session must never parse
    // them -- see r2Config.ts's header comment.
    expect(session.r2Config).not.toHaveProperty("readWriteAccessKeyId");
    expect(session.r2Config).not.toHaveProperty("readOnlyAccessKeyId");
    // No display_name in this content payload -- must come back undefined,
    // not thrown, so VaultContext.tsx's unlock() can fall further back to
    // the unlock file's own display_name/the signed-in email.
    expect(session.displayName).toBeUndefined();
  });

  it("resolves displayName from credStore.content.display_name when set", async () => {
    const authRow = await buildAuthRow();
    const credStoreRow = await buildCredStoreRow({ display_name: "Trung" });
    const db = fakeDb({
      $users: [{ id: "auth-1", ...authRow, dbMeta: [{ id: "dbmeta-1" }] }],
      credStore: [{ id: "credstore-1", ...credStoreRow }],
    });

    const session = await resolveSession(db, "auth-1", userRootKey);

    expect(session.displayName).toBe("Trung");
  });

  it("treats $users.dbMeta as an array (InstaQL's array-wrapped links), not a plain object", async () => {
    const authRow = await buildAuthRow();
    const credStoreRow = await buildCredStoreRow();
    // A plain-object dbMeta (the pre-fix shape) must NOT resolve -- this
    // guards against silently regressing to reading .dbMeta.id directly.
    const db = fakeDb({
      $users: [{ id: "auth-1", ...authRow, dbMeta: { id: "dbmeta-1" } }],
      credStore: [{ id: "credstore-1", ...credStoreRow }],
    });

    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      SessionError,
    );
  });

  it("throws when there is no $users row for this auth.id", async () => {
    const db = fakeDb({ $users: [], credStore: [] });
    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      "missing linked $users row",
    );
  });

  it("throws when the $users row has no linked dbMeta", async () => {
    const authRow = await buildAuthRow();
    const db = fakeDb({
      $users: [{ id: "auth-1", ...authRow, dbMeta: [] }],
      credStore: [],
    });
    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      "missing linked dbMeta row",
    );
  });

  it("throws when $users is missing umk", async () => {
    const db = fakeDb({
      $users: [{ id: "auth-1", dbMeta: [{ id: "dbmeta-1" }] }],
      credStore: [],
    });
    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      "missing umk",
    );
  });

  it("throws when there is no own credStore row", async () => {
    const authRow = await buildAuthRow();
    const db = fakeDb({
      $users: [{ id: "auth-1", ...authRow, dbMeta: [{ id: "dbmeta-1" }] }],
      credStore: [],
    });
    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      "missing linked credStore row",
    );
  });

  it("throws (via blob.decrypt's own AEAD check) on a wrong user_root_key", async () => {
    const authRow = await buildAuthRow();
    const credStoreRow = await buildCredStoreRow();
    const db = fakeDb({
      $users: [{ id: "auth-1", ...authRow, dbMeta: [{ id: "dbmeta-1" }] }],
      credStore: [{ id: "credstore-1", ...credStoreRow }],
    });
    const wrongKey = new Uint8Array(300).fill(99);
    await expect(resolveSession(db, "auth-1", wrongKey)).rejects.toThrow();
  });
});
