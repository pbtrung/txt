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
import { requireBlobBytes } from "./db";
import type { Creds } from "./creds";
import { parseR2Config, type R2Config } from "./r2Config";

export class OwnerError extends Error {}

export async function resolveUserId(db: Client, creds: Creds): Promise<number> {
  const usernameHash = await hmacSha3_256(creds.usernameLookupKey, new TextEncoder().encode(creds.username));
  const result = await db.execute({
    sql: "SELECT id FROM users WHERE username_hash = ?",
    args: [usernameHash],
  });
  const row = result.rows[0];
  if (!row) {
    throw new OwnerError(`no user found for username=${JSON.stringify(creds.username)}`);
  }
  return Number(row.id);
}

/** Recomputes PBKDF2-HMAC-SHA3-256(password, pw_salt) and compares to the stored pw_hash.
 *
 * A UX sanity check, not the real access-control gate -- the Turso token
 * already gates DB access, and pw_hash/pw_salt only ever authenticate a
 * login (see docs/data_model.md's Login flow), never appear in the umk key
 * hierarchy. Returns false rather than throwing so callers can show a
 * friendly "wrong config" message.
 */
export async function checkPassword(db: Client, userId: number, password: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT pw_salt, pw_hash FROM users WHERE id = ?",
    args: [userId],
  });
  const row = result.rows[0];
  if (!row) return false;
  const pwSalt = requireBlobBytes(row.pw_salt, "users.pw_salt");
  const pwHash = requireBlobBytes(row.pw_hash, "users.pw_hash");
  const recomputed = await pbkdf2Sha3_256(new TextEncoder().encode(password), pwSalt, PBKDF2_ITERATIONS, PW_HASH_LEN);
  return bytesEqual(recomputed, pwHash);
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
  const decrypted = await blob.decrypt(umk, requireBlobBytes(row.config, "r2_config.config"), true);
  return parseR2Config(JSON.parse(new TextDecoder().decode(decrypted)));
}

export async function listTxtIds(db: Client, userId: number): Promise<number[]> {
  const result = await db.execute({ sql: "SELECT id FROM txt WHERE user_id = ?", args: [userId] });
  return result.rows.map((row) => Number(row.id));
}

export async function unwrapTxtKey(db: Client, txtId: number, umk: Uint8Array): Promise<Uint8Array> {
  const result = await db.execute({ sql: "SELECT txt_key FROM txt WHERE id = ?", args: [txtId] });
  const row = result.rows[0];
  if (!row) {
    throw new OwnerError(`no txt row for txt_id=${txtId}`);
  }
  return blob.decrypt(umk, requireBlobBytes(row.txt_key, "txt.txt_key"));
}

/** Decrypts every part's path for a txt, in part_num order. */
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

export async function partCount(db: Client, txtId: number): Promise<number> {
  const result = await db.execute({ sql: "SELECT count FROM part_count WHERE txt_id = ?", args: [txtId] });
  const row = result.rows[0];
  return row ? Number(row.count) : 0;
}
