import { beforeEach, describe, expect, it, vi } from "vitest";

function nsProxy(namespace: string) {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === "string"
          ? {
              update: (payload: unknown) => ({
                link: (links: unknown) => ({
                  namespace,
                  id: prop,
                  payload,
                  links,
                }),
              }),
              delete: () => ({ namespace, id: prop, delete: true }),
            }
          : undefined,
    },
  );
}

let idCounter = 0;
vi.mock("@instantdb/react", () => ({
  id: vi.fn(() => `id-${++idCounter}`),
  tx: {
    sharedTxt: nsProxy("sharedTxt"),
    sharedTxtMetadata: nsProxy("sharedTxtMetadata"),
    sharedTxtParts: nsProxy("sharedTxtParts"),
  },
}));

// Identity crypto -- same convention adminUsers.test.ts already uses for
// admin-side operations: this test cares about which bytes flow where, not
// about re-verifying the real AEAD (covered elsewhere, e.g. crypto/blob's
// own tests). base64(bytes) in a fixture round-trips to the same bytes out.
vi.mock("../crypto/blob", () => ({
  encrypt: vi.fn(async (_ikm: Uint8Array, payload: Uint8Array) => payload),
  decrypt: vi.fn(async (_ikm: Uint8Array, payload: Uint8Array) => payload),
}));

const r2Objects = new Map<string, Uint8Array>();
vi.mock("./r2", () => ({
  buildAdminWriteClient: vi.fn(() => ({ fake: "client" })),
  getObject: vi.fn(async (_client: unknown, _config: unknown, key: string) => {
    const body = r2Objects.get(key);
    if (!body) throw new Error(`no fake R2 object for ${key}`);
    return body;
  }),
  putObject: vi.fn(
    async (
      _client: unknown,
      _config: unknown,
      key: string,
      body: Uint8Array,
    ) => {
      r2Objects.set(key, body);
    },
  ),
}));

vi.mock("./adminUsers", () => ({
  getUserCreds: vi.fn(),
}));

import * as blob from "../crypto/blob";
import { base64ToBytes, bytesToBase64 } from "../crypto/bytes";
import {
  AdminSharesError,
  grantShare,
  listShares,
  revokeShare,
  type AdminSharesSession,
} from "./adminShares";
import { getUserCreds } from "./adminUsers";
import { getObject, putObject } from "./r2";

function encodedJson(json: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(json)));
}

function encodedText(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

const sourceDocKey = new Uint8Array([1, 2, 3]);
const partKeyPlain = new Uint8Array([21, 22, 23]);
const recipientUmkPlain = new Uint8Array([31, 32, 33]);
const sourceContent = { name: "book.txt", metadata: { title: "A Book" } };
const sourceBody = new Uint8Array([100, 101, 102]);

const session: AdminSharesSession = {
  authId: "admin-1",
  umk: new Uint8Array([9]),
  credStoreKey: new Uint8Array([10]),
  r2Config: { endpoint: "https://r2.example", region: "auto", bucket: "b" },
  adminR2WriteCreds: { accessKeyId: "ak", secretAccessKey: "sk" },
  instantToken: "tok",
  docKeys: new Map([["txt-1", sourceDocKey]]),
};

function fakeDb(handler: (query: any) => unknown) {
  return {
    queryOnce: vi.fn(async (query: any) => ({ data: handler(query) })),
    transact: vi.fn().mockResolvedValue(undefined),
  };
}

function dbHandler(query: any): unknown {
  if (query.$users) {
    return {
      $users: [{ id: "user-2", umk: bytesToBase64(recipientUmkPlain) }],
    };
  }
  if (query.txt) {
    return {
      txt: [
        {
          prefix: encodedText("source-prefix"),
          txtMetadata: [{ id: "meta-1", content: encodedJson(sourceContent) }],
          txtParts: [
            {
              id: "part-1",
              partNum: 1,
              txtPartKey: bytesToBase64(partKeyPlain),
              path: encodedText("raw-key-1"),
            },
          ],
        },
      ],
    };
  }
  return {};
}

beforeEach(() => {
  vi.clearAllMocks();
  idCounter = 0;
  r2Objects.clear();
  r2Objects.set("source-prefix/raw-key-1", sourceBody);
  (getUserCreds as any).mockResolvedValue({
    instantAppId: "app-1",
    instantClientName: "firebase",
    firebaseEmail: "bob@example.com",
    firebasePassword: "pw",
    firebaseApiKey: "api-key",
    displayName: "Bob",
    userRootKey: bytesToBase64(new Uint8Array([41, 42, 43])),
  });
});

describe("listShares", () => {
  it("lists paginated sharedTxt rows with linked txt/fromUser/owner ids", async () => {
    const db = fakeDb((query) => {
      if (query.sharedTxt.$.offset > 0) return { sharedTxt: [] };
      return {
        sharedTxt: [
          {
            id: "share-1",
            txt: [{ id: "txt-1" }],
            fromUser: [{ id: "admin-1" }],
            owner: [{ id: "user-2" }],
          },
          { id: "share-missing", txt: [], fromUser: [], owner: [] },
        ],
      };
    });

    await expect(listShares(db)).resolves.toEqual([
      {
        id: "share-1",
        txtId: "txt-1",
        fromUserId: "admin-1",
        toUserId: "user-2",
      },
    ]);
  });
});

describe("grantShare", () => {
  it("copies the document's content and key material to an independent sharedTxt row", async () => {
    const db = fakeDb(dbHandler);

    await grantShare(db, session, "txt-1", "user-2");

    expect(db.transact).toHaveBeenCalledOnce();
    const chunks = db.transact.mock.calls[0]![0] as any[];
    expect(chunks).toHaveLength(3); // sharedTxt + sharedTxtMetadata + 1 part

    const sharedTxtChunk = chunks.find((c) => c.namespace === "sharedTxt")!;
    expect(sharedTxtChunk.payload.shareKey).toBe("txt-1:admin-1:user-2");
    expect(sharedTxtChunk.links).toEqual({
      txt: "txt-1",
      owner: "user-2",
      fromUser: "admin-1",
    });
    // adminTxtKey/userTxtKey wrap the *same* root key bytes under two
    // different accounts' umk -- with identity crypto, both fields must
    // decode to the exact same bytes.
    const adminTxtKey = await blob.decrypt(
      session.umk,
      base64ToBytes(sharedTxtChunk.payload.adminTxtKey),
    );
    const userTxtKey = await blob.decrypt(
      recipientUmkPlain,
      base64ToBytes(sharedTxtChunk.payload.userTxtKey),
    );
    expect(Array.from(adminTxtKey)).toEqual(Array.from(userTxtKey));

    const metadataChunk = chunks.find(
      (c) => c.namespace === "sharedTxtMetadata",
    )!;
    expect(metadataChunk.links).toEqual({
      sharedTxt: sharedTxtChunk.id,
      owner: "user-2",
    });
    const content = JSON.parse(
      new TextDecoder().decode(base64ToBytes(metadataChunk.payload.content)),
    );
    expect(content).toEqual(sourceContent);

    const partChunk = chunks.find((c) => c.namespace === "sharedTxtParts")!;
    expect(partChunk.payload.partNum).toBe(1);
    expect(partChunk.payload.partKey).toBe(`${sharedTxtChunk.id}:1`);
    expect(partChunk.links).toEqual({
      sharedTxt: sharedTxtChunk.id,
      owner: "user-2",
    });

    // The re-keyed part's ciphertext must have been uploaded, and (identity
    // crypto) must round-trip to the exact same bytes the source object had.
    expect(putObject).toHaveBeenCalledOnce();
    const uploadedKey = (putObject as any).mock.calls[0][2] as string;
    const uploadedBody = r2Objects.get(uploadedKey);
    expect(Array.from(uploadedBody!)).toEqual(Array.from(sourceBody));
    expect(getObject).toHaveBeenCalledWith(
      { fake: "client" },
      session.r2Config,
      "source-prefix/raw-key-1",
    );
  });

  it("reports upload progress and a final saving step", async () => {
    const db = fakeDb(dbHandler);
    const progress: string[] = [];

    await grantShare(db, session, "txt-1", "user-2", (label) =>
      progress.push(label),
    );

    expect(progress).toEqual([
      "Looking up recipient",
      "Reading document",
      "Encrypting for recipient",
      "Uploading 0/1",
      "Uploading 1/1",
      "Saving",
    ]);
  });

  it("rejects sharing to the current admin account", async () => {
    const db = fakeDb(dbHandler);

    await expect(grantShare(db, session, "txt-1", "admin-1")).rejects.toThrow(
      AdminSharesError,
    );
    expect(db.queryOnce).not.toHaveBeenCalled();
    expect(db.transact).not.toHaveBeenCalled();
  });

  it("rejects when the admin session has no document key for the txt", async () => {
    const db = fakeDb(dbHandler);

    await expect(
      grantShare(db, { ...session, docKeys: new Map() }, "txt-1", "user-2"),
    ).rejects.toThrow(AdminSharesError);
    expect(db.queryOnce).not.toHaveBeenCalled();
    expect(db.transact).not.toHaveBeenCalled();
  });

  it("rejects when the session has no admin R2 write credential", async () => {
    const db = fakeDb(dbHandler);

    await expect(
      grantShare(
        db,
        { ...session, adminR2WriteCreds: undefined },
        "txt-1",
        "user-2",
      ),
    ).rejects.toThrow(AdminSharesError);
    expect(db.transact).not.toHaveBeenCalled();
  });

  it("rejects when the recipient has no admin-owned recovery credStore row", async () => {
    (getUserCreds as any).mockResolvedValue(null);
    const db = fakeDb(dbHandler);

    await expect(grantShare(db, session, "txt-1", "user-2")).rejects.toThrow(
      AdminSharesError,
    );
    expect(db.transact).not.toHaveBeenCalled();
  });

  it("rejects when the recipient's own $users row has no umk", async () => {
    const db = fakeDb((query) => {
      if (query.$users) return { $users: [{ id: "user-2" }] };
      return dbHandler(query);
    });

    await expect(grantShare(db, session, "txt-1", "user-2")).rejects.toThrow(
      AdminSharesError,
    );
    expect(db.transact).not.toHaveBeenCalled();
  });
});

describe("revokeShare", () => {
  it("deletes the sharedTxt row", async () => {
    const db = fakeDb(() => ({}));

    await revokeShare(db, "share-1");

    expect(db.transact).toHaveBeenCalledWith([
      { namespace: "sharedTxt", id: "share-1", delete: true },
    ]);
  });
});
