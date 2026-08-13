import { describe, expect, it } from "vitest";

import * as blob from "../crypto/blob";
import { bytesToBase64, randomBytes } from "../crypto/bytes";
import { resolveSession, SessionError } from "./session";

const userRootKey = new Uint8Array(300).fill(7);
const umk = new Uint8Array(128).fill(3);
const keyStoreKey = new Uint8Array(128).fill(11);
const privKey = new Uint8Array(3224).fill(13);
const credStoreKey = new Uint8Array(128).fill(17);

async function buildAuthRow(type?: string) {
  const umkBlob = await blob.encrypt(userRootKey, umk);
  return { umk: bytesToBase64(umkBlob), type };
}

async function buildKeyStoreRow() {
  const keyStoreKeyBlob = await blob.encrypt(umk, keyStoreKey);
  const privKeyBlob = await blob.encrypt(keyStoreKey, privKey);
  return {
    pubKey: bytesToBase64(randomBytes(1624)),
    keyStoreKey: bytesToBase64(keyStoreKeyBlob),
    privKey: bytesToBase64(privKeyBlob),
  };
}

async function buildCredStoreRowWithContent(
  contentPayload: Record<string, unknown>,
) {
  const credStoreKeyBlob = await blob.encrypt(umk, credStoreKey);
  const contentBlob = await blob.encrypt(
    credStoreKey,
    new TextEncoder().encode(JSON.stringify(contentPayload)),
    { compressed: true },
  );
  return {
    credStoreKey: bytesToBase64(credStoreKeyBlob),
    content: bytesToBase64(contentBlob),
  };
}

async function buildCredStoreRow(overrides: Record<string, unknown> = {}) {
  return buildCredStoreRowWithContent({
    r2_config: {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
    },
    ...overrides,
  });
}

function fakeDb(queryResult: unknown) {
  return { queryOnce: async () => ({ data: queryResult }) };
}

describe("resolveSession", () => {
  it("unwraps user_root_key -> umk -> keyStore/credStore, no txtAccess/txtBookmarks rows yet", async () => {
    const authRow = await buildAuthRow();
    const keyStoreRow = await buildKeyStoreRow();
    const credStoreRow = await buildCredStoreRow();
    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          keyStore: [{ id: "keystore-1", ...keyStoreRow }],
          credStore: [{ id: "credstore-1", ...credStoreRow }],
          txtAccess: [],
          txtBookmarks: [],
        },
      ],
    });

    const session = await resolveSession(db, "auth-1", userRootKey);

    expect(Array.from(session.umk)).toEqual(Array.from(umk));
    expect(session.isAdmin).toBe(false);
    expect(Array.from(session.keyStorePrivKey)).toEqual(Array.from(privKey));
    expect(Array.from(session.credStoreKey)).toEqual(Array.from(credStoreKey));
    expect(session.r2Config.bucket).toBe("my-bucket");
    expect(session.r2Config).not.toHaveProperty("readWriteAccessKeyId");
    // A user-role self row's r2_config never carries real R2 keys at all.
    expect(session.adminR2WriteCreds).toBeUndefined();
    expect(session.displayName).toBeUndefined();
    // No existing row -- a fresh key was minted, content is empty, id is null.
    expect(session.txtAccess.id).toBeNull();
    expect(session.txtAccess.key).toHaveLength(128);
    expect(session.txtAccess.content).toEqual({});
    expect(session.txtBookmarks.id).toBeNull();
    expect(session.txtBookmarks.content).toEqual({});
  });

  it("marks admin sessions from $users.type", async () => {
    const authRow = await buildAuthRow("admin");
    const keyStoreRow = await buildKeyStoreRow();
    const credStoreRow = await buildCredStoreRow();
    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          keyStore: [{ id: "keystore-1", ...keyStoreRow }],
          credStore: [{ id: "credstore-1", ...credStoreRow }],
          txtAccess: [],
          txtBookmarks: [],
        },
      ],
    });

    const session = await resolveSession(db, "auth-1", userRootKey);

    expect(session.isAdmin).toBe(true);
  });

  it("resolves the admin's own real read-write R2 credential from its self row", async () => {
    const authRow = await buildAuthRow("admin");
    const keyStoreRow = await buildKeyStoreRow();
    const credStoreRow = await buildCredStoreRowWithContent({
      r2_config: {
        endpoint: "https://acct.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "my-bucket",
        read_write_access_key_id: "rw-id",
        read_write_secret_access_key: "rw-secret",
      },
    });
    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          keyStore: [{ id: "keystore-1", ...keyStoreRow }],
          credStore: [{ id: "credstore-1", ...credStoreRow }],
          txtAccess: [],
          txtBookmarks: [],
        },
      ],
    });

    const session = await resolveSession(db, "auth-1", userRootKey);

    expect(session.adminR2WriteCreds).toEqual({
      accessKeyId: "rw-id",
      secretAccessKey: "rw-secret",
    });
  });

  it("skips admin-owned credential escrow rows when resolving its own R2 config", async () => {
    const authRow = await buildAuthRow("admin");
    const keyStoreRow = await buildKeyStoreRow();
    const adminEscrowRow = await buildCredStoreRowWithContent({
      instant_app_id: "app-1",
      instant_client_name: "firebase",
      firebase_email: "bob@example.com",
      firebase_password: "pw",
      firebase_api_key: "api-key",
      user_root_key: bytesToBase64(new Uint8Array(256).fill(5)),
    });
    const ownCredStoreRow = await buildCredStoreRow({
      display_name: "Admin",
    });
    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          keyStore: [{ id: "keystore-1", ...keyStoreRow }],
          credStore: [
            { id: "escrow-1", ...adminEscrowRow },
            { id: "credstore-1", ...ownCredStoreRow },
          ],
          txtAccess: [],
          txtBookmarks: [],
        },
      ],
    });

    const session = await resolveSession(db, "auth-1", userRootKey);

    expect(session.r2Config.bucket).toBe("my-bucket");
    expect(session.displayName).toBe("Admin");
  });

  it("resolves displayName and decodes existing txtAccess/txtBookmarks rows", async () => {
    const authRow = await buildAuthRow();
    const keyStoreRow = await buildKeyStoreRow();
    const credStoreRow = await buildCredStoreRow({ display_name: "Trung" });

    const txtAccessKey = new Uint8Array(128).fill(19);
    const txtAccessKeyBlob = await blob.encrypt(umk, txtAccessKey);
    const accessContentBlob = await blob.encrypt(
      txtAccessKey,
      new TextEncoder().encode(
        JSON.stringify({ "txt-1": { last_part_num: 2, last_accessed: 42 } }),
      ),
      { compressed: true },
    );

    const txtBookmarkKey = new Uint8Array(128).fill(23);
    const txtBookmarkKeyBlob = await blob.encrypt(umk, txtBookmarkKey);
    const bookmarksContentBlob = await blob.encrypt(
      txtBookmarkKey,
      new TextEncoder().encode(
        JSON.stringify({
          "txt-1": [
            { part_num: 1, line: 5, txt_preview: "hi", created_at: 1000 },
          ],
        }),
      ),
      { compressed: true },
    );

    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          keyStore: [{ id: "keystore-1", ...keyStoreRow }],
          credStore: [{ id: "credstore-1", ...credStoreRow }],
          txtAccess: [
            {
              id: "access-1",
              txtAccessKey: bytesToBase64(txtAccessKeyBlob),
              content: bytesToBase64(accessContentBlob),
            },
          ],
          txtBookmarks: [
            {
              id: "bookmarks-1",
              txtBookmarkKey: bytesToBase64(txtBookmarkKeyBlob),
              content: bytesToBase64(bookmarksContentBlob),
            },
          ],
        },
      ],
    });

    const session = await resolveSession(db, "auth-1", userRootKey);

    expect(session.displayName).toBe("Trung");
    expect(session.txtAccess.id).toBe("access-1");
    expect(session.txtAccess.content).toEqual({
      "txt-1": { lastPartNum: 2, lastAccessedMs: 42 },
    });
    expect(session.txtBookmarks.id).toBe("bookmarks-1");
    expect(session.txtBookmarks.content["txt-1"]).toHaveLength(1);
    expect(session.txtBookmarks.content["txt-1"]![0]!.preview).toBe("hi");
  });

  it("treats $users.keyStore as an array (InstaQL's array-wrapped links), not a plain object", async () => {
    const authRow = await buildAuthRow();
    const keyStoreRow = await buildKeyStoreRow();
    const credStoreRow = await buildCredStoreRow();
    // A plain-object keyStore (the pre-fix shape) must NOT resolve.
    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          keyStore: { id: "keystore-1", ...keyStoreRow },
          credStore: [{ id: "credstore-1", ...credStoreRow }],
        },
      ],
    });

    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      SessionError,
    );
  });

  it("throws when there is no $users row for this auth.id", async () => {
    const db = fakeDb({ $users: [] });
    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      "missing linked $users row",
    );
  });

  it("throws when $users is missing umk", async () => {
    const db = fakeDb({
      $users: [{ id: "auth-1", keyStore: [], credStore: [] }],
    });
    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      "missing umk",
    );
  });

  it("throws when there is no own keyStore row", async () => {
    const authRow = await buildAuthRow();
    const db = fakeDb({
      $users: [{ id: "auth-1", ...authRow, keyStore: [], credStore: [] }],
    });
    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      "missing linked keyStore row",
    );
  });

  it("throws when there is no own credStore row", async () => {
    const authRow = await buildAuthRow();
    const keyStoreRow = await buildKeyStoreRow();
    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          keyStore: [{ id: "keystore-1", ...keyStoreRow }],
          credStore: [],
        },
      ],
    });
    await expect(resolveSession(db, "auth-1", userRootKey)).rejects.toThrow(
      "missing linked credStore row",
    );
  });

  it("throws (via blob.decrypt's own AEAD check) on a wrong user_root_key", async () => {
    const authRow = await buildAuthRow();
    const keyStoreRow = await buildKeyStoreRow();
    const credStoreRow = await buildCredStoreRow();
    const db = fakeDb({
      $users: [
        {
          id: "auth-1",
          ...authRow,
          keyStore: [{ id: "keystore-1", ...keyStoreRow }],
          credStore: [{ id: "credstore-1", ...credStoreRow }],
        },
      ],
    });
    const wrongKey = new Uint8Array(300).fill(99);
    await expect(resolveSession(db, "auth-1", wrongKey)).rejects.toThrow();
  });
});
