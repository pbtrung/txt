// Resolves the account identified by creds.username and its keys. Mirrors
// txt/owner.py's TxtOwner -- the same handful of lookups to get from a
// credential file to an unwrapped umk/txt_key -- plus one step Python's
// admin-only CLI never needed: fetching and decrypting r2_config.config,
// since this UI's config file carries no R2 keys of its own (see creds.ts).

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { hmacSha3_256, pbkdf2Sha3_256 } from "../crypto/leancryptoLoader";
import { bytesEqual } from "../crypto/bytes";
import { PBKDF2_ITERATIONS, PW_HASH_LEN } from "../crypto/constants";
import { decryptJson } from "./decryptJson";
import { requireBlobBytes } from "./db";
import type { Creds } from "./creds";
import { parseR2Config, type R2Config } from "./r2Config";

export class OwnerError extends Error {}

export interface UserAuth {
  userId: number;
  /** Recomputes PBKDF2-HMAC-SHA3-256(password, pw_salt) and compares to the
   * stored pw_hash -- a UX sanity check, not the real access-control gate
   * (the Turso token already gates DB access, and pw_hash/pw_salt only ever
   * authenticate a login, see docs/data_model.md's Login flow -- neither
   * appears in the umk key hierarchy). False rather than a thrown error so
   * callers can show a friendly "wrong config" message. */
  passwordOk: boolean;
}

/** Resolves username -> user_id and checks the login password in one query
 * (id, pw_salt, pw_hash all come off the same users row looked up by
 * username_hash) instead of two round trips against the same row. Throws
 * only when the username itself doesn't resolve to any row; a resolved user
 * with the wrong password comes back as passwordOk: false, same as before. */
export async function resolveUserAndCheckPassword(db: Client, creds: Creds): Promise<UserAuth> {
  const usernameHash = await hmacSha3_256(creds.usernameLookupKey, new TextEncoder().encode(creds.username));
  const result = await db.execute({
    sql: "SELECT id, pw_salt, pw_hash FROM users WHERE username_hash = ?",
    args: [usernameHash],
  });
  const row = result.rows[0];
  if (!row) {
    throw new OwnerError(`no user found for username=${JSON.stringify(creds.username)}`);
  }
  const userId = Number(row.id);
  const pwSalt = requireBlobBytes(row.pw_salt, "users.pw_salt");
  const pwHash = requireBlobBytes(row.pw_hash, "users.pw_hash");
  const recomputed = await pbkdf2Sha3_256(
    new TextEncoder().encode(creds.password),
    pwSalt,
    PBKDF2_ITERATIONS,
    PW_HASH_LEN,
  );
  return { userId, passwordOk: bytesEqual(recomputed, pwHash) };
}

export async function unwrapUmk(db: Client, creds: Creds, userId: number): Promise<Uint8Array> {
  const result = await db.execute({ sql: "SELECT umk FROM umk_store WHERE user_id = ?", args: [userId] });
  const row = result.rows[0];
  if (!row) {
    throw new OwnerError(`no umk_store row for user_id=${userId}`);
  }
  return blob.decrypt(creds.userRootKey, requireBlobBytes(row.umk, "umk_store.umk"));
}

export async function fetchR2Config(db: Client, userId: number, umk: Uint8Array): Promise<R2Config> {
  const result = await db.execute({ sql: "SELECT config FROM r2_config WHERE user_id = ?", args: [userId] });
  const row = result.rows[0];
  if (!row) {
    throw new OwnerError(`no r2_config row for user_id=${userId}`);
  }
  return parseR2Config(await decryptJson(umk, requireBlobBytes(row.config, "r2_config.config")));
}

// Scoped by user_id, not just id: unlike every other unscoped-by-id lookup
// in this file, this one is reachable from a client-supplied route param
// (Reader's /read/:txtId) with no prior ownership check -- an
// unscoped query would let anyone distinguish "txt_id exists" from "does
// not" (via a decrypt failure vs. a not-found error) for *any* account's
// documents, an existence oracle Turso's lack of row-level security doesn't
// otherwise close. Scoping here means a foreign-but-existing txt_id and a
// genuinely nonexistent one both hit the exact same not-found branch.
export async function unwrapTxtKey(db: Client, txtId: number, userId: number, umk: Uint8Array): Promise<Uint8Array> {
  const result = await db.execute({
    sql: "SELECT txt_key FROM txt WHERE id = ? AND user_id = ?",
    args: [txtId, userId],
  });
  const row = result.rows[0];
  if (!row) {
    throw new OwnerError(`no txt row for txt_id=${txtId}`);
  }
  return blob.decrypt(umk, requireBlobBytes(row.txt_key, "txt.txt_key"));
}

/** Decrypts every part's path for a txt, in part_num order -- deliberately
 * every part at once, for deleteTxt (VaultContext.tsx), which genuinely
 * needs every part's path to delete each one's R2 object. The Reader itself
 * uses partRawPath below instead: it only ever shows one part at a time, so
 * fetching every part's path up front cost one row-read per part just to
 * open a book, regardless of how much of it actually gets read. */
export async function partRawPaths(db: Client, txtId: number, txtKey: Uint8Array): Promise<string[]> {
  const result = await db.execute({
    sql: "SELECT path FROM txt_parts WHERE txt_id = ? ORDER BY part_num ASC",
    args: [txtId],
  });
  const paths: string[] = [];
  for (const row of result.rows) {
    const decrypted = await blob.decrypt(txtKey, requireBlobBytes(row.path, "txt_parts.path"));
    paths.push(new TextDecoder("ascii").decode(decrypted));
  }
  return paths;
}

/** Decrypts a single part's path (1-based part_num) -- one row-read, not
 * one per part in the document. Returns null if no such part exists (the
 * caller is expected to only ever ask for a part_num within [1, partCount]). */
export async function partRawPath(
  db: Client,
  txtId: number,
  partNum: number,
  txtKey: Uint8Array,
): Promise<string | null> {
  const result = await db.execute({
    sql: "SELECT path FROM txt_parts WHERE txt_id = ? AND part_num = ?",
    args: [txtId, partNum],
  });
  const row = result.rows[0];
  if (!row) return null;
  const decrypted = await blob.decrypt(txtKey, requireBlobBytes(row.path, "txt_parts.path"));
  return new TextDecoder("ascii").decode(decrypted);
}

export async function partCount(db: Client, txtId: number): Promise<number> {
  const result = await db.execute({ sql: "SELECT count FROM part_count WHERE txt_id = ?", args: [txtId] });
  const row = result.rows[0];
  return row ? Number(row.count) : 0;
}
