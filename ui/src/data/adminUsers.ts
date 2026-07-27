// Admin Manage screen: creating/listing/updating/deleting regular user
// accounts, and rotating a user's root key. Account creation (generateNewUser
// + persistNewUser below) and deleteUser are generalized TS ports of
// txt/admin.py's AdminInitializer and txt/delete.py's TxtDeleter (reusing
// adminTxt.ts's deleteTxtRows per txt_id the target user owns) -- the CLI's
// --init only ever provisions the admin's own single account; this is what
// lets an admin provision (and tear down) *other* accounts from the browser
// instead.
//
// Creating an account is split into two steps -- generateNewUser (pure
// computation, no database access at all) and persistNewUser (the actual
// writes) -- so the Manage screen's Create-user form can show the
// one-time-only credential JSON and require the admin to confirm they've
// saved it *before* anything is ever written, rather than writing first and
// only then hoping the admin manages to save the result. See both
// functions' own doc comments.
//
// There's still no users.display_name column (a plaintext label wasn't
// worth a schema change on its own), but users.creds now exists (see
// docs/data_model.md): a regular user's full credential JSON, wrapped under
// the *admin's* own umk rather than that row's own account. persistNewUser
// writes it there, and listUsersWithInfo reads it back to recover
// displayName for the Users list -- the admin's own umk is already
// unwrapped in their session, so this needs no new secret, unlike trying to
// read anything wrapped under a *regular* user's own umk (which the admin
// genuinely can't do -- see rotateUserRootKey below).
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

// Both the username and password are generated here, not admin-typed: the
// only thing that ever actually "logs in" with them is unlock()'s own
// Choose File flow, which reads them straight out of the downloaded
// credential JSON -- no human ever types either one -- so there's nothing
// to gain from letting an admin pick a memorable value, and a random
// opaque one is simpler to get right than validating a typed one (no
// uniqueness/length/charset checks needed; a collision is as astronomically
// unlikely as username_lookup_key's or user_root_key's own randomness).
const GENERATED_CREDENTIAL_LENGTH = 42;
const ALPHANUMERIC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A cryptographically random string of `length` characters drawn evenly
 * from [0-9A-Za-z] -- rejection sampling (not a plain `byte % 62`) so the
 * charset's first `256 % 62 = 8` characters aren't drawn very slightly
 * more often than the rest. */
function randomAlphanumeric(length: number): string {
  const chars: string[] = [];
  const cutoff = 256 - (256 % ALPHANUMERIC_CHARS.length);
  while (chars.length < length) {
    for (const byte of randomBytes(length - chars.length)) {
      if (byte < cutoff) chars.push(ALPHANUMERIC_CHARS[byte % ALPHANUMERIC_CHARS.length]);
    }
  }
  return chars.join("");
}

export interface NewUserInput {
  /** The Turso database URL to embed in the new user's credential JSON --
   * an explicit field rather than always assuming the admin's own, since
   * nothing here actually requires every account to share one (only that
   * this admin's own umk_store/key_store/etc. rows live in whichever
   * database userId ends up scoped to). */
  tursoDatabaseUrl: string;
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

/** Every wrapped blob/key `persistNewUser` below needs to actually write a
 * new account, plus the one-time credential JSON to show the admin --
 * everything generateNewUser can compute without a database at all. */
export interface GeneratedNewUser {
  downloadable: DownloadableUserCreds;
  usernameHash: Uint8Array;
  pwSalt: Uint8Array;
  pwHash: Uint8Array;
  umkBlob: Uint8Array;
  pubKey: Uint8Array;
  privKeyBlob: Uint8Array;
  r2ConfigBlob: Uint8Array;
  txtMetadataKeyBlob: Uint8Array;
  txtAccessKeyBlob: Uint8Array;
  txtAccessEmptyBlob: Uint8Array;
  bookmarkKeyBlob: Uint8Array;
  bookmarkEmptyBlob: Uint8Array;
  credsBlob: Uint8Array;
}

/** Generates a brand new regular-user account's full credential material,
 * mirroring txt/admin.py's AdminInitializer.run() -- generalized to a
 * freshly generated username/password instead of always being
 * self-referential -- but doesn't write anything: every value below (and
 * every blob it's wrapped into) is fully computable up front, including
 * `credsBlob` (wrapped under the *admin's* own umk, adminUmk -- see file
 * comment -- needs nothing the eventual INSERT would generate, like a
 * userId). That's deliberate: persistNewUser (below) just re-plays these
 * already-computed values as a sequence of writes, so the admin can review
 * (and confirm they've saved) the returned `downloadable` credentials
 * *before* persistNewUser ever runs, and a retry after a failed persist
 * replays the exact same secrets instead of silently generating a second,
 * different account. r2_config's read-only key *values* are copied from the
 * admin's own (already-fetched) R2Config, since every account shares the
 * same read-only R2 credentials. */
export async function generateNewUser(
  adminUmk: Uint8Array,
  adminR2Config: R2Config,
  input: NewUserInput,
): Promise<GeneratedNewUser> {
  const username = randomAlphanumeric(GENERATED_CREDENTIAL_LENGTH);
  const password = randomAlphanumeric(GENERATED_CREDENTIAL_LENGTH);
  const usernameLookupKey = randomBytes(c.USERNAME_LOOKUP_KEY_MIN_LEN);
  const userRootKey = randomBytes(c.USER_ROOT_KEY_MIN_LEN);
  const usernameHash = await hmacSha3_256(usernameLookupKey, new TextEncoder().encode(username));
  const pwSalt = randomBytes(c.PW_SALT_LEN);
  const pwHash = await pbkdf2Sha3_256(new TextEncoder().encode(password), pwSalt, c.PBKDF2_ITERATIONS, c.PW_HASH_LEN);

  const umk = randomBytes(c.UMK_LEN);
  const umkBlob = await blob.encrypt(userRootKey, umk);

  const { pk, sk } = await kem.keypair();
  const privKeyBlob = await blob.encrypt(umk, sk);

  const r2ConfigJson = JSON.stringify({
    endpoint: adminR2Config.endpoint,
    region: adminR2Config.region,
    bucket: adminR2Config.bucket,
    read_only_access_key_id: adminR2Config.readOnlyAccessKeyId,
    read_only_secret_access_key: adminR2Config.readOnlySecretAccessKey,
  });
  const r2ConfigBlob = await blob.encrypt(umk, new TextEncoder().encode(r2ConfigJson), { compressed: true });

  const txtMetadataKey = randomBytes(c.TXT_METADATA_KEY_LEN);
  const txtMetadataKeyBlob = await blob.encrypt(umk, txtMetadataKey);

  const txtAccessKey = randomBytes(c.TXT_ACCESS_KEY_LEN);
  const txtAccessKeyBlob = await blob.encrypt(umk, txtAccessKey);
  const txtAccessEmptyBlob = await blob.encrypt(txtAccessKey, new TextEncoder().encode("{}"), { compressed: true });

  const bookmarkKey = randomBytes(c.BOOKMARK_KEY_LEN);
  const bookmarkKeyBlob = await blob.encrypt(umk, bookmarkKey);
  const bookmarkEmptyBlob = await blob.encrypt(bookmarkKey, new TextEncoder().encode("{}"), { compressed: true });

  const downloadable: DownloadableUserCreds = {
    turso_database_url: input.tursoDatabaseUrl,
    turso_auth_token: input.userTursoAuthToken,
    username,
    username_lookup_key: bytesToBase64(usernameLookupKey),
    password,
    display_name: input.displayName,
    user_root_key: bytesToBase64(userRootKey),
  };
  const credsBlob = await blob.encrypt(adminUmk, new TextEncoder().encode(JSON.stringify(downloadable)), {
    compressed: true,
  });

  return {
    downloadable,
    usernameHash,
    pwSalt,
    pwHash,
    umkBlob,
    pubKey: pk,
    privKeyBlob,
    r2ConfigBlob,
    txtMetadataKeyBlob,
    txtAccessKeyBlob,
    txtAccessEmptyBlob,
    bookmarkKeyBlob,
    bookmarkEmptyBlob,
    credsBlob,
  };
}

/** Updates the admin-supplied fields of an already-`generateNewUser`d bundle
 * (Turso database URL, display name, the embedded regular-user Turso token)
 * -- e.g. to fix a typo before persisting -- without regenerating anything
 * else: username/password/username_lookup_key/user_root_key and every
 * wrapped blob that doesn't depend on these three fields (umkBlob,
 * privKeyBlob, r2ConfigBlob, txtMetadataKeyBlob, txtAccessKeyBlob/
 * EmptyBlob, bookmarkKeyBlob/EmptyBlob) all stay exactly as first
 * generated, so a later persistNewUser still writes the same account.
 * Only `downloadable` and `credsBlob` (which embeds `downloadable`'s own
 * JSON, wrapped under the admin's umk) actually change here. */
export async function updateGeneratedNewUser(
  adminUmk: Uint8Array,
  generated: GeneratedNewUser,
  edits: NewUserInput,
): Promise<GeneratedNewUser> {
  const downloadable: DownloadableUserCreds = {
    ...generated.downloadable,
    turso_database_url: edits.tursoDatabaseUrl,
    turso_auth_token: edits.userTursoAuthToken,
    display_name: edits.displayName,
  };
  const credsBlob = await blob.encrypt(adminUmk, new TextEncoder().encode(JSON.stringify(downloadable)), {
    compressed: true,
  });
  return { ...generated, downloadable, credsBlob };
}

/** Writes a `generateNewUser` result: users/umk_store/key_store/r2_config/
 * txt_metadata/txt_access/bookmarks rows, then the credential JSON into
 * that new row's own users.creds -- the only step in account creation that
 * ever touches the database (see generateNewUser's own doc comment for
 * why that split exists). Pure writes, no crypto work of its own, so
 * `onProgress` (if given) is called just twice: once before the run of
 * INSERTs that establish the account, once before the final UPDATE that
 * makes it possible for listUsersWithInfo to recover its display name
 * later. */
export async function persistNewUser(
  db: Client,
  generated: GeneratedNewUser,
  onProgress?: (label: string) => void,
): Promise<void> {
  onProgress?.("Creating account…");
  const insertUser = await db.execute({
    sql: "INSERT INTO users (username_hash, pw_salt, pw_hash) VALUES (?, ?, ?)",
    args: [generated.usernameHash, generated.pwSalt, generated.pwHash],
  });
  const userId = Number(insertUser.lastInsertRowid);

  await db.execute({
    sql: "INSERT INTO umk_store (user_id, umk) VALUES (?, ?)",
    args: [userId, generated.umkBlob],
  });
  await db.execute({
    sql: "INSERT INTO key_store (user_id, pub_key, priv_key) VALUES (?, ?, ?)",
    args: [userId, generated.pubKey, generated.privKeyBlob],
  });
  await db.execute({
    sql: "INSERT INTO r2_config (user_id, config) VALUES (?, ?)",
    args: [userId, generated.r2ConfigBlob],
  });
  await db.execute({
    sql: "INSERT INTO txt_metadata (user_id, txt_metadata_key, content) VALUES (?, ?, NULL)",
    args: [userId, generated.txtMetadataKeyBlob],
  });
  await db.execute({
    sql: "INSERT INTO txt_access (user_id, txt_access_key, access) VALUES (?, ?, ?)",
    args: [userId, generated.txtAccessKeyBlob, generated.txtAccessEmptyBlob],
  });
  await db.execute({
    sql: "INSERT INTO bookmarks (user_id, bookmark_key, bookmark) VALUES (?, ?, ?)",
    args: [userId, generated.bookmarkKeyBlob, generated.bookmarkEmptyBlob],
  });

  onProgress?.("Saving credentials…");
  await db.execute({
    sql: "UPDATE users SET creds = ? WHERE id = ?",
    args: [generated.credsBlob, userId],
  });
}

export interface UserSummary {
  id: number;
  /** Recovered from users.creds (see file comment) -- undefined for the
   * admin's own row (creds is always NULL there) and for any row whose
   * creds can't be decrypted/parsed (e.g. one created before this existed). */
  displayName?: string;
}

/** Every account's id and recovered display name (if any) -- one query
 * regardless of how many accounts exist, rather than a query per account.
 * No longer carries a book count: that used to be a second query
 * (`COUNT(*) ... GROUP BY user_id` over the whole `txt` table) whose
 * row-read cost scaled with the total number of documents in the entire
 * database, not with the number of accounts being listed -- dropped along
 * with the UserRow.tsx display it was only ever for. */
export async function listUsersWithInfo(db: Client, adminUmk: Uint8Array): Promise<UserSummary[]> {
  const usersResult = await db.execute({ sql: "SELECT id, creds FROM users ORDER BY id ASC", args: [] });

  return Promise.all(
    usersResult.rows.map(async (row): Promise<UserSummary> => {
      const id = Number(row.id);
      let displayName: string | undefined;
      if (row.creds !== null) {
        try {
          const decrypted = await blob.decrypt(adminUmk, requireBlobBytes(row.creds, "users.creds"), true);
          const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as { display_name?: string };
          displayName = parsed.display_name;
        } catch {
          // Leave displayName undefined -- shows just the id, same as
          // before this info existed (e.g. a row created before creds was
          // populated, or wrapped under a since-rotated admin umk).
        }
      }
      return { id, displayName };
    }),
  );
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
