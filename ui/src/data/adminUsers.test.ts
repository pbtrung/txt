import { beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64 } from "../crypto/bytes";
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
    display_name: "Bob",
    user_root_key: oldRootKey,
    user_auth_id: "user-2",
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adminUsers", () => {
  it("lists users with display names recovered from their own credential rows", async () => {
    const adminEscrow = {
      id: "escrow-1",
      credStoreKey: bytesToBase64(new Uint8Array([12])),
      content: encodedJson(storedCreds({ display_name: "Admin escrow Bob" })),
    };
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
    expect(db.transact.mock.calls[0]![0]).toHaveLength(4);
  });

  it("reads a user's stored credential fields from admin escrow", async () => {
    const db = fakeDb((query) => {
      if (query.$users?.credStore) {
        return {
          $users: [
            {
              id: "admin-1",
              credStore: [
                { id: "escrow-1", content: encodedJson(storedCreds()) },
              ],
            },
          ],
        };
      }
      return { $users: [{ id: "user-2", email: "bob@example.com" }] };
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
      if (query.$users?.credStore) {
        return {
          $users: [
            {
              id: "admin-1",
              credStore: [
                { id: "escrow-1", content: encodedJson(storedCreds()) },
              ],
            },
          ],
        };
      }
      if (query.$users) {
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
      if (query.credStore) {
        return {
          credStore: [
            {
              id: "user-cred-1",
              credStoreKey: bytesToBase64(new Uint8Array([12])),
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
    expect(db.transact.mock.calls[0]![0]).toHaveLength(3);
  });

  it("deletes shares, access/bookmarks, key/cred rows, and the admin escrow row", async () => {
    const db = fakeDb((query) => {
      if (query.txtShares?.$?.where?.["toUser.id"]) {
        return { txtShares: [{ id: "share-in", shareKey: "a" }] };
      }
      if (query.txtShares?.$?.where?.["fromUser.id"]) {
        return { txtShares: [{ id: "share-out", shareKey: "b" }] };
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
              credStore: [
                { id: "escrow-1", content: encodedJson(storedCreds()) },
              ],
            },
          ],
        };
      }
      return { $users: [{ id: "user-2", email: "bob@example.com" }] };
    });

    await deleteUser(db, session, "user-2");

    expect(db.transact).toHaveBeenCalledOnce();
    expect(db.transact.mock.calls[0]![0]).toHaveLength(8);
  });

  it("rejects deleting the current admin account", async () => {
    const db = fakeDb(() => ({}));

    await expect(deleteUser(db, session, "admin-1")).rejects.toThrow(
      AdminUsersError,
    );
    expect(db.transact).not.toHaveBeenCalled();
  });
});
