import { id, tx } from "@instantdb/react";

import * as blob from "../crypto/blob";
import { base64ToBytes, bytesToBase64, randomBytes } from "../crypto/bytes";
import { RANDOM_KEY_LEN } from "../crypto/constants";
import { collectAllPages } from "./instaqlPagination";
import { kemKeypair } from "./leancrypto";
import { resolveInstantAuthId } from "./instantAuth";
import type { R2Config } from "./r2Config";

export class AdminUsersError extends Error {}

const PAGE_SIZE = 1000;

interface UserRow {
  id: string;
  email?: string;
  type?: string | null;
  umk?: string | null;
}

interface EntityRow {
  id: string;
}

interface LinkedId {
  id: string;
}

interface CredStoreRow extends EntityRow {
  credStoreKey?: string;
  content?: string;
  forUser?: LinkedId[];
}

interface ShareRow extends EntityRow {
  shareKey?: string;
}

export interface UserSummary {
  id: string;
  email?: string;
  displayName?: string;
  isAdmin: boolean;
}

export interface AdminUserSession {
  authId: string;
  umk: Uint8Array;
  credStoreKey: Uint8Array;
  r2Config: R2Config;
  displayName?: string | null;
}

export interface UserCredentialFields {
  instantAppId: string;
  instantClientName: string;
  firebaseEmail: string;
  firebasePassword: string;
  firebaseApiKey: string;
  displayName: string;
  userRootKey: string;
}

export type AdminStoredUserCreds = Omit<UserCredentialFields, "displayName">;

export function generateUserRootKey(): string {
  return bytesToBase64(randomBytes(256));
}

function validateUserRootKey(value: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = base64ToBytes(value);
  } catch {
    throw new AdminUsersError("user_root_key must be valid base64");
  }
  if (key.length < 256) {
    throw new AdminUsersError("user_root_key too short");
  }
  return key;
}

function normalizeEmail(email: string | undefined): string | undefined {
  return email?.trim().toLowerCase();
}

function storedCredsFromJson(json: unknown): AdminStoredUserCreds | null {
  if (typeof json !== "object" || json === null) return null;
  const data = json as Record<string, unknown>;
  const required = [
    "instant_app_id",
    "instant_client_name",
    "firebase_email",
    "firebase_password",
    "firebase_api_key",
    "user_root_key",
  ] as const;
  for (const key of required) {
    if (typeof data[key] !== "string" || data[key].length === 0) return null;
  }
  return {
    instantAppId: data.instant_app_id as string,
    instantClientName: data.instant_client_name as string,
    firebaseEmail: data.firebase_email as string,
    firebasePassword: data.firebase_password as string,
    firebaseApiKey: data.firebase_api_key as string,
    userRootKey: data.user_root_key as string,
  };
}

function storedCredsToJson(
  creds: AdminStoredUserCreds,
): Record<string, string> {
  // Persisted admin escrow payload. Identity is the row's forUser link, and
  // display_name belongs only to the target user's own session, not admin UI.
  const json: Record<string, string> = {
    instant_app_id: creds.instantAppId,
    instant_client_name: creds.instantClientName,
    firebase_email: creds.firebaseEmail,
    firebase_password: creds.firebasePassword,
    firebase_api_key: creds.firebaseApiKey,
    user_root_key: creds.userRootKey,
  };
  return json;
}

async function decryptStoredCreds(
  adminUmk: Uint8Array,
  row: CredStoreRow,
): Promise<AdminStoredUserCreds | null> {
  if (!row.credStoreKey || !row.content) return null;
  try {
    const credStoreKey = await blob.decrypt(
      adminUmk,
      base64ToBytes(row.credStoreKey),
    );
    const plaintext = await blob.decrypt(
      credStoreKey,
      base64ToBytes(row.content),
      true,
    );
    return storedCredsFromJson(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    return null;
  }
}

async function wrapStoredCreds(
  adminCredStoreKey: Uint8Array,
  creds: AdminStoredUserCreds,
): Promise<string> {
  const payload = JSON.stringify(storedCredsToJson(creds));
  const encrypted = await blob.encrypt(
    adminCredStoreKey,
    new TextEncoder().encode(payload),
    { compressed: true },
  );
  return bytesToBase64(encrypted);
}

function userCredStoreContent(
  r2Config: R2Config,
  displayName: string,
): Record<string, unknown> {
  return {
    r2_config: {
      endpoint: r2Config.endpoint,
      region: r2Config.region,
      bucket: r2Config.bucket,
    },
    display_name: displayName,
  };
}

async function wrapUserCredStoreContent(
  credStoreKey: Uint8Array,
  r2Config: R2Config,
  displayName: string,
): Promise<string> {
  const encrypted = await blob.encrypt(
    credStoreKey,
    new TextEncoder().encode(
      JSON.stringify(userCredStoreContent(r2Config, displayName)),
    ),
    { compressed: true },
  );
  return bytesToBase64(encrypted);
}

async function queryRows<T>(
  db: any,
  namespace: string,
  query: any,
): Promise<T[]> {
  const result = await db.queryOnce({ [namespace]: query });
  return result.data[namespace] ?? [];
}

async function queryPagedRows<T>(
  db: any,
  namespace: string,
  query: any,
): Promise<T[]> {
  return collectAllPages<T>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.queryOnce({
      [namespace]: {
        ...query,
        $: {
          ...(query.$ ?? {}),
          limit: PAGE_SIZE,
          offset,
        },
      },
    });
    const page = result.data[namespace] ?? [];
    return {
      rows: page,
      hasNextPage: page.length === PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });
}

async function queryUser(db: any, userId: string): Promise<UserRow | null> {
  const rows = await queryRows<UserRow>(db, "$users", {
    $: { where: { id: userId } },
  });
  return rows[0] ?? null;
}

async function queryUsers(db: any): Promise<UserRow[]> {
  return queryPagedRows<UserRow>(db, "$users", {
    $: { order: { email: "asc" } },
  });
}

async function queryOwnedRows<T extends EntityRow>(
  db: any,
  namespace: string,
  ownerId: string,
): Promise<T[]> {
  return queryPagedRows<T>(db, namespace, {
    $: { where: { "owner.id": ownerId } },
  });
}

async function queryShareRowsForUser(
  db: any,
  userId: string,
): Promise<ShareRow[]> {
  const [incoming, outgoing] = await Promise.all([
    queryPagedRows<ShareRow>(db, "txtShares", {
      $: {
        where: { "toUser.id": userId },
        order: { shareKey: "asc" },
      },
    }),
    queryPagedRows<ShareRow>(db, "txtShares", {
      $: {
        where: { "fromUser.id": userId },
        order: { shareKey: "asc" },
      },
    }),
  ]);
  const byId = new Map<string, ShareRow>();
  for (const row of [...incoming, ...outgoing]) byId.set(row.id, row);
  return [...byId.values()];
}

async function queryAdminCredStores(
  db: any,
  adminAuthId: string,
): Promise<CredStoreRow[]> {
  const result = await db.queryOnce({
    $users: {
      $: { where: { id: adminAuthId } },
      credStore: { forUser: {} },
    },
  });
  return result.data.$users?.[0]?.credStore ?? [];
}

async function queryAdminCredStoresForUser(
  db: any,
  adminAuthId: string,
  userId: string,
): Promise<CredStoreRow[]> {
  return queryRows<CredStoreRow>(db, "credStore", {
    $: {
      where: {
        "owner.id": adminAuthId,
        "forUser.id": userId,
      },
    },
    forUser: {},
  });
}

async function findAdminStoredCreds(
  db: any,
  session: AdminUserSession,
  userId: string,
): Promise<{ row: CredStoreRow; creds: AdminStoredUserCreds } | null> {
  const user = await queryUser(db, userId);
  const targetEmail = normalizeEmail(user?.email);
  const targetRows = await queryAdminCredStoresForUser(
    db,
    session.authId,
    userId,
  );
  for (const row of targetRows) {
    const creds = await decryptStoredCreds(session.umk, row);
    if (creds) return { row, creds };
  }

  // Fallback for older rows created before forUser was backfilled: match the
  // encrypted Firebase email if a target email is known.
  const rows = await queryAdminCredStores(db, session.authId);
  let emailMatch: { row: CredStoreRow; creds: AdminStoredUserCreds } | null =
    null;
  for (const row of rows) {
    const creds = await decryptStoredCreds(session.umk, row);
    if (!creds) continue;
    if (
      targetEmail &&
      normalizeEmail(creds.firebaseEmail) === targetEmail &&
      !emailMatch
    ) {
      emailMatch = { row, creds };
    }
  }
  return emailMatch;
}

async function transactIfAny(db: any, chunks: unknown[]): Promise<void> {
  if (chunks.length > 0) await db.transact(chunks);
}

export async function listUsersWithInfo(
  db: any,
  session: AdminUserSession,
): Promise<UserSummary[]> {
  const users = await queryUsers(db);

  return users.map((row) => ({
    id: row.id,
    email: row.email,
    displayName:
      row.id === session.authId
        ? (session.displayName ?? row.email)
        : row.email,
    isAdmin: row.type === "admin",
  }));
}

export async function getUserCreds(
  db: any,
  session: AdminUserSession,
  userId: string,
): Promise<AdminStoredUserCreds | null> {
  const found = await findAdminStoredCreds(db, session, userId);
  if (!found) return null;
  return found.creds;
}

export async function createUser(
  db: any,
  session: AdminUserSession,
  input: UserCredentialFields,
  onProgress?: (label: string) => void,
): Promise<string> {
  const userRootKey = validateUserRootKey(input.userRootKey);
  onProgress?.("Signing in");
  const auth = await resolveInstantAuthId(input);
  if (auth.authId === session.authId) {
    throw new AdminUsersError(
      "an admin cannot provision their own account here",
    );
  }
  const existingKeyStore = await queryOwnedRows<EntityRow>(
    db,
    "keyStore",
    auth.authId,
  );
  if (existingKeyStore.length > 0) {
    throw new AdminUsersError("this Instant user is already provisioned");
  }

  onProgress?.("Generating keys");
  const userUmk = randomBytes(RANDOM_KEY_LEN);
  const keyStoreKey = randomBytes(RANDOM_KEY_LEN);
  const userCredStoreKey = randomBytes(RANDOM_KEY_LEN);
  const adminEscrowCredStoreKey = randomBytes(RANDOM_KEY_LEN);
  const { pubKey, privKey } = await kemKeypair();

  const userUmkBlob = await blob.encrypt(userRootKey, userUmk);
  const keyStoreKeyBlob = await blob.encrypt(userUmk, keyStoreKey);
  const privKeyBlob = await blob.encrypt(keyStoreKey, privKey);
  const userCredStoreKeyBlob = await blob.encrypt(userUmk, userCredStoreKey);
  const userCredStoreContent = await wrapUserCredStoreContent(
    userCredStoreKey,
    session.r2Config,
    input.displayName,
  );
  const { displayName: _displayName, ...adminInput } = input;
  const adminStoredCreds = await wrapStoredCreds(
    adminEscrowCredStoreKey,
    adminInput,
  );
  const adminCredStoreKeyBlob = await blob.encrypt(
    session.umk,
    adminEscrowCredStoreKey,
  );

  onProgress?.("Saving account");
  const keyStoreId = id();
  const userCredStoreId = id();
  const adminEscrowId = id();
  await db.transact([
    tx.$users![auth.authId]!.update({
      umk: bytesToBase64(userUmkBlob),
    }),
    tx
      .keyStore![keyStoreId]!.update({
        pubKey: bytesToBase64(pubKey),
        keyStoreKey: bytesToBase64(keyStoreKeyBlob),
        privKey: bytesToBase64(privKeyBlob),
      })
      .link({ owner: auth.authId }),
    tx
      .credStore![userCredStoreId]!.update({
        credStoreKey: bytesToBase64(userCredStoreKeyBlob),
        content: userCredStoreContent,
      })
      .link({ owner: auth.authId, forUser: auth.authId }),
    tx
      .credStore![adminEscrowId]!.update({
        credStoreKey: bytesToBase64(adminCredStoreKeyBlob),
        content: adminStoredCreds,
      })
      .link({ owner: session.authId, forUser: auth.authId }),
  ]);

  return auth.authId;
}

export async function updateUserCreds(
  db: any,
  session: AdminUserSession,
  userId: string,
  input: AdminStoredUserCreds,
): Promise<void> {
  const nextRootKey = validateUserRootKey(input.userRootKey);
  const found = await findAdminStoredCreds(db, session, userId);
  if (!found) {
    throw new AdminUsersError("no stored credentials for this user");
  }
  const adminEscrowCredStoreKey = randomBytes(RANDOM_KEY_LEN);
  const nextAdminCredStoreKey = await blob.encrypt(
    session.umk,
    adminEscrowCredStoreKey,
  );

  const chunks: unknown[] = [
    tx.credStore![found.row.id]!.update({
      credStoreKey: bytesToBase64(nextAdminCredStoreKey),
      content: await wrapStoredCreds(adminEscrowCredStoreKey, input),
    }),
  ];

  if (input.userRootKey !== found.creds.userRootKey) {
    // Root-key rotation rewraps $users.umk only. It deliberately does not
    // decrypt or rewrite the target-owned credStore.content.
    const user = await queryUser(db, userId);
    if (!user?.umk) {
      throw new AdminUsersError("this user has no stored umk");
    }
    let userUmk: Uint8Array;
    try {
      userUmk = await blob.decrypt(
        validateUserRootKey(found.creds.userRootKey),
        base64ToBytes(user.umk),
      );
    } catch {
      throw new AdminUsersError(
        "stored user_root_key cannot decrypt this user's umk",
      );
    }
    const nextUmkBlob = await blob.encrypt(nextRootKey, userUmk);
    chunks.unshift(
      tx.$users![userId]!.update({
        umk: bytesToBase64(nextUmkBlob),
      }),
    );
  }

  await db.transact(chunks);
}

export async function deleteUser(
  db: any,
  session: AdminUserSession,
  targetUserId: string,
): Promise<void> {
  if (targetUserId === session.authId) {
    throw new AdminUsersError("an admin cannot delete their own account here");
  }

  const [
    shares,
    keyStores,
    userCredStores,
    txtAccessRows,
    txtBookmarkRows,
    adminStored,
  ] = await Promise.all([
    queryShareRowsForUser(db, targetUserId),
    queryOwnedRows<EntityRow>(db, "keyStore", targetUserId),
    queryOwnedRows<CredStoreRow>(db, "credStore", targetUserId),
    queryOwnedRows<EntityRow>(db, "txtAccess", targetUserId),
    queryOwnedRows<EntityRow>(db, "txtBookmarks", targetUserId),
    findAdminStoredCreds(db, session, targetUserId),
  ]);

  const chunks: unknown[] = [
    ...shares.map((row) => tx.txtShares![row.id]!.delete()),
    ...txtAccessRows.map((row) => tx.txtAccess![row.id]!.delete()),
    ...txtBookmarkRows.map((row) => tx.txtBookmarks![row.id]!.delete()),
    ...keyStores.map((row) => tx.keyStore![row.id]!.delete()),
    ...userCredStores.map((row) => tx.credStore![row.id]!.delete()),
  ];
  if (adminStored) {
    chunks.push(tx.credStore![adminStored.row.id]!.delete());
  }
  chunks.push(tx.$users![targetUserId]!.update({ umk: null }));

  await transactIfAny(db, chunks);
}
