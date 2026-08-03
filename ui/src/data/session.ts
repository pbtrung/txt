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
  dbMetaId: string;
  currentVersion: number;
  pageCount: number;
  pageSize: number;
  pathKey: Uint8Array;
  dbKey: Uint8Array;
  r2Config: R2Config;
}

// InstaQL wraps every linked sub-entity as an array regardless of that
// link's own cardinality -- $users.dbMeta is a "has: one" reverse link, but
// still comes back as `dbMeta: [...]`, not a plain object. Getting this
// wrong here silently produces `undefined` fields that only surface much
// later (see the instantdb-instaql-array-links lesson: a 0-byte "reopened"
// database with no error until the first real query against it).
function firstLinked(rows: any, what: string): any {
  const row = rows?.[0];
  if (!row) throw new SessionError(`missing linked ${what}`);
  return row;
}

/** Queries this account's $users/dbMeta/credStore rows (client SDK, subject
 * to instant.perms.ts's rules -- isAdmin || isOwner, same as everywhere
 * else) and unwraps user_root_key -> umk -> credStore.content ->
 * {r2_config, path_key, db_key}, per docs/data_model.md's Key Hierarchy.
 * credStore's "own row" is the one where both owner and user link back to
 * this same auth.id (mirrors txt/collectGarbage.ts's resolveOwnCredStore) --
 * a single owner can hold other rows too (e.g. an admin's copy of another
 * account's user_root_key), which this query's own `"user.id": authId`
 * filter excludes. */
export async function resolveSession(
  db: any, // @instantdb/react database instance
  authId: string,
  userRootKey: Uint8Array,
): Promise<Session> {
  const result = await db.queryOnce({
    $users: { $: { where: { id: authId } }, dbMeta: {} },
    credStore: {
      $: { where: { "owner.id": authId, "user.id": authId } },
    },
  });
  const authRow = firstLinked(result.data.$users, "$users row");
  const dbMetaRow = firstLinked(authRow.dbMeta, "dbMeta row");

  if (!authRow.umk) {
    throw new SessionError(`$users row for auth.id=${authId} is missing umk`);
  }
  const credStoreRow = firstLinked(result.data.credStore, "credStore row");

  const umk = await blob.decrypt(userRootKey, base64ToBytes(authRow.umk));
  // compressed:true -- credStore.content is a structured (JSON) payload,
  // brotli-compressed before encryption same as every other JSON blob in
  // this hierarchy (txt/adminInit.ts's wrapCredStoreContent writes it with
  // blobEncrypt(..., true)); omitting this here decrypts fine (the AEAD tag
  // still checks out) but leaves raw brotli bytes where JSON text is
  // expected, failing JSON.parse with a confusing "not valid JSON" error
  // instead of ever surfacing as a decrypt-level problem.
  const contentJson = await blob.decrypt(
    umk,
    base64ToBytes(credStoreRow.content),
    true,
  );
  const content = requireObject(
    JSON.parse(new TextDecoder().decode(contentJson)),
    "credStore.content must decode to a JSON object",
    SessionError,
  );

  return {
    dbMetaId: dbMetaRow.id,
    currentVersion: dbMetaRow.currentVersion,
    pageCount: dbMetaRow.pageCount,
    pageSize: dbMetaRow.pageSize,
    pathKey: base64ToBytes(requireString(content, "path_key", SessionError)),
    dbKey: base64ToBytes(requireString(content, "db_key", SessionError)),
    r2Config: parseR2Config(content.r2_config),
  };
}
