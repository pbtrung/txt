// Admin Manage screen: creating/listing/updating/deleting regular user
// accounts, and rotating a user's root key. `createUser`/`deleteUser` are
// generalized TS ports of txt/admin.py's AdminInitializer and
// txt/delete.py's TxtDeleter (reusing adminTxt.ts's deleteTxtRows per txt_id
// the target user owns) -- the CLI's --init only ever provisions the
// admin's own single account; this is what lets an admin provision (and
// tear down) *other* accounts from the browser instead.
//
// No users.display_name column exists (out of scope for this feature, see
// the plan) -- listUsers only ever returns plain numeric ids. displayName
// here is purely a field in createUser's returned, downloadable credential
// JSON, exactly like every other credential file's "just a UI label" (see
// docs/credentials.md) -- never written to Turso.
//
// Every regular user's Turso token is the same pre-minted, restricted token
// (docs/credentials.md's "Minting each role's token" -- Turso's fine-grained
// permissions have no per-account dimension), and Turso doesn't expose a
// way to look up a token's value after minting, so the admin pastes it into
// the "create user" form each time rather than this module deriving it.

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { base64ToBytes, bytesToBase64, randomBytes } from "../crypto/bytes";
import * as c from "../crypto/constants";
import * as kem from "../crypto/kem";
import { hmacSha3_256, pbkdf2Sha3_256 } from "../crypto/leancryptoLoader";
import { deleteTxtRows } from "./adminTxt";
import { requireBlobBytes } from "./db";
import type { R2Config } from "./r2Config";

export class AdminUsersError extends Error {}

export interface NewUserInput {
  username: string;
  password: string;
  displayName: string;
  /** The shared regular-user Turso token, pasted in by the admin -- see
   * file comment. Embedded verbatim in the returned credential JSON, never
   * written to Turso. */
  userTursoAuthToken: string;
}

/** Shape of user_cred_template.json, filled in -- what the Manage screen
 * triggers a browser download of for the admin to hand off. */
export interface DownloadableUserCreds {
  turso_database_url: string;
  turso_auth_token: string;
  username: string;
  username_lookup_key: string;
  password: string;
  display_name: string;
  user_root_key: string;
}

/** Provisions a brand new regular-user account: users/umk_store/key_store/
 * r2_config/txt_metadata/txt_access/bookmarks rows, mirroring
 * txt/admin.py's AdminInitializer.run() -- generalized to a target
 * username/password instead of always being self-referential. r2_config's
 * read-only key *values* are copied from the admin's own (already-fetched)
 * R2Config, since every account shares the same read-only R2 credentials. */
export async function createUser(
  db: Client,
  adminTursoDatabaseUrl: string,
  adminR2Config: R2Config,
  input: NewUserInput,
): Promise<DownloadableUserCreds> {
  const usernameLookupKey = randomBytes(c.USERNAME_LOOKUP_KEY_MIN_LEN);
  const userRootKey = randomBytes(c.USER_ROOT_KEY_MIN_LEN);
  const usernameHash = await hmacSha3_256(usernameLookupKey, new TextEncoder().encode(input.username));
  const pwSalt = randomBytes(c.PW_SALT_LEN);
  const pwHash = await pbkdf2Sha3_256(
    new TextEncoder().encode(input.password),
    pwSalt,
    c.PBKDF2_ITERATIONS,
    c.PW_HASH_LEN,
  );

  const insertUser = await db.execute({
    sql: "INSERT INTO users (username_hash, pw_salt, pw_hash) VALUES (?, ?, ?)",
    args: [usernameHash, pwSalt, pwHash],
  });
  const userId = Number(insertUser.lastInsertRowid);

  const umk = randomBytes(c.UMK_LEN);
  await db.execute({
    sql: "INSERT INTO umk_store (user_id, umk) VALUES (?, ?)",
    args: [userId, await blob.encrypt(userRootKey, umk)],
  });

  const { pk, sk } = await kem.keypair();
  await db.execute({
    sql: "INSERT INTO key_store (user_id, pub_key, priv_key) VALUES (?, ?, ?)",
    args: [userId, pk, await blob.encrypt(umk, sk)],
  });

  const r2ConfigJson = JSON.stringify({
    endpoint: adminR2Config.endpoint,
    region: adminR2Config.region,
    bucket: adminR2Config.bucket,
    read_only_access_key_id: adminR2Config.readOnlyAccessKeyId,
    read_only_secret_access_key: adminR2Config.readOnlySecretAccessKey,
  });
  await db.execute({
    sql: "INSERT INTO r2_config (user_id, config) VALUES (?, ?)",
    args: [userId, await blob.encrypt(umk, new TextEncoder().encode(r2ConfigJson), { compressed: true })],
  });

  const txtMetadataKey = randomBytes(c.TXT_METADATA_KEY_LEN);
  await db.execute({
    sql: "INSERT INTO txt_metadata (user_id, txt_metadata_key, content) VALUES (?, ?, NULL)",
    args: [userId, await blob.encrypt(umk, txtMetadataKey)],
  });

  const txtAccessKey = randomBytes(c.TXT_ACCESS_KEY_LEN);
  await db.execute({
    sql: "INSERT INTO txt_access (user_id, txt_access_key, access) VALUES (?, ?, ?)",
    args: [
      userId,
      await blob.encrypt(umk, txtAccessKey),
      await blob.encrypt(txtAccessKey, new TextEncoder().encode("{}"), { compressed: true }),
    ],
  });

  const bookmarkKey = randomBytes(c.BOOKMARK_KEY_LEN);
  await db.execute({
    sql: "INSERT INTO bookmarks (user_id, bookmark_key, bookmark) VALUES (?, ?, ?)",
    args: [
      userId,
      await blob.encrypt(umk, bookmarkKey),
      await blob.encrypt(bookmarkKey, new TextEncoder().encode("{}"), { compressed: true }),
    ],
  });

  return {
    turso_database_url: adminTursoDatabaseUrl,
    turso_auth_token: input.userTursoAuthToken,
    username: input.username,
    username_lookup_key: bytesToBase64(usernameLookupKey),
    password: input.password,
    display_name: input.displayName,
    user_root_key: bytesToBase64(userRootKey),
  };
}

/** Every account's id -- plain numeric, no human-readable label available
 * without a schema change (see file comment). */
export async function listUsers(db: Client): Promise<number[]> {
  const result = await db.execute({ sql: "SELECT id FROM users ORDER BY id ASC", args: [] });
  return result.rows.map((row) => Number(row.id));
}

/** Resets a user's login password -- pw_hash/pw_salt sit outside the umk
 * chain entirely (docs/credentials.md: password is "never used as IKM
 * anywhere in the key hierarchy"), so this needs no key material at all. */
export async function updateUserPassword(db: Client, userId: number, password: string): Promise<void> {
  const pwSalt = randomBytes(c.PW_SALT_LEN);
  const pwHash = await pbkdf2Sha3_256(new TextEncoder().encode(password), pwSalt, c.PBKDF2_ITERATIONS, c.PW_HASH_LEN);
  await db.execute({ sql: "UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?", args: [pwSalt, pwHash, userId] });
}

/** Re-wraps a user's existing umk under a fresh user_root_key, given their
 * *current* root key as input (assumed escrowed out-of-band) -- umk_store.umk
 * can only ever be decrypted with the root key it was actually wrapped
 * under, which the admin doesn't otherwise have for any account but their
 * own, so there's no way to rotate this without it. Preserves every bit of
 * that user's existing content (nothing else changes -- only the wrapping
 * key). Returns the new root key (base64) for the caller to show once and
 * offer as a download. */
export async function rotateUserRootKey(db: Client, userId: number, oldRootKeyBase64: string): Promise<string> {
  const result = await db.execute({ sql: "SELECT umk FROM umk_store WHERE user_id = ?", args: [userId] });
  const row = result.rows[0];
  if (!row) {
    throw new AdminUsersError(`no umk_store row for user_id=${userId}`);
  }
  const oldRootKey = base64ToBytes(oldRootKeyBase64);
  let umk: Uint8Array;
  try {
    umk = await blob.decrypt(oldRootKey, requireBlobBytes(row.umk, "umk_store.umk"));
  } catch {
    throw new AdminUsersError("incorrect current root key -- couldn't decrypt this user's umk with it");
  }
  const newRootKey = randomBytes(c.USER_ROOT_KEY_MIN_LEN);
  await db.execute({
    sql: "UPDATE umk_store SET umk = ? WHERE user_id = ?",
    args: [await blob.encrypt(newRootKey, umk), userId],
  });
  return bytesToBase64(newRootKey);
}

/** Full account teardown: every txt this user owns (via adminTxt.ts's
 * deleteTxtRows, Turso-only -- same orphaned-R2-object caveat as deleting a
 * single txt), any shares granted *to* them (which would otherwise dangle),
 * then every account-level row. Rejects up front if targetUserId is the
 * caller's own account -- an admin can never delete themselves through this
 * screen. */
export async function deleteUser(db: Client, currentUserId: number, targetUserId: number): Promise<void> {
  if (targetUserId === currentUserId) {
    throw new AdminUsersError("an admin cannot delete their own account through this screen");
  }
  const txtRows = await db.execute({ sql: "SELECT id FROM txt WHERE user_id = ?", args: [targetUserId] });
  for (const row of txtRows.rows) {
    await deleteTxtRows(db, Number(row.id));
  }
  await db.execute({ sql: "DELETE FROM txt_shares WHERE to_user_id = ?", args: [targetUserId] });
  await db.execute({ sql: "DELETE FROM key_store WHERE user_id = ?", args: [targetUserId] });
  await db.execute({ sql: "DELETE FROM r2_config WHERE user_id = ?", args: [targetUserId] });
  await db.execute({ sql: "DELETE FROM txt_metadata WHERE user_id = ?", args: [targetUserId] });
  await db.execute({ sql: "DELETE FROM txt_access WHERE user_id = ?", args: [targetUserId] });
  await db.execute({ sql: "DELETE FROM bookmarks WHERE user_id = ?", args: [targetUserId] });
  await db.execute({ sql: "DELETE FROM umk_store WHERE user_id = ?", args: [targetUserId] });
  await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [targetUserId] });
}
