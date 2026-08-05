import { beforeEach, describe, expect, it, vi } from "vitest";

import { base64ToBytes, bytesToBase64 } from "../crypto/bytes";
import {
  AdminUsersError,
  createUser,
  deleteUser,
  getUserCreds,
  listUsersWithInfo,
  updateUserCreds,
  type AdminUserSession,
  type UserCredentialFields,
} from "./adminUsers";

vi.mock("../crypto/blob", () => ({
  encrypt: vi.fn(async (_ikm: Uint8Array, payload: Uint8Array) => payload),
  decrypt: vi.fn(async (_ikm: Uint8Array, payload: Uint8Array) => payload),
}));
vi.mock("./leancrypto", () => ({
  kemKeypair: vi.fn(async () => ({
    pubKey: new Uint8Array([1, 2, 3]),
    privKey: new Uint8Array([4, 5, 6]),
  })),
}));
vi.mock("./instantAuth", () => ({
  resolveInstantAuthId: vi.fn(),
}));

import { resolveInstantAuthId } from "./instantAuth";

const rootKey = bytesToBase64(new Uint8Array(256).fill(7));
const oldRootKey = bytesToBase64(new Uint8Array(256).fill(8));

const session: AdminUserSession = {
  authId: "admin-1",
  umk: new Uint8Array([9]),
  credStoreKey: new Uint8Array([10]),
  r2Config: { endpoint: "https://r2.example", region: "auto", bucket: "b" },
};

const input: UserCredentialFields = {
  instantAppId: "app-1",
  instantClientName: "firebase",
  firebaseEmail: "bob@example.com",
  firebasePassword: "pw",
  firebaseApiKey: "api-key",
  displayName: "Bob",
  userRootKey: rootKey,
};

function encodedJson(json: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(json)));
}

function fakeDb(handler: (query: any) => unknown) {
  return {
    queryOnce: vi.fn(async (query: any) => ({ data: handler(query) })),
    transact: vi.fn().mockResolvedValue(undefined),
  };
}

function storedCreds(overrides: Record<string, unknown> = {}) {
  return {
    instant_app_id: "app-1",
    instant_client_name: "firebase",
    firebase_email: "bob@example.com",
    firebase_password: "pw",
    firebase_api_key: "api-key",
    user_root_key: oldRootKey,
    ...overrides,
  };
}

function userCredStore(
  id: string,
  content: Record<string, unknown>,
  keyByte = 12,
) {
  return {
    id,
    credStoreKey: bytesToBase64(new Uint8Array([keyByte])),
    content: encodedJson({
      r2_config: {
        endpoint: "https://r2.example",
        region: "auto",
        bucket: "b",
      },
      ...content,
    }),
  };
}

function adminEscrowRow(
  id = "escrow-1",
  content: Record<string, unknown> = storedCreds(),
  keyByte = 13,
  forUserId = "user-2",
) {
  return {
    id,
    credStoreKey: bytesToBase64(new Uint8Array([keyByte])),
    content: encodedJson(content),
    forUser: [{ id: forUserId }],
  };
}

function decodedContent(row: { content: string }): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder().decode(base64ToBytes(row.content)),
  ) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adminUsers", () => {
  it("lists users with display names recovered from their own credential rows", async () => {
    const adminEscrow = adminEscrowRow();
    const adminOwnCredStore = userCredStore("admin-cred-1", {
      display_name: "Admin",
    });
    const userOwnCredStore = userCredStore("user-cred-1", {
      display_name: "Robert",
    });
    const db = fakeDb((query) => {
      if (query.$users?.$?.where?.id === "admin-1") {
        return {
          $users: [
            {
              id: "admin-1",
              credStore: [adminEscrow, adminOwnCredStore],
            },
          ],
        };
      }
      return {
        $users: [
          {
            id: "admin-1",
            email: "admin@example.com",
            type: "admin",
            credStore: [adminEscrow, adminOwnCredStore],
          },
          {
            id: "user-2",
            email: "bob@example.com",
            type: "user",
            umk: bytesToBase64(new Uint8Array([11])),
            credStore: [userOwnCredStore],
          },
          {
            id: "user-3",
            email: "fallback@example.com",
            type: "user",
            credStore: [],
          },
        ],
      };
    });

    await expect(listUsersWithInfo(db, session)).resolves.toEqual([
      {
        id: "admin-1",
        email: "admin@example.com",
        displayName: "Admin",
        isAdmin: true,
      },
      {
        id: "user-2",
        email: "bob@example.com",
        displayName: "Robert",
        isAdmin: false,
      },
      {
        id: "user-3",
        email: "fallback@example.com",
        displayName: "fallback@example.com",
        isAdmin: false,
      },
    ]);
  });

  it("creates a provisioned Instant user and an admin-owned credential escrow row", async () => {
    vi.mocked(resolveInstantAuthId).mockResolvedValue({
      authId: "user-2",
      email: "bob@example.com",
      created: true,
    });
    const db = fakeDb((query) => {
      if (query.keyStore) return { keyStore: [] };
      return {};
    });

    await expect(createUser(db, session, input)).resolves.toBe("user-2");

    expect(resolveInstantAuthId).toHaveBeenCalledWith(input);
    expect(db.transact).toHaveBeenCalledOnce();
    const chunks = db.transact.mock.calls[0]![0];
    expect(chunks).toHaveLength(4);
    expect(JSON.stringify(chunks)).not.toContain('"type"');
    expect(
      chunks.flatMap((chunk: { __ops?: unknown[] }) => chunk.__ops ?? []),
    ).toEqual(
      expect.arrayContaining([
        [
          "link",
          "credStore",
          expect.any(String),
          { owner: "user-2", forUser: "user-2" },
        ],
        [
          "link",
          "credStore",
          expect.any(String),
          { owner: "admin-1", forUser: "user-2" },
        ],
      ]),
    );
    const ops: unknown[] = chunks.flatMap(
      (chunk: { __ops?: unknown[] }) => chunk.__ops ?? [],
    );
    const adminLink = ops.find(
      (op) =>
        Array.isArray(op) &&
        op[0] === "link" &&
        op[1] === "credStore" &&
        (op[3] as { owner?: string; forUser?: string }).owner === "admin-1",
    ) as [string, string, string, unknown] | undefined;
    const adminUpdate = ops.find(
      (op) =>
        Array.isArray(op) &&
        op[0] === "update" &&
        op[1] === "credStore" &&
        op[2] === adminLink?.[2],
    ) as
      | [string, string, string, { credStoreKey: string; content: string }]
      | undefined;
    expect(adminUpdate?.[3].credStoreKey).not.toBe(
      bytesToBase64(session.credStoreKey),
    );
    expect(decodedContent(adminUpdate![3])).toEqual({
      instant_app_id: "app-1",
      instant_client_name: "firebase",
      firebase_email: "bob@example.com",
      firebase_password: "pw",
      firebase_api_key: "api-key",
      user_root_key: rootKey,
    });
  });

  it("reads a user's stored credential fields from admin escrow", async () => {
    const db = fakeDb((query) => {
      if (query.credStore?.$?.where?.["forUser.id"] === "user-2") {
        return {
          credStore: [adminEscrowRow()],
        };
      }
      if (query.$users?.$?.where?.id === "user-2") {
        return {
          $users: [
            {
              id: "user-2",
              email: "bob@example.com",
              umk: bytesToBase64(new Uint8Array([11])),
              credStore: [
                userCredStore("user-cred-1", { display_name: "Bob" }),
              ],
            },
          ],
        };
      }
      if (query.$users?.credStore) {
        return {
          $users: [
            {
              id: "admin-1",
              credStore: [adminEscrowRow()],
            },
          ],
        };
      }
      return {};
    });

    await expect(getUserCreds(db, session, "user-2")).resolves.toEqual({
      instantAppId: "app-1",
      instantClientName: "firebase",
      firebaseEmail: "bob@example.com",
      firebasePassword: "pw",
      firebaseApiKey: "api-key",
      displayName: "Bob",
      userRootKey: oldRootKey,
    });
  });

  it("updates admin escrow, the user's own credStore content, and the umk root wrap", async () => {
    const db = fakeDb((query) => {
      if (query.credStore?.$?.where?.["forUser.id"] === "user-2") {
        return {
          credStore: [adminEscrowRow()],
        };
      }
      if (query.credStore?.$?.where?.["owner.id"] === "user-2") {
        return {
          credStore: [
            {
              id: "user-cred-1",
              credStoreKey: bytesToBase64(new Uint8Array([12])),
            },
          ],
        };
      }
      if (query.$users?.$?.where?.id === "user-2") {
        return {
          $users: [
            {
              id: "user-2",
              email: "bob@example.com",
              umk: bytesToBase64(new Uint8Array([11])),
            },
          ],
        };
      }
      if (query.$users?.credStore) {
        return {
          $users: [
            {
              id: "admin-1",
              credStore: [adminEscrowRow()],
            },
          ],
        };
      }
      return {};
    });

    await updateUserCreds(db, session, "user-2", {
      ...input,
      displayName: "Bobby",
    });

    expect(db.transact).toHaveBeenCalledOnce();
    const chunks = db.transact.mock.calls[0]![0];
    expect(chunks).toHaveLength(3);
    expect(JSON.stringify(chunks)).not.toContain('"type"');
    const ops: unknown[] = chunks.flatMap(
      (chunk: { __ops?: unknown[] }) => chunk.__ops ?? [],
    );
    expect(ops).toEqual(
      expect.arrayContaining([
        [
          "update",
          "credStore",
          "escrow-1",
          expect.objectContaining({
            credStoreKey: expect.any(String),
            content: expect.any(String),
          }),
        ],
      ]),
    );
    const adminUpdate = ops.find(
      (op) =>
        Array.isArray(op) &&
        op[0] === "update" &&
        op[1] === "credStore" &&
        op[2] === "escrow-1",
    ) as
      | [string, string, string, { credStoreKey: string; content: string }]
      | undefined;
    expect(decodedContent(adminUpdate![3])).toEqual({
      instant_app_id: "app-1",
      instant_client_name: "firebase",
      firebase_email: "bob@example.com",
      firebase_password: "pw",
      firebase_api_key: "api-key",
      user_root_key: rootKey,
    });
  });

  it("deletes shares, access/bookmarks, key/cred rows, and the admin escrow row", async () => {
    const db = fakeDb((query) => {
      if (query.txtShares?.$?.where?.["toUser.id"]) {
        return { txtShares: [{ id: "share-in", shareKey: "a" }] };
      }
      if (query.txtShares?.$?.where?.["fromUser.id"]) {
        return { txtShares: [{ id: "share-out", shareKey: "b" }] };
      }
      if (query.credStore?.$?.where?.["forUser.id"] === "user-2") {
        return {
          credStore: [adminEscrowRow()],
        };
      }
      if (query.keyStore) return { keyStore: [{ id: "key-1" }] };
      if (query.credStore?.$?.where?.["owner.id"] === "user-2") {
        return { credStore: [{ id: "user-cred-1" }] };
      }
      if (query.txtAccess) return { txtAccess: [{ id: "access-1" }] };
      if (query.txtBookmarks) return { txtBookmarks: [{ id: "bookmarks-1" }] };
      if (query.$users?.credStore) {
        return {
          $users: [
            {
              id: "admin-1",
              credStore: [adminEscrowRow()],
            },
          ],
        };
      }
      if (query.$users?.$?.where?.id === "user-2") {
        return { $users: [{ id: "user-2", email: "bob@example.com" }] };
      }
      return {};
    });

    await deleteUser(db, session, "user-2");

    expect(db.transact).toHaveBeenCalledOnce();
    const chunks = db.transact.mock.calls[0]![0];
    expect(chunks).toHaveLength(8);
    expect(JSON.stringify(chunks)).not.toContain('"type"');
    const ops: unknown[] = chunks.flatMap(
      (chunk: { __ops?: unknown[] }) => chunk.__ops ?? [],
    );
    expect(ops).toEqual(
      expect.arrayContaining([["update", "$users", "user-2", { umk: null }]]),
    );
    expect(ops).not.toEqual(
      expect.arrayContaining([["delete", "$users", "user-2", undefined]]),
    );
  });

  it("rejects deleting the current admin account", async () => {
    const db = fakeDb(() => ({}));

    await expect(deleteUser(db, session, "admin-1")).rejects.toThrow(
      AdminUsersError,
    );
    expect(db.transact).not.toHaveBeenCalled();
  });
});
