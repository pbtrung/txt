import { id, tx } from "@instantdb/react";

import * as blob from "../crypto/blob";
import { base64ToBytes, bytesToBase64 } from "../crypto/bytes";
import { collectAllPages } from "./instaqlPagination";
import { kemEncapsulate } from "./leancrypto";

const PAGE_SIZE = 1000;

export class AdminSharesError extends Error {}

interface LinkedId {
  id: string;
}

interface KeyStoreRow {
  id: string;
  pubKey?: string;
}

interface ShareRow {
  id: string;
  txt?: LinkedId[];
  fromUser?: LinkedId[];
  toUser?: LinkedId[];
}

export interface ShareEntry {
  id: string;
  txtId: string;
  fromUserId: string;
  toUserId: string;
}

export interface AdminSharesSession {
  authId: string;
  docKeys: Map<string, Uint8Array>;
}

export async function listShares(db: any): Promise<ShareEntry[]> {
  const rows = await collectAllPages<ShareRow>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.queryOnce({
      txtShares: {
        $: {
          order: { shareKey: "asc" },
          limit: PAGE_SIZE,
          offset,
        },
        txt: {},
        fromUser: {},
        toUser: {},
      },
    });
    const page = result.data.txtShares ?? [];
    return {
      rows: page,
      hasNextPage: page.length === PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });

  return rows.flatMap((row) => {
    const txtId = row.txt?.[0]?.id;
    const fromUserId = row.fromUser?.[0]?.id;
    const toUserId = row.toUser?.[0]?.id;
    if (!txtId || !fromUserId || !toUserId) return [];
    return [{ id: row.id, txtId, fromUserId, toUserId }];
  });
}

async function recipientPubKey(db: any, userId: string): Promise<Uint8Array> {
  const result = await db.queryOnce({
    keyStore: {
      $: { where: { "owner.id": userId } },
    },
  });
  const row: KeyStoreRow | undefined = result.data.keyStore?.[0];
  if (!row?.pubKey) {
    throw new AdminSharesError(`no keyStore row for user ${userId}`);
  }
  return base64ToBytes(row.pubKey);
}

export async function grantShare(
  db: any,
  session: AdminSharesSession,
  txtId: string,
  toUserId: string,
): Promise<void> {
  if (toUserId === session.authId) {
    throw new AdminSharesError("an admin cannot grant a share to themselves");
  }
  const txtKey = session.docKeys.get(txtId);
  if (!txtKey) {
    throw new AdminSharesError(`missing document key for txt ${txtId}`);
  }

  const pubKey = await recipientPubKey(db, toUserId);
  const { ct, ss } = await kemEncapsulate(pubKey);
  const wrappedTxtKey = await blob.encrypt(ss, txtKey);
  const shareId = id();

  await db.transact([
    tx
      .txtShares![shareId]!.update({
        shareKey: `${txtId}:${session.authId}:${toUserId}`,
        kemCt: bytesToBase64(ct),
        txtKey: bytesToBase64(wrappedTxtKey),
      })
      .link({ txt: txtId, fromUser: session.authId, toUser: toUserId }),
  ]);
}

export async function revokeShare(db: any, shareId: string): Promise<void> {
  await db.transact([tx.txtShares![shareId]!.delete()]);
}
