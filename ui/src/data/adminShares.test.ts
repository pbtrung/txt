import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@instantdb/react", () => ({
  id: vi.fn(() => "share-new"),
  tx: {
    txtShares: new Proxy(
      {},
      {
        get: (_target, prop) =>
          typeof prop === "string"
            ? {
                update: (payload: unknown) => ({
                  link: (links: unknown) => ({
                    namespace: "txtShares",
                    id: prop,
                    payload,
                    links,
                  }),
                }),
                delete: () => ({
                  namespace: "txtShares",
                  id: prop,
                  delete: true,
                }),
              }
            : undefined,
      },
    ),
  },
}));
vi.mock("./leancrypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./leancrypto")>();
  return {
    ...actual,
    kemEncapsulate: vi.fn(async () => ({
      ct: new Uint8Array(1624).fill(4),
      ss: new Uint8Array(88).fill(9),
    })),
  };
});

import * as blob from "../crypto/blob";
import { base64ToBytes, bytesToBase64 } from "../crypto/bytes";
import {
  AdminSharesError,
  grantShare,
  listShares,
  revokeShare,
  type AdminSharesSession,
} from "./adminShares";
import { kemEncapsulate } from "./leancrypto";

const txtKey = new Uint8Array(128).fill(7);
const pubKey = new Uint8Array(1624).fill(3);
const session: AdminSharesSession = {
  authId: "admin-1",
  docKeys: new Map([["txt-1", txtKey]]),
};

function fakeDb(handler: (query: any) => unknown) {
  return {
    queryOnce: vi.fn(async (query: any) => ({ data: handler(query) })),
    transact: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listShares", () => {
  it("lists paginated share rows with linked txt/from/to ids", async () => {
    const db = fakeDb((query) => {
      if (query.txtShares.$.offset > 0) return { txtShares: [] };
      return {
        txtShares: [
          {
            id: "share-1",
            txt: [{ id: "txt-1" }],
            fromUser: [{ id: "admin-1" }],
            toUser: [{ id: "user-2" }],
          },
          { id: "share-missing", txt: [], fromUser: [], toUser: [] },
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
  it("wraps a document key to the recipient pubKey and creates a txtShares row", async () => {
    const db = fakeDb((query) => {
      if (query.keyStore) {
        return { keyStore: [{ id: "key-1", pubKey: bytesToBase64(pubKey) }] };
      }
      return {};
    });

    await grantShare(db, session, "txt-1", "user-2");

    expect(kemEncapsulate).toHaveBeenCalledWith(pubKey);
    expect(db.transact).toHaveBeenCalledOnce();
    const chunk = db.transact.mock.calls[0]![0][0] as {
      id: string;
      payload: { shareKey: string; kemCt: string; txtKey: string };
      links: { txt: string; fromUser: string; toUser: string };
    };
    expect(chunk.id).toBe("share-new");
    expect(chunk.payload.shareKey).toBe("txt-1:admin-1:user-2");
    expect(base64ToBytes(chunk.payload.kemCt)).toEqual(
      new Uint8Array(1624).fill(4),
    );
    await expect(
      blob.decrypt(
        new Uint8Array(88).fill(9),
        base64ToBytes(chunk.payload.txtKey),
      ),
    ).resolves.toEqual(txtKey);
    expect(chunk.links).toEqual({
      txt: "txt-1",
      fromUser: "admin-1",
      toUser: "user-2",
    });
  });

  it("rejects sharing to the current admin account", async () => {
    const db = fakeDb(() => ({}));

    await expect(grantShare(db, session, "txt-1", "admin-1")).rejects.toThrow(
      AdminSharesError,
    );
    expect(db.queryOnce).not.toHaveBeenCalled();
    expect(db.transact).not.toHaveBeenCalled();
  });

  it("rejects when the recipient has no keyStore row", async () => {
    const db = fakeDb(() => ({ keyStore: [] }));

    await expect(grantShare(db, session, "txt-1", "user-2")).rejects.toThrow(
      AdminSharesError,
    );
    expect(db.transact).not.toHaveBeenCalled();
  });

  it("rejects when the admin session has no document key for the txt", async () => {
    const db = fakeDb(() => ({}));

    await expect(
      grantShare(db, { ...session, docKeys: new Map() }, "txt-1", "user-2"),
    ).rejects.toThrow(AdminSharesError);
    expect(db.queryOnce).not.toHaveBeenCalled();
    expect(db.transact).not.toHaveBeenCalled();
  });
});

describe("revokeShare", () => {
  it("deletes the txtShares row", async () => {
    const db = fakeDb(() => ({}));

    await revokeShare(db, "share-1");

    expect(db.transact).toHaveBeenCalledWith([
      { namespace: "txtShares", id: "share-1", delete: true },
    ]);
  });
});
