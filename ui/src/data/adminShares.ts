// Sharing protocol (docs/protocols.md's Sharing protocol): creates an
// independent, admin-re-encrypted copy of a document -- sharedTxt/
// sharedTxtMetadata/sharedTxtParts, owned outright by the recipient -- under
// a fresh root key and R2 prefix, never a grant onto the admin's own txt/
// txtParts/txtMetadata rows. Runs entirely in the browser, both reading the
// source document's own parts and writing the recipient's re-encrypted copy
// through the same client, built from the admin's real, static read-write
// R2 credential (session.ts's adminR2WriteCreds) -- the one place this
// app's browser code talks to R2 directly rather than through a
// Worker-brokered temporary credential, since only the admin session ever
// retains that static credential.
import { id, tx } from "@instantdb/react";
import type { AwsClient } from "aws4fetch";

import * as blob from "../crypto/blob";
import { base64ToBytes, bytesToBase64, randomBytes } from "../crypto/bytes";
import { R2_BATCH_CONCURRENCY, RANDOM_KEY_LEN } from "../crypto/constants";
import { getUserCreds, type AdminUserSession } from "./adminUsers";
import {
  catalogFromMetadataContent,
  parseMetadataContent,
  wrapMetadataCatalog,
  wrapMetadataContent,
} from "./metadata";
import { collectAllPages } from "./instaqlPagination";
import { computePrefixHash } from "./prefixHash";
import { generateRandomToken, unwrapToken, wrapToken } from "./randomToken";
import { buildAdminWriteClient, getObject, putObject } from "./r2";
import type { AdminR2WriteCreds, R2Config } from "./r2Config";

const PAGE_SIZE = 1000;

export class AdminSharesError extends Error {}

interface LinkedId {
  id: string;
}

interface ShareRow {
  id: string;
  txt?: LinkedId[];
  fromUser?: LinkedId[];
  owner?: LinkedId[];
}

export interface ShareEntry {
  id: string;
  txtId: string;
  fromUserId: string;
  toUserId: string;
}

export interface AdminSharesSession extends AdminUserSession {
  instantToken: string;
  adminR2WriteCreds?: AdminR2WriteCreds;
  docKeys: Map<string, Uint8Array>;
}

interface TxtPartRow {
  id: string;
  partNum: number;
  txtPartKey: string;
  path: string;
}

interface SourceDocRow {
  prefix: string;
  txtMetadata?: { id: string; content: string }[];
  txtParts?: TxtPartRow[];
}

export async function listShares(db: any): Promise<ShareEntry[]> {
  const rows = await collectAllPages<ShareRow>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.queryOnce({
      sharedTxt: {
        $: {
          order: { shareKey: "asc" },
          limit: PAGE_SIZE,
          offset,
        },
        txt: {},
        fromUser: {},
        owner: {},
      },
    });
    const page = result.data.sharedTxt ?? [];
    return {
      rows: page,
      hasNextPage: page.length === PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });

  return rows.flatMap((row) => {
    const txtId = row.txt?.[0]?.id;
    const fromUserId = row.fromUser?.[0]?.id;
    const toUserId = row.owner?.[0]?.id;
    if (!txtId || !fromUserId || !toUserId) return [];
    return [{ id: row.id, txtId, fromUserId, toUserId }];
  });
}

async function queryRecipientUmk(db: any, userId: string): Promise<Uint8Array> {
  const result = await db.queryOnce({
    $users: { $: { where: { id: userId }, fields: ["umk"] } },
  });
  const row = result.data.$users?.[0];
  if (!row?.umk) {
    throw new AdminSharesError(`no $users row (with umk) for user ${userId}`);
  }
  return base64ToBytes(row.umk);
}

async function querySourceDoc(db: any, txtId: string): Promise<SourceDocRow> {
  const result = await db.queryOnce({
    txt: {
      $: { where: { id: txtId }, fields: ["prefix"] },
      txtMetadata: { $: { fields: ["content"] } },
      txtParts: {},
    },
  });
  const row = result.data.txt?.[0];
  if (!row) throw new AdminSharesError(`no txt row for txtId=${txtId}`);
  return row;
}

/** Decrypts one source part's ciphertext down to its already-brotli-
 * compressed bytes (compressed:false skips the internal decompress step
 * blob.decrypt would otherwise do) -- re-encrypting those same bytes under
 * a fresh key (again compressed:false) needs no brotli work at all, since
 * they're already exactly what the original --ingest/grantShare run
 * produced before its own AEAD wrap. */
async function reKeyPart(
  r2Client: AwsClient,
  r2Config: R2Config,
  prefix: string,
  row: TxtPartRow,
  sourceDocKey: Uint8Array,
): Promise<{
  partNum: number;
  txtPartKey: Uint8Array;
  compressed: Uint8Array;
}> {
  const txtPartKey = await blob.decrypt(
    sourceDocKey,
    base64ToBytes(row.txtPartKey),
  );
  const rawKey = await unwrapToken(txtPartKey, row.path);
  const body = await getObject(r2Client, r2Config, `${prefix}/${rawKey}`);
  const compressed = await blob.decrypt(txtPartKey, body, false);
  return { partNum: row.partNum, txtPartKey, compressed };
}

export async function grantShare(
  db: any,
  session: AdminSharesSession,
  txtId: string,
  toUserId: string,
  onProgress?: (label: string) => void,
): Promise<void> {
  if (toUserId === session.authId) {
    throw new AdminSharesError("an admin cannot grant a share to themselves");
  }
  const sourceDocKey = session.docKeys.get(txtId);
  if (!sourceDocKey) {
    throw new AdminSharesError(`missing document key for txt ${txtId}`);
  }
  if (!session.adminR2WriteCreds) {
    throw new AdminSharesError("this session has no admin R2 write credential");
  }

  onProgress?.("Looking up recipient");
  const [recipientUserRootKeyCreds, recipientUmkBlob] = await Promise.all([
    getUserCreds(db, session, toUserId),
    queryRecipientUmk(db, toUserId),
  ]);
  if (!recipientUserRootKeyCreds) {
    throw new AdminSharesError(
      `no admin-owned recovery credStore row for user ${toUserId}`,
    );
  }
  const recipientUmk = await blob.decrypt(
    base64ToBytes(recipientUserRootKeyCreds.userRootKey),
    recipientUmkBlob,
  );

  onProgress?.("Reading document");
  const sourceDoc = await querySourceDoc(db, txtId);
  const sourceMetadataRow = sourceDoc.txtMetadata?.[0];
  if (!sourceMetadataRow) {
    throw new AdminSharesError(`missing txtMetadata row for txt ${txtId}`);
  }
  const sourcePrefix = await unwrapToken(sourceDocKey, sourceDoc.prefix);
  const adminClient = buildAdminWriteClient(
    session.adminR2WriteCreds,
    session.r2Config.region,
  );
  const sourceParts = (sourceDoc.txtParts ?? [])
    .slice()
    .sort((a, b) => a.partNum - b.partNum);
  const reKeyedParts = await Promise.all(
    sourceParts.map((row) =>
      reKeyPart(adminClient, session.r2Config, sourcePrefix, row, sourceDocKey),
    ),
  );
  const sourceContent = await parseMetadataContent(
    sourceDocKey,
    sourceMetadataRow.content,
  );

  onProgress?.("Encrypting for recipient");
  const rootKey = randomBytes(RANDOM_KEY_LEN);
  const prefix = generateRandomToken();
  const [adminTxtKey, userTxtKey, prefixHash, wrappedPrefix, content, catalog] =
    await Promise.all([
      blob.encrypt(session.umk, rootKey),
      blob.encrypt(recipientUmk, rootKey),
      computePrefixHash(prefix),
      wrapToken(rootKey, prefix),
      wrapMetadataContent(rootKey, sourceContent),
      wrapMetadataCatalog(rootKey, catalogFromMetadataContent(sourceContent)),
    ]);

  const uploads = await Promise.all(
    reKeyedParts.map(async ({ partNum, compressed }) => {
      const txtPartKey = randomBytes(RANDOM_KEY_LEN);
      const rawKey = generateRandomToken();
      const [ciphertext, path, txtPartKeyBlob] = await Promise.all([
        blob.encrypt(txtPartKey, compressed),
        wrapToken(txtPartKey, rawKey),
        blob.encrypt(rootKey, txtPartKey).then(bytesToBase64),
      ]);
      return {
        partNum,
        rawPath: `${prefix}/${rawKey}`,
        ciphertext,
        path,
        txtPartKeyBlob,
      };
    }),
  );

  onProgress?.(`Uploading 0/${uploads.length}`);
  let uploaded = 0;
  for (let i = 0; i < uploads.length; i += R2_BATCH_CONCURRENCY) {
    const batch = uploads.slice(i, i + R2_BATCH_CONCURRENCY);
    await Promise.all(
      batch.map((u) =>
        putObject(adminClient, session.r2Config, u.rawPath, u.ciphertext),
      ),
    );
    uploaded += batch.length;
    onProgress?.(`Uploading ${uploaded}/${uploads.length}`);
  }

  onProgress?.("Saving");
  const sharedTxtId = id();
  const sharedTxtMetadataId = id();
  await db.transact([
    tx
      .sharedTxt![sharedTxtId]!.update({
        shareKey: `${txtId}:${session.authId}:${toUserId}`,
        adminTxtKey: bytesToBase64(adminTxtKey),
        userTxtKey: bytesToBase64(userTxtKey),
        prefix: wrappedPrefix,
        prefixHash,
      })
      .link({ txt: txtId, owner: toUserId, fromUser: session.authId }),
    tx
      .sharedTxtMetadata![sharedTxtMetadataId]!.update({ content, catalog })
      .link({ sharedTxt: sharedTxtId, owner: toUserId }),
    ...uploads.map(({ partNum, path, txtPartKeyBlob }) =>
      tx
        .sharedTxtParts![id()]!.update({
          partNum,
          txtPartKey: txtPartKeyBlob,
          path,
          partKey: `${sharedTxtId}:${partNum}`,
        })
        .link({ sharedTxt: sharedTxtId, owner: toUserId }),
    ),
  ]);
}

export async function revokeShare(db: any, shareId: string): Promise<void> {
  await db.transact([tx.sharedTxt![shareId]!.delete()]);
}
