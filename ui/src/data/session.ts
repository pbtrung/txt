// Resolves a signed-in Firebase/InstantDB identity down to this account's
// key hierarchy (docs/key_hierarchy.md) -- the browser-side mirror of
// txt/collectGarbage.ts's resolveAdmin/resolveOwnCredStore, using
// @instantdb/react's real client SDK (permission-rule-gated: db.queryOnce,
// not the admin SDK the CLI uses) instead of an admin token.
//
// No dbMeta/pathKey/dbKey here anymore -- this design has no per-account
// page store to resolve coordinates for at all (docs/data_model.md). What a
// session actually needs is: this account's umk (unwraps everything else),
// its keyStore.privKey (Decapsulates a txtShares grant -- the one thing a
// share recipient needs beyond umk), its own credStore's r2_config/
// display_name, and its txtAccess/txtBookmarks key + already-decoded content
// (both one row per account, holding every document's data as a single
// encrypted JSON blob -- see access.ts/bookmarks.ts).

import * as blob from "../crypto/blob";
import { base64ToBytes, randomBytes } from "../crypto/bytes";
import { RANDOM_KEY_LEN } from "../crypto/constants";
import { decodeAccessContent, type AccessMap } from "./access";
import { decodeBookmarksContent, type BookmarksMap } from "./bookmarks";
import { optionalString, requireObject } from "./jsonObject";
import { parseR2Config, type R2Config } from "./r2Config";

export class SessionError extends Error {}

export interface KeyedContent<T> {
  /** Existing row id, or null if this account has never written one yet --
   * txtAccess/txtBookmarks rows are created lazily, on first write (see
   * VaultContext.tsx), not eagerly here. */
  id: string | null;
  /** Unwrapped per-account key protecting this row's own content --
   * freshly generated (never yet persisted) when id is null. */
  key: Uint8Array;
  content: T;
}

export interface Session {
  authId: string;
  umk: Uint8Array;
  /** Unwrapped lc_kyber_1024_x448 composite private key -- Decapsulates a
   * txtShares grant's txtKey (docs/protocols.md's Sharing protocol); the one
   * KEM operation ui/ ever needs client-side. */
  keyStorePrivKey: Uint8Array;
  r2Config: R2Config;
  /** This account's own display_name, as stored in credStore.content --
   * sourced from creds.json's own display_name field at provisioning time
   * (docs/data_model.md), so this follows the account itself rather than
   * whichever unlock file happens to be used for a given sign-in. */
  displayName?: string;
  txtAccess: KeyedContent<AccessMap>;
  txtBookmarks: KeyedContent<BookmarksMap>;
}

// InstaQL wraps every linked sub-entity as an array regardless of that
// link's own cardinality -- $users.keyStore is a "has: one" reverse link,
// but still comes back as `keyStore: [...]`, not a plain object. Getting
// this wrong here silently produces `undefined` fields that only surface
// much later (see the instantdb-instaql-array-links lesson).
function firstLinked(rows: any, what: string): any {
  const row = rows?.[0];
  if (!row) throw new SessionError(`missing linked ${what}`);
  return row;
}

/** Resolves (row id, unwrapped key, decoded content) for a has:-one-per-
 * account row that may not exist yet (txtAccess/txtBookmarks: created
 * lazily, on first write) -- a fresh key is minted (never persisted here)
 * so the caller can still write a brand-new row using it. */
async function resolveKeyedContent<T>(
  umk: Uint8Array,
  rows: any,
  keyField: string,
  decode: (json: unknown) => T,
  empty: T,
): Promise<KeyedContent<T>> {
  const row = rows?.[0];
  if (!row)
    return { id: null, key: randomBytes(RANDOM_KEY_LEN), content: empty };
  const key = await blob.decrypt(umk, base64ToBytes(row[keyField]));
  const contentJson = await blob.decrypt(key, base64ToBytes(row.content), true);
  const content = decode(JSON.parse(new TextDecoder().decode(contentJson)));
  return { id: row.id, key, content };
}

/** Re-fetches just this account's own txtAccess/txtBookmarks rows and
 * re-decodes their content -- cheaper than a full resolveSession() (no
 * userRootKey needed, since umk is already known) for VaultContext.tsx's
 * refresh(), which only ever needs to pick up a change to these two rows
 * (e.g. a bookmark added from another tab/device) or a newly-shared/ingested
 * document, never a rotated umk/keyStore/credStore mid-session. */
export async function reloadKeyedMaps(
  db: any,
  authId: string,
  umk: Uint8Array,
): Promise<{
  txtAccess: KeyedContent<AccessMap>;
  txtBookmarks: KeyedContent<BookmarksMap>;
}> {
  const result = await db.queryOnce({
    $users: {
      $: { where: { id: authId } },
      txtAccess: {},
      txtBookmarks: {},
    },
  });
  const authRow = firstLinked(result.data.$users, "$users row");
  const [txtAccess, txtBookmarks] = await Promise.all([
    resolveKeyedContent(
      umk,
      authRow.txtAccess,
      "txtAccessKey",
      decodeAccessContent,
      {},
    ),
    resolveKeyedContent(
      umk,
      authRow.txtBookmarks,
      "txtBookmarkKey",
      decodeBookmarksContent,
      {},
    ),
  ]);
  return { txtAccess, txtBookmarks };
}

/** Queries this account's $users/keyStore/credStore/txtAccess/txtBookmarks
 * rows in one shot (client SDK, subject to instant.perms.ts's rules) and
 * unwraps user_root_key -> umk -> {keyStore.privKey, credStore.content,
 * txtAccess.content, txtBookmarks.content}, per docs/data_model.md's
 * Entities section and docs/key_hierarchy.md. */
export async function resolveSession(
  db: any, // @instantdb/react database instance
  authId: string,
  userRootKey: Uint8Array,
): Promise<Session> {
  const result = await db.queryOnce({
    $users: {
      $: { where: { id: authId } },
      keyStore: {},
      credStore: {},
      txtAccess: {},
      txtBookmarks: {},
    },
  });
  const authRow = firstLinked(result.data.$users, "$users row");
  if (!authRow.umk) {
    throw new SessionError(`$users row for auth.id=${authId} is missing umk`);
  }
  const umk = await blob.decrypt(userRootKey, base64ToBytes(authRow.umk));

  const keyStoreRow = firstLinked(authRow.keyStore, "keyStore row");
  const keyStoreKey = await blob.decrypt(
    umk,
    base64ToBytes(keyStoreRow.keyStoreKey),
  );
  const keyStorePrivKey = await blob.decrypt(
    keyStoreKey,
    base64ToBytes(keyStoreRow.privKey),
  );

  const credStoreRow = firstLinked(authRow.credStore, "credStore row");
  const credStoreKey = await blob.decrypt(
    umk,
    base64ToBytes(credStoreRow.credStoreKey),
  );
  // compressed:true -- credStore.content is a structured (JSON) payload,
  // brotli-compressed before encryption same as every other JSON blob in
  // this hierarchy; omitting this decrypts fine (the AEAD tag still checks
  // out) but leaves raw brotli bytes where JSON text is expected, failing
  // JSON.parse with a confusing "not valid JSON" error instead of ever
  // surfacing as a decrypt-level problem.
  const contentJson = await blob.decrypt(
    credStoreKey,
    base64ToBytes(credStoreRow.content),
    true,
  );
  const content = requireObject(
    JSON.parse(new TextDecoder().decode(contentJson)),
    "credStore.content must decode to a JSON object",
    SessionError,
  );

  const [txtAccess, txtBookmarks] = await Promise.all([
    resolveKeyedContent(
      umk,
      authRow.txtAccess,
      "txtAccessKey",
      decodeAccessContent,
      {},
    ),
    resolveKeyedContent(
      umk,
      authRow.txtBookmarks,
      "txtBookmarkKey",
      decodeBookmarksContent,
      {},
    ),
  ]);

  return {
    authId,
    umk,
    keyStorePrivKey,
    r2Config: parseR2Config(content.r2_config),
    displayName: optionalString(content, "display_name"),
    txtAccess,
    txtBookmarks,
  };
}
