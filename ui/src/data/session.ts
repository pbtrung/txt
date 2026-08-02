// Resolves a signed-in Firebase/InstantDB identity down to this account's
// key hierarchy and page-store coordinates -- the browser-side mirror of
// txt/migrate.ts's resolveTarget/unwrapTargetKeys, using @instantdb/react's
// real client SDK (permission-rule-gated: db.queryOnce, not the admin SDK
// the CLI uses) instead of an admin token.

import * as blob from "../crypto/blob";
import { base64ToBytes } from "../crypto/bytes";
import { requireObject, requireString } from "./jsonObject";
import { parseR2Config, type R2Config } from "./r2Config";

export class SessionError extends Error {}

export interface Session {
  usersRowId: string;
  dbMetaId: string;
  currentVersion: number;
  pageCount: number;
  pageSize: number;
  pathKey: Uint8Array;
  dbKey: Uint8Array;
  r2Config: R2Config;
}

// InstaQL wraps every linked sub-entity as an array regardless of that
// link's own cardinality -- users.dbMeta is a "has: one" reverse link, but
// still comes back as `dbMeta: [...]`, not a plain object. Getting this
// wrong here silently produces `undefined` fields that only surface much
// later (see the instantdb-instaql-array-links lesson: a 0-byte "reopened"
// database with no error until the first real query against it).
function firstLinked(rows: any, what: string): any {
  const row = rows?.[0];
  if (!row) throw new SessionError(`missing linked ${what}`);
  return row;
}

/** Queries this account's users/dbMeta/$users rows (client SDK, subject to
 * instant.perms.ts's rules -- isAdmin || isSelf/isOwner, same as everywhere
 * else) and unwraps user_root_key -> umk -> creds -> {r2_config, path_key,
 * db_key}, per docs/data_model.md's Key Hierarchy. */
export async function resolveSession(
  db: any, // @instantdb/react database instance
  authId: string,
  userRootKey: Uint8Array,
): Promise<Session> {
  const result = await db.queryOnce({
    users: { $: { where: { "authUser.id": authId } }, dbMeta: {} },
    $users: { $: { where: { id: authId } } },
  });
  const usersRow = firstLinked(result.data.users, "users row");
  const dbMetaRow = firstLinked(usersRow.dbMeta, "dbMeta row");
  const authRow = firstLinked(result.data.$users, "$users row");

  if (!authRow.umk || !authRow.creds) {
    throw new SessionError(
      `$users row for auth.id=${authId} is missing umk/creds`,
    );
  }

  const umk = await blob.decrypt(userRootKey, base64ToBytes(authRow.umk));
  const credsJson = await blob.decrypt(umk, base64ToBytes(authRow.creds));
  const creds = requireObject(
    JSON.parse(new TextDecoder().decode(credsJson)),
    "$users.creds must decode to a JSON object",
    SessionError,
  );

  return {
    usersRowId: usersRow.id,
    dbMetaId: dbMetaRow.id,
    currentVersion: dbMetaRow.currentVersion,
    pageCount: dbMetaRow.pageCount,
    pageSize: dbMetaRow.pageSize,
    pathKey: base64ToBytes(requireString(creds, "path_key", SessionError)),
    dbKey: base64ToBytes(requireString(creds, "db_key", SessionError)),
    r2Config: parseR2Config(creds.r2_config),
  };
}
