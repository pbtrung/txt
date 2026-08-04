import { id, tx } from "@instantdb/react";

import * as blob from "../crypto/blob";
import { base64ToBytes, bytesToBase64, randomBytes } from "../crypto/bytes";
import { RANDOM_KEY_LEN } from "../crypto/constants";
import { collectAllPages } from "./instaqlPagination";
import { kemKeypair } from "./leancrypto";
import { resolveInstantAuthId } from "./instantAuth";
import type { R2Config } from "./r2Config";

export class AdminUsersError extends Error {}

const PAGE_SIZE = 500;

interface UserRow {
  id: string;
  email?: string;
  type?: string | null;
  umk?: string | null;
}

interface EntityRow {
  id: string;
}

interface CredStoreRow extends EntityRow {
  credStoreKey?: string;
  content?: string;
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

interface AdminStoredUserCreds extends UserCredentialFields {
  userAuthId?: string;
}

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
    displayName: typeof data.display_name === "string" ? data.display_name : "",
    userRootKey: data.user_root_key as string,
    userAuthId:
      typeof data.user_auth_id === "string" ? data.user_auth_id : undefined,
  };
}

function storedCredsToJson(
  creds: AdminStoredUserCreds,
): Record<string, string> {
  const json: Record<string, string> = {
    instant_app_id: creds.instantAppId,
    instant_client_name: creds.instantClientName,
    firebase_email: creds.firebaseEmail,
    firebase_password: creds.firebasePassword,
    firebase_api_key: creds.firebaseApiKey,
    display_name: creds.displayName,
    user_root_key: creds.userRootKey,
  };
  if (creds.userAuthId) json.user_auth_id = creds.userAuthId;
  return json;
}

async function decryptStoredCreds(
  adminCredStoreKey: Uint8Array,
  row: CredStoreRow,
): Promise<AdminStoredUserCreds | null> {
  if (!row.content) return null;
  try {
    const plaintext = await blob.decrypt(
      adminCredStoreKey,
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
      credStore: {},
    },
  });
  return result.data.$users?.[0]?.credStore ?? [];
}

async function readAdminStoredCreds(
  db: any,
  session: AdminUserSession,
): Promise<Map<string, { row: CredStoreRow; creds: AdminStoredUserCreds }>> {
  const rows = await queryAdminCredStores(db, session.authId);
  const byUserId = new Map<
    string,
    { row: CredStoreRow; creds: AdminStoredUserCreds }
  >();
  for (const row of rows) {
    const creds = await decryptStoredCreds(session.credStoreKey, row);
    if (creds?.userAuthId) byUserId.set(creds.userAuthId, { row, creds });
  }
  return byUserId;
}

async function findAdminStoredCreds(
  db: any,
  session: AdminUserSession,
  userId: string,
): Promise<{ row: CredStoreRow; creds: AdminStoredUserCreds } | null> {
  const user = await queryUser(db, userId);
  const targetEmail = normalizeEmail(user?.email);
  const rows = await queryAdminCredStores(db, session.authId);
  let emailMatch: { row: CredStoreRow; creds: AdminStoredUserCreds } | null =
    null;
  for (const row of rows) {
    const creds = await decryptStoredCreds(session.credStoreKey, row);
    if (!creds) continue;
    if (creds.userAuthId === userId) return { row, creds };
    if (
      targetEmail &&
      normalizeEmail(creds.firebaseEmail) === targetEmail &&
      !emailMatch
    ) {
      emailMatch = { row, creds: { ...creds, userAuthId: userId } };
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
  const [users, storedByUserId] = await Promise.all([
    queryUsers(db),
    readAdminStoredCreds(db, session),
  ]);

  return users.map((row) => {
    const stored = storedByUserId.get(row.id)?.creds;
    return {
      id: row.id,
      email: row.email,
      displayName: stored?.displayName || row.email || row.id,
      isAdmin: row.type === "admin",
    };
  });
}

export async function getUserCreds(
  db: any,
  session: AdminUserSession,
  userId: string,
): Promise<UserCredentialFields | null> {
  const found = await findAdminStoredCreds(db, session, userId);
  if (!found) return null;
  const { userAuthId: _userAuthId, ...creds } = found.creds;
  return creds;
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
  const adminStoredCreds = await wrapStoredCreds(session.credStoreKey, {
    ...input,
    userAuthId: auth.authId,
  });
  const adminCredStoreKeyBlob = await blob.encrypt(
    session.umk,
    session.credStoreKey,
  );

  onProgress?.("Saving account");
  const keyStoreId = id();
  const userCredStoreId = id();
  const adminEscrowId = id();
  await db.transact([
    tx.$users![auth.authId]!.update({
      type: "user",
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
      .link({ owner: auth.authId }),
    tx
      .credStore![adminEscrowId]!.update({
        credStoreKey: bytesToBase64(adminCredStoreKeyBlob),
        content: adminStoredCreds,
      })
      .link({ owner: session.authId }),
  ]);

  return auth.authId;
}

export async function updateUserCreds(
  db: any,
  session: AdminUserSession,
  userId: string,
  input: UserCredentialFields,
): Promise<void> {
  const nextRootKey = validateUserRootKey(input.userRootKey);
  const found = await findAdminStoredCreds(db, session, userId);
  if (!found) {
    throw new AdminUsersError("no stored credentials for this user");
  }
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

  const userCredStores = await queryOwnedRows<CredStoreRow>(
    db,
    "credStore",
    userId,
  );
  const userCredStore = userCredStores[0];
  if (!userCredStore?.credStoreKey) {
    throw new AdminUsersError("this user has no credStore row");
  }
  const userCredStoreKey = await blob.decrypt(
    userUmk,
    base64ToBytes(userCredStore.credStoreKey),
  );

  const [nextUmkBlob, nextUserContent, nextAdminContent] = await Promise.all([
    blob.encrypt(nextRootKey, userUmk),
    wrapUserCredStoreContent(
      userCredStoreKey,
      session.r2Config,
      input.displayName,
    ),
    wrapStoredCreds(session.credStoreKey, { ...input, userAuthId: userId }),
  ]);

  await db.transact([
    tx.$users![userId]!.update({
      type: "user",
      umk: bytesToBase64(nextUmkBlob),
    }),
    tx.credStore![userCredStore.id]!.update({ content: nextUserContent }),
    tx.credStore![found.row.id]!.update({ content: nextAdminContent }),
  ]);
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
  chunks.push(tx.$users![targetUserId]!.update({ type: null, umk: null }));

  await transactIfAny(db, chunks);
}
