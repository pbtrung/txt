// Admin Manage screen: granting/revoking shares of the admin's own txt.
// Scoped to the admin's own account only -- per the plan, only the admin
// ever holds/grants txt or shares at all (a regular user's UserCreds-shaped
// R2 config structurally can't ingest, since that needs read-write R2 keys
// UserCreds forbids), so there's no "reach into another user's txt" case to
// support. Create + Delete only (grant / revoke) -- a txt_shares row is just
// (txt_id, to_user_id) -> a wrapped key, no partial-update shape worth
// building.
//
// Granting doesn't need anything secret from the recipient: key_store.pub_key
// is stored raw/unencrypted (data_model.md notes it isn't sensitive), so
// wrapping this txt's own txt_key for them (crypto.md's Encapsulate, already
// ported as crypto/kem.ts's wrap()) needs only their public key, not their
// root key or umk.

import type { Client } from "@libsql/core/api";

import * as kem from "../crypto/kem";
import { requireBlobBytes } from "./db";

export class AdminSharesError extends Error {}

export interface ShareEntry {
  id: number;
  txtId: number;
  toUserId: number;
}

/** Every share grant on any of the admin's own txt (ownTxtIds). Empty
 * without querying at all if the admin has no txt yet, since an empty SQL
 * `IN ()` isn't valid. */
export async function listShares(db: Client, ownTxtIds: number[]): Promise<ShareEntry[]> {
  if (ownTxtIds.length === 0) return [];
  const placeholders = ownTxtIds.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT id, txt_id, to_user_id FROM txt_shares WHERE txt_id IN (${placeholders})`,
    args: ownTxtIds,
  });
  return result.rows.map((row) => ({
    id: Number(row.id),
    txtId: Number(row.txt_id),
    toUserId: Number(row.to_user_id),
  }));
}

/** Grants recipientUserId access to txtId, wrapping its already-unwrapped
 * txtKey (e.g. from VaultContext's getTxtKey) under their public key. */
export async function grantShare(
  db: Client,
  txtId: number,
  txtKey: Uint8Array,
  recipientUserId: number,
): Promise<void> {
  const result = await db.execute({ sql: "SELECT pub_key FROM key_store WHERE user_id = ?", args: [recipientUserId] });
  const row = result.rows[0];
  if (!row) {
    throw new AdminSharesError(`no key_store row for user_id=${recipientUserId}`);
  }
  const pubKey = requireBlobBytes(row.pub_key, "key_store.pub_key");
  const { saltKemCt, blob: wrappedTxtKey } = await kem.wrap(pubKey, txtKey);
  await db.execute({
    sql: "INSERT INTO txt_shares (txt_id, to_user_id, salt_kem_ct, txt_key) VALUES (?, ?, ?, ?)",
    args: [txtId, recipientUserId, saltKemCt, wrappedTxtKey],
  });
}

/** Revokes one existing share grant by its row id. */
export async function revokeShare(db: Client, shareId: number): Promise<void> {
  await db.execute({ sql: "DELETE FROM txt_shares WHERE id = ?", args: [shareId] });
}
