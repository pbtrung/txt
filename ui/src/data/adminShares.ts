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
import type { AwsClient } from "aws4fetch";

import * as kem from "../crypto/kem";
import { resolveUserUmk } from "./adminUsers";
import { requireBlobBytes } from "./db";
import { removeTxtMetadataEntry, upsertTxtMetadataEntry, type TxtMetadataEntry } from "./metadata";
import type { R2Config } from "./r2Config";

export class AdminSharesError extends Error {}

export interface ShareEntry {
  id: number;
  txtId: number;
  toUserId: number;
}

/** Every share grant -- unfiltered, not scoped to a caller-supplied txt id
 * list: only the admin ever owns/shares txt at all (see file header), so
 * every txt_shares row already belongs to the admin's own txt by
 * construction. Filtering by `WHERE txt_id IN (...)` would just repeat
 * that same true-for-every-row condition back at the database, growing a
 * huge parameter list for nothing as the admin's library grows. */
export async function listShares(db: Client): Promise<ShareEntry[]> {
  const result = await db.execute({ sql: "SELECT id, txt_id, to_user_id FROM txt_shares", args: [] });
  return result.rows.map((row) => ({
    id: Number(row.id),
    txtId: Number(row.txt_id),
    toUserId: Number(row.to_user_id),
  }));
}

/** Every user_id a txt has been shared to -- used by VaultContext's
 * deleteTxt to best-effort scrub each recipient's own copied metadata entry
 * before the txt_shares rows themselves are deleted (adminTxt.ts's
 * deleteTxtRows). */
export async function shareRecipientIds(db: Client, txtId: number): Promise<number[]> {
  const result = await db.execute({ sql: "SELECT to_user_id FROM txt_shares WHERE txt_id = ?", args: [txtId] });
  return result.rows.map((row) => Number(row.to_user_id));
}

/** Grants recipientUserId access to txtId, wrapping its already-unwrapped
 * txtKey (e.g. from VaultContext's getTxtKey) under their public key --
 * and, so the recipient's own Library actually shows this txt, copies
 * `entry` (the admin's own txt_metadata entry for txtId) into the
 * recipient's own txt_metadata row too, via the admin's escrowed access to
 * that recipient's umk (adminUsers.ts's resolveUserUmk). That copy happens
 * *before* the txt_shares insert: a share that's "granted" but invisible in
 * the recipient's Library is a confusing half-feature, so failing to
 * recover the recipient's umk is a hard failure here (unlike revokeShare's
 * best-effort cleanup below) -- and doing it first means a failure never
 * leaves a dangling txt_shares row, with the whole call safely retryable
 * either way (upsertTxtMetadataEntry overwrites the same entry either
 * time). */
export async function grantShare(
  db: Client,
  txtId: number,
  txtKey: Uint8Array,
  recipientUserId: number,
  entry: TxtMetadataEntry,
  adminUmk: Uint8Array,
  r2Client: AwsClient,
  r2Config: R2Config,
): Promise<void> {
  const result = await db.execute({ sql: "SELECT pub_key FROM key_store WHERE user_id = ?", args: [recipientUserId] });
  const row = result.rows[0];
  if (!row) {
    throw new AdminSharesError(`no key_store row for user_id=${recipientUserId}`);
  }
  const pubKey = requireBlobBytes(row.pub_key, "key_store.pub_key");

  const recipientUmk = await resolveUserUmk(db, adminUmk, recipientUserId);
  if (!recipientUmk) {
    throw new AdminSharesError(`couldn't recover user_id=${recipientUserId}'s umk via their escrowed creds`);
  }
  await upsertTxtMetadataEntry(db, recipientUserId, recipientUmk, r2Client, r2Config, txtId, entry);

  const { saltKemCt, blob: wrappedTxtKey } = await kem.wrap(pubKey, txtKey);
  await db.execute({
    sql: "INSERT INTO txt_shares (txt_id, to_user_id, salt_kem_ct, txt_key) VALUES (?, ?, ?, ?)",
    args: [txtId, recipientUserId, saltKemCt, wrappedTxtKey],
  });
}

/** Revokes one existing share grant by its row id, and best-effort scrubs
 * the copy grantShare made in the recipient's own txt_metadata (so it stops
 * showing up in their Library) -- wrapped in try/catch, unlike grantShare's
 * hard failure on the same escrow step: revoking access is the actually
 * security-relevant action here and must not be blocked by a metadata
 * cleanup failure (e.g. the recipient's creds having since become
 * undecryptable). Leaves a stale metadata entry behind on failure, the same
 * class of harmless leftover already accepted elsewhere in this app (see
 * metadata.ts's persistMetadataContent). */
export async function revokeShare(
  db: Client,
  shareId: number,
  txtId: number,
  toUserId: number,
  adminUmk: Uint8Array,
  r2Client: AwsClient,
  r2Config: R2Config,
): Promise<void> {
  try {
    const recipientUmk = await resolveUserUmk(db, adminUmk, toUserId);
    if (recipientUmk) {
      await removeTxtMetadataEntry(db, toUserId, recipientUmk, r2Client, r2Config, txtId);
    }
  } catch {
    // Best-effort -- see doc comment above.
  }
  await db.execute({ sql: "DELETE FROM txt_shares WHERE id = ?", args: [shareId] });
}
